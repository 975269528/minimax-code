import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class ReviewTargetError extends Error {
  constructor(
    readonly status: 'invalid' | 'missing',
    message: string,
  ) {
    super(message);
  }
}

export async function readSafeGitBaseTextFile(
  workspace: string,
  sourcePath: string,
): Promise<{ lines: string[] }> {
  await validateWorkspaceRelativePath(workspace, sourcePath);
  try {
    const { stdout } = await execFileAsync('git', ['show', `HEAD:${sourcePath}`], {
      cwd: workspace,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (stdout.includes('\0')) {
      throw new ReviewTargetError('invalid', 'Binary review targets are not supported');
    }
    return { lines: splitTextLines(stdout) };
  } catch (error) {
    if (error instanceof ReviewTargetError) throw error;
    throw new ReviewTargetError('missing', 'Review target does not exist in HEAD');
  }
}

export async function readSafeWorkspaceTextFile(
  workspace: string,
  sourcePath: string,
): Promise<{ lines: string[] }> {
  const { workspaceReal, absolute } = await validateWorkspaceRelativePath(workspace, sourcePath);
  try {
    const stat = await lstat(absolute);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new ReviewTargetError('invalid', 'Review target is not a file');
    }
    const targetReal = await realpath(absolute);
    if (!isWithin(workspaceReal, targetReal)) {
      throw new ReviewTargetError('invalid', 'Review symlink target escapes the workspace');
    }
    const text = await readFile(targetReal, 'utf8');
    if (text.includes('\0')) {
      throw new ReviewTargetError('invalid', 'Binary review targets are not supported');
    }
    return { lines: splitTextLines(text) };
  } catch (error) {
    if (error instanceof ReviewTargetError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ReviewTargetError('missing', 'Review target no longer exists');
    }
    throw error;
  }
}

export async function validateWorkspaceRelativePath(
  workspace: string,
  sourcePath: string,
): Promise<{ workspaceReal: string; absolute: string }> {
  if (
    !sourcePath ||
    sourcePath.includes('\0') ||
    isAbsolute(sourcePath) ||
    sourcePath.split(/[\\/]/u).includes('..')
  ) {
    throw new ReviewTargetError('invalid', 'Review path must be workspace-relative');
  }
  const workspaceReal = await realpath(workspace);
  const absolute = resolve(workspaceReal, sourcePath);
  if (!isWithin(workspaceReal, absolute)) {
    throw new ReviewTargetError('invalid', 'Review path escapes the workspace');
  }
  return { workspaceReal, absolute };
}

function splitTextLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/u);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
