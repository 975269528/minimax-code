import { posix, win32 } from 'node:path';

export function isTuiAcpAbsolutePath(value: string): boolean {
  return posix.isAbsolute(value) || win32.isAbsolute(value);
}
