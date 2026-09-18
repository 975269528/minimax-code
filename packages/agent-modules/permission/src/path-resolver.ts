import path from 'node:path';

import type { PathValue, ShellFamily } from './permission-core.js';

export type PermissionPathResolutionContext = {
  workingDirectory?: string;
  homeDir?: string;
};

/**
 * Resolve a literal path without applying the host process platform to a
 * Windows-shaped value. This keeps permission candidate generation safe when
 * a POSIX daemon inspects a Windows shell command.
 */
export function resolvePermissionPath(
  raw: string,
  context: PermissionPathResolutionContext = {},
  shell: ShellFamily = 'unknown',
): PathValue {
  if (raw.includes('$') || raw.includes('`')) {
    return { raw, dynamic: true, resolution: 'environment' };
  }
  if (raw.includes('?') || raw.includes('*') || raw.includes('[')) {
    return { raw, dynamic: true, resolution: 'glob' };
  }

  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\');
  if (windowsAbsolute) {
    return {
      raw,
      resolved: path.win32.normalize(raw),
      dynamic: false,
      resolution: 'absolute',
    };
  }

  if (raw === '~' || raw.startsWith('~/')) {
    if (!context.homeDir) return { raw, dynamic: true, resolution: 'home' };
    return {
      raw,
      resolved: path.resolve(context.homeDir, raw === '~' ? '.' : raw.slice(2)),
      dynamic: false,
      resolution: 'home',
    };
  }

  if (path.isAbsolute(raw)) {
    return { raw, resolved: path.normalize(raw), dynamic: false, resolution: 'absolute' };
  }

  const windowsContext =
    shell === 'cmd' ||
    shell === 'powershell' ||
    /^[A-Za-z]:[\\/]/.test(context.workingDirectory ?? '');
  if (windowsContext && context.workingDirectory) {
    return {
      raw,
      resolved: path.win32.resolve(context.workingDirectory, raw),
      dynamic: false,
      resolution: 'relative',
    };
  }

  return {
    raw,
    ...(context.workingDirectory ? { resolved: path.resolve(context.workingDirectory, raw) } : {}),
    dynamic: false,
    resolution: 'relative',
  };
}
