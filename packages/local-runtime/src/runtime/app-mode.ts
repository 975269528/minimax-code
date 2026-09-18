export type LocalAppMode = 'coding' | 'work';

export const DEFAULT_LOCAL_APP_MODE: LocalAppMode = 'coding';

export function resolveLocalAppMode(value: unknown): LocalAppMode {
  return value === 'work' || value === 'coding' ? value : DEFAULT_LOCAL_APP_MODE;
}

export function canUseRunLocationForAppMode(appMode: LocalAppMode): boolean {
  return appMode === 'coding';
}
