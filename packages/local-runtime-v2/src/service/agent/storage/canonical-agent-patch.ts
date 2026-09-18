import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import yaml from 'yaml';

import { replaceFileAtomically } from '../../../infra/file/jsonl.js';
import {
  AgentConfigError,
  parseCanonicalAgentMarkdown,
  readStableAgentMarkdown,
} from './canonical-agent-config.js';

const SYSTEM_PROMPT_FILE = 'agent.md';

/** Field-only changes preserve the remaining canonical definition. */
export interface CanonicalCustomAgentPatch {
  readonly systemPrompt?: string;
  readonly description?: string | null;
  readonly displayName?: string | null;
  readonly avatar?: string | null;
}

export type CanonicalCustomNameRewriteResult = {
  readonly rewritten: boolean;
  readonly errorCode?: AgentConfigError['code'];
  readonly reason?: 'missing' | 'invalid' | 'unreadable';
};

export function hasCanonicalPatch(patch: CanonicalCustomAgentPatch): boolean {
  return (
    Object.hasOwn(patch, 'systemPrompt') ||
    Object.hasOwn(patch, 'description') ||
    Object.hasOwn(patch, 'displayName') ||
    Object.hasOwn(patch, 'avatar')
  );
}

export function patchCanonicalMarkdown(
  raw: string,
  routeName: string,
  patch: CanonicalCustomAgentPatch,
  stagedAvatarReference: string | undefined,
): string {
  const split = splitCanonicalFrontmatterForPatch(raw);
  if (patch.systemPrompt !== undefined && Object.keys(patch).length === 1) {
    const header = raw.slice(0, raw.length - split.suffix.length);
    const rendered = `${header}${split.lineEnding}${patch.systemPrompt}`;
    parseCanonicalAgentMarkdown(rendered, routeName);
    return rendered;
  }
  let document: ReturnType<typeof yaml.parseDocument>;
  try {
    document = yaml.parseDocument(split.frontmatter, {
      prettyErrors: false,
      uniqueKeys: true,
    });
  } catch {
    throw invalidCanonicalPatch('frontmatter', 'Agent frontmatter is not valid YAML.');
  }
  if (document.errors.length > 0) {
    throw invalidCanonicalPatch('frontmatter', 'Agent frontmatter is not valid YAML.');
  }
  applyCanonicalPatchFields(document, patch, stagedAvatarReference);
  let frontmatter: string;
  try {
    frontmatter = document.toString().trimEnd();
  } catch {
    throw invalidCanonicalPatch('frontmatter', 'Agent frontmatter cannot be written.');
  }
  const rendered = [
    `---${split.lineEnding}`,
    frontmatter,
    `${split.lineEnding}---${split.closingLineEnding}`,
    patch.systemPrompt === undefined ? split.suffix : `${split.lineEnding}${patch.systemPrompt}`,
  ].join('');
  parseCanonicalAgentMarkdown(rendered, routeName);
  return rendered;
}

/** Rebinds a valid Custom document after its on-disk owner directory moves. */
function renameCanonicalAgentMarkdown(raw: string, from: string, to: string): string {
  const split = splitCanonicalFrontmatterForPatch(raw);
  // Validate the source before preserving and rewriting its editable bytes.
  const source = parseCanonicalAgentMarkdown(raw, from);
  if (source.diagnostics.some((diagnostic) => diagnostic.code === 'agent_name_mismatch')) {
    throw invalidCanonicalPatch('name', 'Agent name does not match its directory.');
  }
  let document: ReturnType<typeof yaml.parseDocument>;
  try {
    document = yaml.parseDocument(split.frontmatter, { prettyErrors: false, uniqueKeys: true });
  } catch {
    throw invalidCanonicalPatch('frontmatter', 'Agent frontmatter is not valid YAML.');
  }
  if (document.errors.length > 0) {
    throw invalidCanonicalPatch('frontmatter', 'Agent frontmatter is not valid YAML.');
  }
  document.set('name', to);
  let frontmatter: string;
  try {
    frontmatter = document.toString().trimEnd();
  } catch {
    throw invalidCanonicalPatch('frontmatter', 'Agent frontmatter cannot be written.');
  }
  const rendered = [
    `---${split.lineEnding}`,
    frontmatter,
    `${split.lineEnding}---${split.closingLineEnding}`,
    split.suffix,
  ].join('');
  parseCanonicalAgentMarkdown(rendered, to);
  return rendered;
}

/**
 * Rewrites a valid canonical owner after the collision migrator moved its
 * directory. Known per-Agent config failures remain available for deferred
 * diagnostics; storage and unknown failures stay fail-closed.
 */
export async function rewriteMovedCanonicalCustomName(
  dataDir: string,
  from: string,
  to: string,
): Promise<CanonicalCustomNameRewriteResult> {
  const raw = await readMovedCanonicalName(dataDir, to);
  if (typeof raw !== 'string') return raw;
  if (canonicalNameAlreadyMatches(raw, to)) return { rewritten: false };
  const renamed = renameMovedCanonicalName(raw, from, to);
  if (typeof renamed !== 'string') return renamed;
  return writeMovedCanonicalName(dataDir, to, renamed);
}

async function readMovedCanonicalName(
  dataDir: string,
  name: string,
): Promise<string | CanonicalCustomNameRewriteResult> {
  try {
    return await readStableAgentMarkdown({
      agentDir: join(dataDir, 'agents', name),
      routeName: name,
      trustedRoot: dataDir,
    });
  } catch (error) {
    const failure = canonicalCustomNameReadFailure(error);
    if (failure) return failure;
    throw error;
  }
}

function canonicalNameAlreadyMatches(raw: string, name: string): boolean {
  try {
    return !parseCanonicalAgentMarkdown(raw, name).diagnostics.some(
      (diagnostic) => diagnostic.code === 'agent_name_mismatch',
    );
  } catch (error) {
    if (error instanceof AgentConfigError) return false;
    throw error;
  }
}

function renameMovedCanonicalName(
  raw: string,
  from: string,
  to: string,
): string | CanonicalCustomNameRewriteResult {
  try {
    return renameCanonicalAgentMarkdown(raw, from, to);
  } catch (error) {
    if (error instanceof AgentConfigError) {
      return { rewritten: false, errorCode: error.code, reason: 'invalid' };
    }
    throw error;
  }
}

async function writeMovedCanonicalName(
  dataDir: string,
  name: string,
  content: string,
): Promise<CanonicalCustomNameRewriteResult> {
  try {
    await replaceFileAtomically(
      join(dataDir, 'agents', name, SYSTEM_PROMPT_FILE),
      content,
      async (temporaryPath) => {
        parseCanonicalAgentMarkdown(await readFile(temporaryPath, 'utf8'), name);
      },
    );
    return { rewritten: true };
  } catch (error) {
    if (isPerAgentReadAccessError(error)) {
      return { rewritten: false, errorCode: 'AGENT_CONFIG_INVALID', reason: 'unreadable' };
    }
    throw error;
  }
}

export function isPerAgentReadAccessError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

function canonicalCustomNameReadFailure(
  error: unknown,
): CanonicalCustomNameRewriteResult | undefined {
  if (error instanceof AgentConfigError) {
    return {
      rewritten: false,
      errorCode: error.code,
      reason: error.code === 'AGENT_CONFIG_NOT_FOUND' ? 'missing' : 'invalid',
    };
  }
  if (isPerAgentReadAccessError(error)) {
    return { rewritten: false, errorCode: 'AGENT_CONFIG_INVALID', reason: 'unreadable' };
  }
  return undefined;
}

function applyCanonicalPatchFields(
  document: ReturnType<typeof yaml.parseDocument>,
  patch: CanonicalCustomAgentPatch,
  stagedAvatarReference: string | undefined,
): void {
  patchCanonicalDescription(document, patch);
  patchCanonicalDisplayName(document, patch);
  patchCanonicalAvatar(document, patch, stagedAvatarReference);
}

function patchCanonicalDescription(
  document: ReturnType<typeof yaml.parseDocument>,
  patch: CanonicalCustomAgentPatch,
): void {
  if (Object.hasOwn(patch, 'description')) {
    const description = patch.description?.trim();
    if (!description) {
      throw invalidCanonicalPatch('description', 'description cannot be blank.');
    }
    document.set('description', description);
  }
}

function patchCanonicalDisplayName(
  document: ReturnType<typeof yaml.parseDocument>,
  patch: CanonicalCustomAgentPatch,
): void {
  if (Object.hasOwn(patch, 'displayName')) {
    if (patch.displayName === null) {
      document.deleteIn(['x-mavis', 'displayName']);
    } else {
      const displayName = patch.displayName?.trim();
      if (!displayName) {
        throw invalidCanonicalPatch('x-mavis.displayName', 'displayName cannot be blank.');
      }
      document.setIn(['x-mavis', 'displayName'], displayName);
    }
  }
}

function patchCanonicalAvatar(
  document: ReturnType<typeof yaml.parseDocument>,
  patch: CanonicalCustomAgentPatch,
  stagedAvatarReference: string | undefined,
): void {
  if (Object.hasOwn(patch, 'avatar')) {
    const avatar = patch.avatar;
    if (avatar === null || avatar === undefined || avatar.trim().length === 0) {
      document.deleteIn(['x-mavis', 'avatar']);
    } else if (stagedAvatarReference) {
      document.setIn(['x-mavis', 'avatar'], stagedAvatarReference);
    }
  }
}

function splitCanonicalFrontmatterForPatch(raw: string): {
  readonly frontmatter: string;
  readonly suffix: string;
  readonly lineEnding: '\n' | '\r\n';
  readonly closingLineEnding: '' | '\n' | '\r\n';
} {
  const lineEnding = openingFrontmatterLineEnding(raw);
  if (!lineEnding) {
    throw invalidCanonicalPatch('frontmatter', 'Agent configuration requires YAML frontmatter.');
  }
  let cursor = 3 + lineEnding.length;
  while (cursor <= raw.length) {
    const lineEnd = raw.indexOf('\n', cursor);
    const end = lineEnd === -1 ? raw.length : lineEnd;
    const rawLine = raw.slice(cursor, end);
    const line = withoutCarriageReturn(rawLine);
    if (line === '---') {
      return {
        frontmatter: raw.slice(3 + lineEnding.length, cursor),
        suffix: lineEnd === -1 ? '' : raw.slice(lineEnd + 1),
        lineEnding,
        closingLineEnding: closingFrontmatterLineEnding(lineEnd, rawLine),
      };
    }
    if (lineEnd === -1) break;
    cursor = lineEnd + 1;
  }
  throw invalidCanonicalPatch(
    'frontmatter',
    'Agent configuration is missing the closing frontmatter marker.',
  );
}

function openingFrontmatterLineEnding(raw: string): '\n' | '\r\n' | undefined {
  if (raw.startsWith('---\r\n')) return '\r\n';
  if (raw.startsWith('---\n')) return '\n';
  return undefined;
}

function withoutCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function closingFrontmatterLineEnding(lineEnd: number, rawLine: string): '' | '\n' | '\r\n' {
  if (lineEnd === -1) return '';
  return rawLine.endsWith('\r') ? '\r\n' : '\n';
}

function invalidCanonicalPatch(field: string, message: string): AgentConfigError {
  return new AgentConfigError('AGENT_CONFIG_INVALID', field, message);
}
