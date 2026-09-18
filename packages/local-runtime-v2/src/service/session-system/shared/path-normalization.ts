import path from 'node:path';

export function normalizeAbsolutePath(value: string | undefined): string | undefined {
  const input = value?.trim();
  if (!input) return undefined;
  const flavor = pathFlavor(input);
  if (!flavor.isAbsolute(input)) return undefined;
  return trimTrailingSeparators(flavor.normalize(input));
}

export function pathFlavor(value: string): typeof path.posix | typeof path.win32 {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\') ? path.win32 : path.posix;
}

export function trimTrailingSeparators(value: string): string {
  if (value === '/' || /^[A-Za-z]:\\$/u.test(value)) return value;
  if (/^\\\\[^\\]+\\[^\\]+\\?$/u.test(value)) return value.replace(/\\$/u, '');
  return value.replace(/[\\/]+$/u, '');
}
