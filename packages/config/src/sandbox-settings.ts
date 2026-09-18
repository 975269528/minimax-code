/** Pure value model for sandbox settings, shared by config parsing and the renderer without Node.js dependencies. */
export type SandboxFilesystemModeName =
  | 'read_only'
  | 'workspace_write'
  | 'delete_guard'
  | 'full_access';

export interface SandboxSettingsSnapshot {
  enabled: boolean;
  filesystemMode: SandboxFilesystemModeName;
}

/** Default to full access with deletion protection off on every platform; retain the platform parameter for shared callers. */
export function getDefaultSandboxSettings(_platform: string): SandboxSettingsSnapshot {
  return { enabled: false, filesystemMode: 'full_access' };
}

/** Normalize the legacy disabled master switch and full access to no sandbox; retain other enabled levels. */
export function normalizeSandboxSettings(
  settings: SandboxSettingsSnapshot,
): SandboxSettingsSnapshot {
  return !settings.enabled || settings.filesystemMode === 'full_access'
    ? { enabled: false, filesystemMode: 'full_access' }
    : { ...settings };
}
