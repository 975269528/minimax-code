import {
  isCanonicalSubagentRole,
  resolveCanonicalSubagentRole,
} from '@mavis/agent-tools/desktop/subagent-roles';
import type { ResolvedAgentCapabilities } from '@mavis/config';

import type {
  AgentProfileRequest,
  AgentCapabilityCeiling,
  AgentNameCompatCanonicalClass,
  AgentNameCompatErrorCode,
  AgentNameCompatMemberCountBucket,
  AgentNameResolutionSource,
} from '../contracts.js';

const PRIMARY_AGENT_NAME = 'mavis';
const LEGACY_PRIMARY_AGENT_NAME = 'main';

const NAME_COMPAT_ERROR_CODES = new Set<AgentNameCompatErrorCode>([
  'UNKNOWN_AGENT_NAME',
  'AGENT_NOT_FOUND',
  'AMBIGUOUS_AGENT_NAME',
  'BUILTIN_AGENT_NAME_CONFLICT',
  'CANONICAL_AGENT_NOT_AVAILABLE',
  'VALIDATION_ERROR',
  'PRIMARY_AGENT_IMMUTABLE',
  'PRIMARY_AGENT_IDENTITY_CONFLICT',
  'LEGACY_PRIMARY_WRITE_FORBIDDEN',
  'BUILTIN_AGENT_IMMUTABLE',
]);

export function inferNameResolutionSource(
  requestedName: string,
  canonicalName?: string,
): AgentNameResolutionSource {
  const requested = requestedName.trim();
  if (requested.toLowerCase().startsWith('agent:')) return 'explicit_agent';
  if (resolveCanonicalSubagentRole(requested)) return 'canonical_name';
  if (requested.toLowerCase() === PRIMARY_AGENT_NAME || requested.toLowerCase() === 'main') {
    return 'stable_name';
  }
  if (canonicalName && canonicalName !== requested) return 'display_name_compat';
  return 'stable_name';
}

export function toCanonicalClass(
  value: unknown,
  source: AgentNameResolutionSource,
  trustedBuiltin?: boolean,
): AgentNameCompatCanonicalClass {
  if (typeof value !== 'string') return 'other';
  const normalized = value.trim().toLowerCase();
  if (source === 'canonical_name') {
    return resolveCanonicalSubagentRole(normalized) ?? 'other';
  }
  if (source === 'stable_name' || source === 'display_name_compat') {
    return trustedBuiltin === true &&
      (normalized === PRIMARY_AGENT_NAME || normalized === LEGACY_PRIMARY_AGENT_NAME)
      ? 'mavis'
      : 'other';
  }
  return 'other';
}

export function toMemberCountBucket(
  value: number | undefined,
): AgentNameCompatMemberCountBucket | undefined {
  if (!Number.isFinite(value) || value === undefined || value < 1) return undefined;
  if (value === 1) return '1';
  if (value === 2) return '2';
  return '3+';
}

export function toTelemetryErrorCode(error: unknown): AgentNameCompatErrorCode | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || !code.trim()) return undefined;
  const normalized = code.trim() as AgentNameCompatErrorCode;
  return NAME_COMPAT_ERROR_CODES.has(normalized) ? normalized : 'other';
}

export function resolutionSourceFromError(error: unknown): AgentNameResolutionSource | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const source = (error as { resolutionSource?: unknown }).resolutionSource;
  return isNameResolutionSource(source) ? source : undefined;
}

function isNameResolutionSource(value: unknown): value is AgentNameResolutionSource {
  return (
    value === 'stable_name' ||
    value === 'display_name_compat' ||
    value === 'canonical_name' ||
    value === 'explicit_agent'
  );
}

export function withResolutionSource<T extends Error>(
  error: T,
  source: AgentNameResolutionSource,
): T {
  Object.defineProperty(error, 'resolutionSource', {
    configurable: true,
    enumerable: false,
    value: source,
  });
  return error;
}

export function stableTelemetryValue(value: unknown): string {
  try {
    return `${typeof value}:${String(value)}`;
  } catch {
    return typeof value;
  }
}

export function resolveLocale(): string {
  return (
    process.env.MAVIS_ELECTRON_LOCALE?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().locale ||
    process.env.LANG?.split('.')[0]?.replace('_', '-') ||
    'en'
  );
}

/**
 * A builtin SubAgent running as a task child answers to its parent task, not to
 * the user or to sibling Sessions, and it may not open further delegations. Its
 * static `agent.md` is deliberately left alone so the same Agent keeps Mavis on
 * a direct or root Session; the restriction belongs to the surface.
 *
 * SessionSend is a sub-command of the composite `mavis` Tool rather than a
 * top-level Tool, so hiding just that sub-command would leave the prompt and
 * the executable Tool disagreeing. Dropping the whole `mavis` capability keeps
 * prompt, Skill catalog and Tool catalog consistent. Custom Agents, including a
 * manual Agent holding a reserved name, are unaffected.
 */
export function applyBuiltinSubagentTaskChildCeiling(input: {
  readonly capabilities: ResolvedAgentCapabilities;
  readonly canonicalBuiltin: boolean;
  readonly canonicalViewName: string;
  readonly surface: NonNullable<AgentProfileRequest['surface']>;
}): ResolvedAgentCapabilities {
  const { capabilities } = input;
  if (
    input.surface !== 'task-child' ||
    !input.canonicalBuiltin ||
    !isCanonicalSubagentRole(input.canonicalViewName)
  ) {
    return capabilities;
  }
  if (!capabilities.features.mavis && !capabilities.features.delegation) return capabilities;
  return {
    ...capabilities,
    features: { ...capabilities.features, mavis: false, delegation: false },
  };
}

export function toCapabilityCeiling(
  capabilities: ResolvedAgentCapabilities,
): AgentCapabilityCeiling {
  return {
    personaEnabled: capabilities.persona.enabled,
    ...(capabilities.tools ? { tools: capabilities.tools } : {}),
    ...(capabilities.builtinTools ? { builtinTools: capabilities.builtinTools } : {}),
    ...(capabilities.skills ? { skills: capabilities.skills } : {}),
    features: capabilities.features,
  };
}
