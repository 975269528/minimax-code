import { execFile as execFileCallback, type ExecFileException } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { resolvePath } from './path-utils.js';

const execFile = promisify(execFileCallback);
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function git(args: string[], workspace: string): Promise<GitRunResult> {
  try {
    const result = await execFile('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: resolvePath(workspace),
      encoding: 'utf-8',
      env: gitEnv(),
      maxBuffer: GIT_MAX_BUFFER,
    });
    return { code: 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  } catch (error) {
    const err = error as ExecFileException & { stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: bufferToString(err.stdout),
      stderr: bufferToString(err.stderr) || err.message,
    };
  }
}

export async function gitRoot(workspace: string): Promise<string | undefined> {
  const result = await git(['rev-parse', '--show-toplevel'], workspace);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export async function gitCommonDir(workspace: string): Promise<string | undefined> {
  const result = await git(['rev-parse', '--git-common-dir'], workspace);
  if (result.code !== 0 || !result.stdout.trim()) return undefined;
  const commonDir = resolve(workspace, result.stdout.trim());
  return realpath(commonDir).catch(() => commonDir);
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function bufferToString(value: string | Buffer | undefined): string {
  return Buffer.isBuffer(value) ? value.toString('utf-8') : String(value ?? '');
}
