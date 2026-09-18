import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Serialize a workspace-relative path consistently across operating systems. */
export function toPortableRelativePath(input: string): string {
  return input.replace(/\\/gu, '/');
}

export function resolvePath(input: string): string {
  let path = input.startsWith('~') ? join(homedir(), input.slice(1)) : input;
  // Convert MSYS-style paths (/c/Users/...) to Windows paths (C:\Users\...) on win32.
  // Git Bash translates Windows paths to this format, and models may include them in
  // tool results. Node's path.resolve() would otherwise produce C:\c\Users\....
  if (process.platform === 'win32') {
    const msysMatch = path.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (msysMatch) {
      const drive = (msysMatch[1] ?? '').toUpperCase();
      const rest = msysMatch[2]?.replace(/\//g, '\\') ?? '\\';
      path = `${drive}:${rest}`;
    }
  }
  return resolve(path);
}
