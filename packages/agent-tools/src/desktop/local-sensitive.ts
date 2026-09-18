import { realpath } from 'node:fs/promises';

import { minimatch } from 'minimatch';

import { LOCAL_SENSITIVE_GLOB_EXCLUDES } from '../shared/rg-sensitive.js';

export function sensitiveExcludeArgs(): string[] {
  return LOCAL_SENSITIVE_GLOB_EXCLUDES.map((pattern) => `--iglob=${pattern}`);
}

export function isSensitiveSearchPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '');
  return LOCAL_SENSITIVE_GLOB_EXCLUDES.some((exclude) => {
    const pattern = exclude.slice(1);
    const options = { dot: true, nocase: true };
    if (!pattern.includes('/')) {
      return normalized
        .split('/')
        .filter(Boolean)
        .some((segment) => minimatch(segment, pattern, options));
    }
    return (
      minimatch(normalized, pattern, options) ||
      minimatch(`${normalized}/__mavis_sensitive_root_probe__`, pattern, options)
    );
  });
}

export async function isSensitiveSearchRoot(path: string): Promise<boolean> {
  if (isSensitiveSearchPath(path)) return true;
  try {
    return isSensitiveSearchPath(await realpath(path));
  } catch {
    return false;
  }
}
