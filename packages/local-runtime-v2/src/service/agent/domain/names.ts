import { randomBytes } from 'node:crypto';
import {
  isTrustedBuiltinCreationSource,
  resolveCanonicalSubagentRole,
} from '@mavis/agent-tools/desktop/subagent-roles';

import { AgentServiceError } from '../errors.js';
import type {
  AgentCreateInput,
  AgentNameResolutionSource,
  AgentReadScope,
  AgentStoreAssetsUpdate,
  AgentStoreInsert,
  AgentStoreMeta,
  AgentUpdateInput,
} from '../contracts.js';

export const PRIMARY_AGENT_NAME = 'mavis';
export const LEGACY_PRIMARY_AGENT_NAME = 'main';

export function buildAgentReadScope(
  primaryAgentName: string,
  input: {
    readonly requestedName: string;
    readonly exactOwnerName: string;
    readonly canonicalName: string;
    readonly source: AgentNameResolutionSource;
    readonly exact: boolean;
    readonly compatibleNames: readonly string[];
    readonly ownerMeta: AgentStoreMeta | undefined;
  },
): AgentReadScope {
  return {
    requestedName: input.requestedName,
    canonicalName: input.canonicalName,
    primaryName: primaryAgentName,
    compatibleNames: input.compatibleNames,
    exact: input.exact,
    source: input.source,
    exactOwnerName: input.exactOwnerName,
    ...(input.ownerMeta
      ? { trustedBuiltin: isTrustedBuiltinCreationSource(input.ownerMeta.creationSource) }
      : {}),
  };
}

const MAX_AGENT_NAME_LENGTH = 64;
const STRICT_AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const WINDOWS_RESERVED_AGENT_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

function validateNewAgentName(name: string): string {
  const validated = validateLookupName(name);
  if (!STRICT_AGENT_NAME_PATTERN.test(validated)) {
    throw new AgentServiceError(
      'AGENT_NAME_INVALID',
      'Agent name must start with a lowercase letter and contain only lowercase letters, digits, hyphens, or underscores.',
    );
  }
  return validated;
}

export function resolveCreatedAgentName(name: string | undefined): string {
  return name === undefined || name.trim().length === 0
    ? `agent-${randomBytes(6).toString('hex')}`
    : validateNewAgentName(name);
}

export function validateCreateInput(input: AgentCreateInput, name: string): void {
  const displayName = input.initialDefinition?.mavis?.displayName ?? input.displayName;
  if (displayName !== undefined && (!displayName || displayName.trim() === '')) {
    throw new AgentServiceError('VALIDATION_ERROR', 'display_name cannot be empty');
  }
  if (isReservedName(name)) {
    throw new AgentServiceError(
      'AGENT_ROLE_CONFLICT',
      `Agent name "${name}" is reserved; use a collision-safe custom name.`,
    );
  }
}

export function validateUpdateInput(input: AgentUpdateInput): void {
  if (
    input.displayName !== undefined &&
    input.displayName !== null &&
    input.displayName.trim() === ''
  ) {
    throw new AgentServiceError('VALIDATION_ERROR', 'display_name cannot be empty');
  }
}

export function validateUpdateAgainstMeta(
  input: AgentUpdateInput,
  constraints: {
    readonly builtin: boolean;
    readonly primary: boolean;
    readonly primaryDisplayName: string | undefined;
  },
): void {
  if (constraints.builtin && (input.persona !== undefined || input.systemPrompt !== undefined)) {
    throw new AgentServiceError(
      'BUILTIN_AGENT_IMMUTABLE',
      'Built-in Agent templates are immutable.',
    );
  }
  if (
    constraints.primary &&
    input.displayName !== undefined &&
    constraints.primaryDisplayName !== undefined &&
    input.displayName !== constraints.primaryDisplayName
  ) {
    throw new AgentServiceError(
      'PRIMARY_AGENT_IMMUTABLE',
      'Primary Agent display name is immutable.',
    );
  }
}

export function toAgentInsert(
  input: AgentCreateInput,
  name: string,
  now: number,
): AgentStoreInsert {
  const initialDefinition = input.initialDefinition;
  return {
    name,
    agentRole: input.agentRole ?? 'worker',
    creationSource: 'manual',
    ...createRuntimeInsertFields(input, name),
    ...(initialDefinition === undefined
      ? legacyCreateInsertFields(input)
      : initialDefinitionInsertFields(input, initialDefinition)),
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function createRuntimeInsertFields(
  input: AgentCreateInput,
  name: string,
): Pick<AgentStoreInsert, 'rootSessionId' | 'defaultWorkspaceDir' | 'displayName'> {
  const mavis = input.initialDefinition?.mavis;
  const defaultWorkspaceDir = mavis?.defaultWorkspaceDir ?? input.defaultWorkspaceDir;
  return {
    ...(input.rootSessionId === undefined ? {} : { rootSessionId: input.rootSessionId }),
    ...(defaultWorkspaceDir === undefined ? {} : { defaultWorkspaceDir }),
    displayName: mavis?.displayName ?? input.displayName ?? name,
  };
}

function legacyCreateInsertFields(
  input: AgentCreateInput,
): Pick<AgentStoreInsert, 'description' | 'avatar' | 'persona' | 'systemPrompt'> {
  return {
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
    ...(input.persona === undefined ? {} : { persona: input.persona }),
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
  };
}

function initialDefinitionInsertFields(
  input: AgentCreateInput,
  initialDefinition: NonNullable<AgentCreateInput['initialDefinition']>,
): Pick<AgentStoreInsert, 'initialDefinition' | 'description' | 'avatar' | 'systemPrompt'> {
  const avatar = initialDefinition.mavis?.avatar ?? input.avatar;
  return {
    // Canonical publication filters this definition and writes `insert.name`
    // as the only durable owner name. Keep the presentation object separate so
    // request-only fields cannot choose another Agent directory.
    initialDefinition,
    description: initialDefinition.description,
    ...(avatar === undefined ? {} : { avatar }),
    systemPrompt: initialDefinition.systemPrompt,
  };
}

export function toAgentAssetsUpdate(
  input: AgentUpdateInput,
  name: string,
  now: number,
): AgentStoreAssetsUpdate {
  return {
    name,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
    ...(input.persona === undefined ? {} : { persona: input.persona }),
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
    ...(input.defaultWorkspaceDir === undefined
      ? {}
      : { defaultWorkspaceDir: input.defaultWorkspaceDir }),
    updatedAtMs: now,
  };
}

export function validateLookupName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new AgentServiceError('AGENT_NAME_REQUIRED', 'Agent name is required.');
  if (hasInvalidLookupNameShape(name, trimmed)) {
    throw new AgentServiceError('AGENT_NAME_INVALID', 'Agent name contains invalid characters.');
  }
  return trimmed;
}

function hasInvalidLookupNameShape(name: string, trimmed: string): boolean {
  return (
    trimmed !== name ||
    trimmed.length > MAX_AGENT_NAME_LENGTH ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.endsWith('.') ||
    WINDOWS_RESERVED_AGENT_NAMES.test(trimmed) ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  );
}

export function normalizeRequestRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed)
    throw new AgentServiceError('AGENT_REQUEST_REF_INVALID', 'Agent requestRef is required.');
  if (trimmed.toLowerCase().startsWith('agent:')) {
    return `agent:${validateLookupName(trimmed.slice('agent:'.length))}`;
  }
  return validateLookupName(trimmed);
}

export function isReservedName(name: string): boolean {
  return (
    name === PRIMARY_AGENT_NAME ||
    name === LEGACY_PRIMARY_AGENT_NAME ||
    resolveCanonicalSubagentRole(name) !== undefined
  );
}

export function notFound(name: string): AgentServiceError {
  return new AgentServiceError('AGENT_NOT_FOUND', `Agent not found: ${name}`);
}

export function parseExplicitName(requestRef: string): string | undefined {
  if (!requestRef.toLowerCase().startsWith('agent:')) return undefined;
  const exact = requestRef.slice('agent:'.length);
  if (!exact) throw new AgentServiceError('AGENT_NAME_REQUIRED', 'Agent name is required.');
  return validateLookupName(exact);
}

export function parseExplicitNameOrStable(requestRef: string): string {
  const normalized = requestRef.trim();
  const explicit = parseExplicitName(normalized);
  return explicit ?? validateLookupName(normalized);
}

export function canonicalAgentNotAvailableError(
  requestedName: string,
  replacement: string,
): AgentServiceError {
  return new AgentServiceError(
    'CANONICAL_AGENT_NOT_AVAILABLE',
    `Agent "${requestedName}" cannot execute because canonical Agent "${replacement}" is unavailable`,
    undefined,
    { requestedName, replacement },
  );
}

export function builtinNameConflictError(
  requestedName: string,
  canonicalName: string,
  candidate: AgentStoreMeta,
): AgentServiceError {
  return new AgentServiceError(
    'BUILTIN_AGENT_NAME_CONFLICT',
    `Canonical built-in Agent "${canonicalName}" is occupied by a non-builtin Agent`,
    undefined,
    {
      requestedName,
      canonicalName,
      candidate: candidate.name,
      candidates: [candidate.name],
      creationSource: candidate.creationSource,
    },
  );
}

export function resolveActivePrimaryName(
  metas: readonly AgentStoreMeta[],
  primaryAgentName: string,
): string {
  const find = (name: string, trustedOnly = false): string | undefined =>
    metas.find(
      (meta) =>
        meta.name === name && (!trustedOnly || isTrustedBuiltinCreationSource(meta.creationSource)),
    )?.name;
  return (
    find(primaryAgentName, true) ??
    find(LEGACY_PRIMARY_AGENT_NAME, true) ??
    find(primaryAgentName) ??
    find(LEGACY_PRIMARY_AGENT_NAME) ??
    primaryAgentName
  );
}

export function isHarnessAgent(meta: AgentStoreMeta): boolean {
  return Boolean(meta.sourceProject?.trim() || meta.harnessSourceType?.trim());
}

export function displayNameOrAgentName(displayName: string | undefined, agentName: string): string {
  return displayName?.trim() || agentName;
}

export function normalizeReservedDisplayName(displayName: string): string {
  return displayName.trim().toLowerCase();
}

export function sameDisplayName(left: string, right: string): boolean {
  return left.trim() === right.trim();
}
