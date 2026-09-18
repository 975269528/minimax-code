export const MINIMAX_CODE_PERMISSION_MODES = ['default', 'auto', 'bypassPermissions'] as const;

export type TuiPermissionMode = (typeof MINIMAX_CODE_PERMISSION_MODES)[number] | 'off';

const PERMISSION_MODE_LABELS: Record<TuiPermissionMode, string> = {
  default: 'Ask',
  auto: 'Auto',
  bypassPermissions: 'Full access',
  off: 'Off',
};

const PERMISSION_MODE_COMPACT_LABELS: Record<TuiPermissionMode, string> = {
  default: 'ASK',
  auto: 'AUTO',
  bypassPermissions: 'FULL',
  off: 'OFF',
};

export function normalizeTuiPermissionMode(value: unknown): TuiPermissionMode | undefined {
  return MINIMAX_CODE_PERMISSION_MODES.find((mode) => mode === value);
}

export function formatTuiPermissionMode(mode: TuiPermissionMode): string {
  return PERMISSION_MODE_LABELS[mode];
}

export function formatTuiPermissionModeCompact(mode: TuiPermissionMode): string {
  return PERMISSION_MODE_COMPACT_LABELS[mode];
}

export function isDangerousTuiPermissionMode(mode: TuiPermissionMode): boolean {
  return mode === 'bypassPermissions';
}

export function nextTuiPermissionMode(current: TuiPermissionMode): TuiPermissionMode {
  if (current === 'off') return 'default';
  const currentIndex = MINIMAX_CODE_PERMISSION_MODES.indexOf(current);
  return MINIMAX_CODE_PERMISSION_MODES[
    (currentIndex + 1) % MINIMAX_CODE_PERMISSION_MODES.length
  ] as TuiPermissionMode;
}
