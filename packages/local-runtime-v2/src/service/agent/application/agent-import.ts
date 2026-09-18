import { createHash } from 'node:crypto';

import { parse as parseToml } from 'smol-toml';
import yaml from 'yaml';

import { AgentServiceError } from '../errors.js';
import { resolveCreatedAgentName } from '../domain/names.js';
import type { AgentConfiguredDefinition } from '../contracts.js';
import {
  parseCanonicalAgentMarkdown,
  serializeCanonicalAgentConfig,
  type CanonicalAgentConfig,
} from '../storage/canonical-agent-config.js';
import { toConfiguredDefinition } from './config/config-document.js';

/** The only two external formats intentionally supported by the Desktop import API. */
export type AgentImportFormat = 'claude-code' | 'codex';

type AgentImportIssueCategory = 'exact' | 'semanticDifference' | 'lossy' | 'unsupportedSecurity';

interface AgentImportIssue {
  readonly issueId: string;
  readonly category: AgentImportIssueCategory;
  readonly fieldPath: string;
  readonly code: string;
  readonly acknowledgementRequired: boolean;
}

export interface AgentImportPreview {
  readonly format: AgentImportFormat;
  /** SHA-256 over exactly the client-supplied UTF-8 content. */
  readonly sourceDigest: string;
  readonly proposedName: string;
  readonly candidate: AgentConfiguredDefinition;
  /** Canonical Desktop `agent.md`, never a source-format echo. */
  readonly canonicalContent: string;
  readonly report: readonly AgentImportIssue[];
}

interface ParsedImport {
  readonly proposedName: string;
  readonly config: Omit<CanonicalAgentConfig, 'diagnostics'>;
  readonly report: readonly AgentImportIssue[];
}

const MAX_IMPORT_BYTES = 1024 * 1024;
const MAX_YAML_ALIASES = 32;
const MAX_IMPORT_DEPTH = 16;
const SECURITY_FIELD =
  /(?:permission|sandbox|hook|security|credential|secret|token|password|authorization)/iu;
const SOURCE_NAME_SEPARATOR = /[^a-z0-9]+/gu;
const INLINE_SECRET_LITERAL =
  /(?:\b(?:sk-[a-z0-9_-]{8,}|ghp_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{10,}|akia[0-9a-z]{16})\b|\bbearer\s+[a-z0-9._~+/=-]{12,}\b)/iu;
const INLINE_SECRET_ASSIGNMENT =
  /^\s*["']?[a-z0-9_.-]*(?:api[_-]?key|access[_-]?key|secret|token|password|credential|authorization)[a-z0-9_.-]*["']?\s*(?:=|:)\s*(?<value>[^#\n]+?)\s*(?:#.*)?$/imu;

/**
 * Stateless, content-only import normalization. This class intentionally has
 * no filesystem dependency: the renderer submits bytes from its explicitly
 * selected file and the Runtime never scans external tool directories.
 */
export class AgentImportService {
  preview(format: AgentImportFormat, content: string): AgentImportPreview {
    assertImportContent(content);
    assertNoInlineSecret(content);
    const parsed =
      format === 'claude-code' ? parseExternalMarkdownAgent(content) : parseCodex(content);
    const canonicalContent = serializeCanonicalAgentConfig({ config: parsed.config });
    const canonical = parseCanonicalAgentMarkdown(canonicalContent, parsed.proposedName);
    return {
      format,
      sourceDigest: sourceDigest(content),
      proposedName: parsed.proposedName,
      candidate: toConfiguredDefinition(canonical),
      canonicalContent,
      report: parsed.report,
    };
  }

  /** Re-parses instead of trusting a client-held preview DTO. */
  create(input: {
    readonly format: AgentImportFormat;
    readonly content: string;
    readonly expectedDigest: string;
    readonly targetName: string;
    readonly acceptedIssueIds?: readonly string[];
  }): AgentImportPreview {
    const preview = this.preview(input.format, input.content);
    if (input.expectedDigest !== preview.sourceDigest) {
      throw new AgentServiceError(
        'AGENT_IMPORT_DIGEST_MISMATCH',
        'Imported content changed after preview; preview it again before creating.',
      );
    }
    assertAcceptedIssues(preview.report, input.acceptedIssueIds ?? []);
    const targetName = validateTargetName(input.targetName);
    const config = parseCanonicalAgentMarkdown(preview.canonicalContent, preview.proposedName);
    const canonicalContent = serializeCanonicalAgentConfig({
      config: {
        ...withoutDiagnostics(config),
        name: targetName,
      },
    });
    const candidate = toConfiguredDefinition(
      parseCanonicalAgentMarkdown(canonicalContent, targetName),
    );
    return { ...preview, proposedName: targetName, candidate, canonicalContent };
  }
}

function parseExternalMarkdownAgent(content: string): ParsedImport {
  const { frontmatter, body } = splitMarkdownFrontmatter(content);
  const source = parseYamlMapping(frontmatter);
  const report: AgentImportIssue[] = [];
  const proposedName = sourceName(source.name, 'external-markdown-agent', report);
  const description = sourceDescription(source.description, 'external Markdown agent', report);
  const config: Omit<CanonicalAgentConfig, 'diagnostics'> = {
    name: proposedName,
    description,
    ...optionalString(source, 'model', 'model', report),
    ...optionalString(source, 'effort', 'effort', report),
    ...optionalStringArray(source, 'tools', 'tools', report),
    ...optionalStringArray(source, 'disallowedTools', 'disallowedTools', report),
    ...optionalStringArray(source, 'mcpServers', 'mcpServers', report),
    ...optionalStringArray(source, 'skills', 'skills', report),
    systemPrompt: body.trim(),
  };
  reportUnsupportedFields(
    source,
    new Set([
      'name',
      'description',
      'model',
      'effort',
      'tools',
      'disallowedTools',
      'mcpServers',
      'skills',
    ]),
    report,
  );
  return { proposedName, config, report: stableIssues(report) };
}

function parseCodex(content: string): ParsedImport {
  let decoded: unknown;
  try {
    decoded = parseToml(content);
  } catch {
    throw new AgentServiceError('AGENT_CONFIG_INVALID', 'Codex TOML is not valid.');
  }
  // smol-toml has no alias expansion, but deeply nested decoded tables can
  // still consume unbounded traversal work in our normalization helpers.
  assertValueDepth(decoded, 0);
  const source = asPlainObject(decoded);
  if (!source) throw new AgentServiceError('AGENT_CONFIG_INVALID', 'Codex TOML must be a table.');
  const report: AgentImportIssue[] = [];
  const proposedName = sourceName(source.name, 'codex', report);
  const description = sourceDescription(source.description, 'Codex', report);
  const config: Omit<CanonicalAgentConfig, 'diagnostics'> = {
    name: proposedName,
    description,
    ...optionalString(source, 'model', 'model', report),
    ...optionalMappedString(source, 'model_reasoning_effort', 'effort', report),
    ...codexMcpServers(source.mcp_servers, report),
    ...codexSkills(source.skills, report),
    systemPrompt: requiredOrEmptyString(source, 'developer_instructions', report),
  };
  reportUnsupportedFields(
    source,
    new Set([
      'name',
      'description',
      'developer_instructions',
      'model',
      'model_reasoning_effort',
      'mcp_servers',
      'skills',
    ]),
    report,
  );
  return { proposedName, config, report: stableIssues(report) };
}

function splitMarkdownFrontmatter(content: string): {
  readonly frontmatter: string;
  readonly body: string;
} {
  const normalized = content.startsWith('\uFEFF') ? content.slice(1) : content;
  // Do not accept `---foo`: external Markdown frontmatter opens with a delimiter line,
  // not an arbitrary YAML scalar that happens to share its prefix.
  if (!/^---\r?\n/u.test(normalized)) {
    throw new AgentServiceError(
      'AGENT_CONFIG_INVALID',
      'External Markdown import must begin with YAML frontmatter.',
    );
  }
  const end = /\r?\n---(?:\r?\n|$)/u.exec(normalized.slice(3));
  if (!end || end.index === undefined) {
    throw new AgentServiceError(
      'AGENT_CONFIG_INVALID',
      'External Markdown frontmatter is not terminated.',
    );
  }
  const endIndex = 3 + end.index;
  const bodyStart = endIndex + end[0].length;
  return {
    frontmatter: normalized.slice(3, endIndex).replace(/^\r?\n/u, ''),
    body: normalized.slice(bodyStart),
  };
}

function parseYamlMapping(frontmatter: string): Record<string, unknown> {
  let document: ReturnType<typeof yaml.parseDocument>;
  try {
    document = yaml.parseDocument(frontmatter, { prettyErrors: false, uniqueKeys: true });
  } catch {
    throw new AgentServiceError(
      'AGENT_CONFIG_INVALID',
      'External Markdown frontmatter is not valid YAML.',
    );
  }
  if (document.errors.length > 0) {
    throw new AgentServiceError(
      'AGENT_CONFIG_INVALID',
      'External Markdown frontmatter is not valid YAML.',
    );
  }
  let decoded: unknown;
  try {
    decoded = document.toJS({ maxAliasCount: MAX_YAML_ALIASES });
  } catch {
    throw new AgentServiceError(
      'AGENT_CONFIG_INVALID',
      'External Markdown frontmatter exceeds the YAML alias limit.',
    );
  }
  assertValueDepth(decoded, 0);
  const source = asPlainObject(decoded);
  if (!source) {
    throw new AgentServiceError(
      'AGENT_CONFIG_INVALID',
      'External Markdown frontmatter must be a mapping.',
    );
  }
  return source;
}

function sourceName(value: unknown, format: string, report: AgentImportIssue[]): string {
  if (typeof value === 'string' && value.trim()) {
    const normalized = normalizeImportedName(value, 'name', report);
    if (normalized !== value) {
      report.push(issue('semanticDifference', 'name', 'name_normalized'));
    }
    return normalized;
  }
  report.push(issue('lossy', 'name', 'name_defaulted'));
  return `imported-${format.replace(/[^a-z0-9]+/gu, '-')}`;
}

function normalizeImportedName(
  value: string,
  fieldPath: string,
  report: AgentImportIssue[],
): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(SOURCE_NAME_SEPARATOR, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64);
  if (!normalized || !/^[a-z][a-z0-9_-]*$/u.test(normalized)) {
    if (fieldPath === 'target_name') {
      throw new AgentServiceError(
        'AGENT_NAME_INVALID',
        'target_name must start with a lowercase letter and use only lowercase letters, digits, hyphens, or underscores.',
      );
    }
    report.push(issue('lossy', fieldPath, 'name_defaulted'));
    return 'imported-agent';
  }
  return normalized;
}

function sourceDescription(value: unknown, format: string, report: AgentImportIssue[]): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  report.push(issue('lossy', 'description', 'description_defaulted'));
  return `Imported from ${format}`;
}

function optionalString(
  source: Record<string, unknown>,
  sourceField: string,
  destinationField: string,
  report: AgentImportIssue[],
): Record<string, string> {
  const value = source[sourceField];
  if (value === undefined) return {};
  if (typeof value !== 'string' || !value.trim()) {
    report.push(issue('lossy', sourceField, 'invalid_string_omitted'));
    return {};
  }
  return { [destinationField]: value.trim() };
}

function optionalMappedString(
  source: Record<string, unknown>,
  sourceField: string,
  destinationField: string,
  report: AgentImportIssue[],
): Record<string, string> {
  const mapped = optionalString(source, sourceField, destinationField, report);
  if (Object.keys(mapped).length > 0) {
    report.push(issue('semanticDifference', sourceField, 'mapped'));
  }
  return mapped;
}

function requiredOrEmptyString(
  source: Record<string, unknown>,
  sourceField: string,
  report: AgentImportIssue[],
): string {
  const value = source[sourceField];
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    report.push(issue('lossy', sourceField, 'invalid_string_omitted'));
    return '';
  }
  return value.trim();
}

function validateTargetName(value: string): string {
  if (!value.trim()) {
    throw new AgentServiceError('AGENT_NAME_REQUIRED', 'target_name is required.');
  }
  return resolveCreatedAgentName(value);
}

function optionalStringArray(
  source: Record<string, unknown>,
  sourceField: string,
  destinationField: string,
  report: AgentImportIssue[],
): Record<string, readonly string[]> {
  const value = source[sourceField];
  if (value === undefined) return {};
  const values = stringArray(value);
  if (!values) {
    report.push(issue('lossy', sourceField, 'invalid_string_list_omitted'));
    return {};
  }
  return { [destinationField]: values };
}

function codexMcpServers(
  value: unknown,
  report: AgentImportIssue[],
): Record<string, readonly string[]> {
  if (value === undefined) return {};
  const list = stringArray(value);
  if (list) return { mcpServers: list };
  const table = asPlainObject(value);
  if (!table) {
    report.push(issue('lossy', 'mcp_servers', 'invalid_mcp_servers_omitted'));
    return {};
  }
  const names = Object.keys(table).filter((name) => name.trim());
  if (names.length > 0) {
    report.push(issue('lossy', 'mcp_servers', 'server_definitions_not_imported'));
    return { mcpServers: names };
  }
  return { mcpServers: [] };
}

function codexSkills(
  value: unknown,
  report: AgentImportIssue[],
): Record<string, readonly string[]> {
  if (value === undefined) return {};
  const table = asPlainObject(value);
  if (!table) {
    report.push(issue('lossy', 'skills', 'invalid_skills_omitted'));
    return {};
  }
  const config = stringArray(table.config);
  if (!config) {
    report.push(issue('lossy', 'skills.config', 'invalid_string_list_omitted'));
    return {};
  }
  return { skills: config };
}

function reportUnsupportedFields(
  source: Record<string, unknown>,
  supported: ReadonlySet<string>,
  report: AgentImportIssue[],
): void {
  for (const field of Object.keys(source).sort()) {
    if (supported.has(field)) continue;
    report.push(
      issue(
        SECURITY_FIELD.test(field) ? 'unsupportedSecurity' : 'lossy',
        field,
        SECURITY_FIELD.test(field) ? 'unsupported_security_field' : 'unsupported_field',
      ),
    );
  }
}

function assertImportContent(content: string): void {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_IMPORT_BYTES) {
    throw new AgentServiceError(
      'AGENT_CONFIG_INVALID',
      `Imported content must be a UTF-8 string of at most ${MAX_IMPORT_BYTES} bytes.`,
    );
  }
}

function assertNoInlineSecret(content: string): void {
  if (INLINE_SECRET_LITERAL.test(content)) {
    throw new AgentServiceError(
      'AGENT_IMPORT_SECRET_FORBIDDEN',
      'Imported content contains an inline secret and cannot be imported.',
    );
  }
  for (const match of content.matchAll(new RegExp(INLINE_SECRET_ASSIGNMENT.source, 'gimu'))) {
    const value = match.groups?.value?.trim().replace(/^['"]|['"]$/gu, '') ?? '';
    if (value && !isEnvironmentReference(value)) {
      throw new AgentServiceError(
        'AGENT_IMPORT_SECRET_FORBIDDEN',
        'Imported content contains an inline secret and cannot be imported.',
      );
    }
  }
}

function isEnvironmentReference(value: string): boolean {
  return /^(?:\$[A-Z_][A-Z0-9_]*|\$\{[A-Z_][A-Z0-9_]*\}|env\.[A-Z_][A-Z0-9_]*)$/u.test(value);
}

function assertAcceptedIssues(
  report: readonly AgentImportIssue[],
  acceptedIssueIds: readonly string[],
): void {
  const required = new Set(
    report
      .filter((candidate) => candidate.acknowledgementRequired)
      .map((candidate) => candidate.issueId),
  );
  const accepted = new Set(acceptedIssueIds);
  for (const issueId of accepted) {
    if (!required.has(issueId)) {
      throw new AgentServiceError(
        'VALIDATION_ERROR',
        'accepted_issue_ids may contain only current acknowledgement-required issues.',
      );
    }
  }
  const missing = [...required].filter((issueId) => !accepted.has(issueId));
  if (missing.length > 0) {
    throw new AgentServiceError(
      'AGENT_IMPORT_ISSUES_UNACCEPTED',
      'Imported configuration has compatibility issues that must be acknowledged.',
      undefined,
      { issueIds: missing },
    );
  }
}

function issue(
  category: AgentImportIssueCategory,
  fieldPath: string,
  code: string,
): AgentImportIssue {
  return {
    issueId: `import_${createHash('sha256')
      .update(`${category}\u0000${fieldPath}\u0000${code}`, 'utf8')
      .digest('hex')
      .slice(0, 20)}`,
    category,
    fieldPath,
    code,
    acknowledgementRequired: category !== 'exact',
  };
}

function stableIssues(report: readonly AgentImportIssue[]): readonly AgentImportIssue[] {
  const byId = new Map<string, AgentImportIssue>();
  for (const entry of report) byId.set(entry.issueId, entry);
  return [...byId.values()].sort(
    (left, right) =>
      left.fieldPath.localeCompare(right.fieldPath) ||
      left.code.localeCompare(right.code) ||
      left.issueId.localeCompare(right.issueId),
  );
}

function sourceDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    return undefined;
  }
  return value.map((entry) => (entry as string).trim());
}

function withoutDiagnostics(
  config: CanonicalAgentConfig,
): Omit<CanonicalAgentConfig, 'diagnostics'> {
  const { diagnostics, ...without } = config;
  void diagnostics;
  return without;
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return value as Record<string, unknown>;
}

function assertValueDepth(value: unknown, depth: number): void {
  if (depth > MAX_IMPORT_DEPTH) {
    throw new AgentServiceError(
      'AGENT_CONFIG_INVALID',
      'Imported configuration exceeds the supported depth.',
    );
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertValueDepth(entry, depth + 1);
  } else {
    const object = asPlainObject(value);
    if (object) {
      for (const entry of Object.values(object)) assertValueDepth(entry, depth + 1);
    }
  }
}
