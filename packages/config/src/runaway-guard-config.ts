/** Runtime policy; the extension itself never reads files or Apollo. */
export interface RunawayGuardSettings {
  readonly enabled: boolean;
}

export interface RunawayGuardOverride {
  readonly enabled?: boolean;
}

/** Missing/invalid remote values mean no override, not enabled=true. */
export function parseRunawayGuardOverride(raw: unknown): RunawayGuardOverride {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const enabled = (raw as Record<string, unknown>).enabled;
  return typeof enabled === 'boolean' ? { enabled } : {};
}

export function resolveRunawayGuardConfig(local: unknown, remote?: unknown): RunawayGuardSettings {
  return {
    enabled:
      parseRunawayGuardOverride(remote).enabled ?? parseRunawayGuardOverride(local).enabled ?? true,
  };
}
