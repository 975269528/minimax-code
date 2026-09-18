export type AgentRole = string;

/** Canonicalize legacy numeric SQLite role values at the domain boundary. */
export function normalizeStoredAgentRole(value: unknown): AgentRole {
  if (value === 0 || value === '0') return 'worker';
  if (value === 1 || value === '1') return 'orchestrator';
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return 'worker';
}

/** Keep legacy numeric storage for canonical roles while preserving custom names. */
export function encodeAgentRoleForStorage(value: AgentRole): AgentRole | number {
  if (value === 'worker') return 0;
  if (value === 'orchestrator') return 1;
  return value;
}

export function roleObservationStatus(value: unknown): 'missing' | 'unsupported' | undefined {
  if (value === null || value === undefined) return 'missing';
  if (typeof value === 'string') return value.trim() ? undefined : 'missing';
  if (typeof value === 'number' && (value === 0 || value === 1)) return undefined;
  return 'unsupported';
}
