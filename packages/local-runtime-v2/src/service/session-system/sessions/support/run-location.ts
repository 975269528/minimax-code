import { execFile as execFileCallback, type ExecFileException } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export type LocalRunLocationMode = 'current' | 'new-worktree' | 'existing-worktree';

export interface LocalRunLocationInput {
  readonly mode: LocalRunLocationMode;
  readonly worktreeDir?: string;
  readonly branch?: string;
  readonly newWorktreeBranch?: string;
  readonly newWorktreeBase?: string;
}

export interface ResolvedLocalRunLocation {
  readonly mode: LocalRunLocationMode;
  readonly resolvedDir: string;
  readonly resolvedBranch?: string;
  readonly parentRepoDir?: string;
  readonly createdAt: number;
}

export class LocalRunLocationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'LocalRunLocationError';
  }
}

export function readLocalRunLocationInput(value: unknown): LocalRunLocationInput | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const mode = Reflect.get(value, 'mode');
  if (mode !== 'current' && mode !== 'new-worktree' && mode !== 'existing-worktree') {
    throw new LocalRunLocationError(
      `Unknown runLocation.mode "${String(mode)}"`,
      'RUN_LOCATION_INVALID_MODE',
    );
  }
  return {
    mode,
    ...optionalField(value, 'worktreeDir'),
    ...optionalField(value, 'branch'),
    ...optionalField(value, 'newWorktreeBranch'),
    ...optionalField(value, 'newWorktreeBase'),
  };
}

export async function applyLocalRunLocation(
  input: LocalRunLocationInput,
  workspaceDir: string,
  nowMs: () => number,
): Promise<ResolvedLocalRunLocation> {
  const createdAt = nowMs();
  if (input.mode === 'current') {
    await checkoutOptionalBranch(input.branch, workspaceDir);
    return {
      mode: 'current',
      resolvedDir: workspaceDir,
      ...(input.branch ? { resolvedBranch: input.branch } : {}),
      createdAt,
    };
  }
  if (input.mode === 'new-worktree') {
    return createNewWorktree(input, workspaceDir, createdAt);
  }
  return resolveExistingWorktree(input, workspaceDir, createdAt);
}

async function createNewWorktree(
  input: LocalRunLocationInput,
  workspaceDir: string,
  createdAt: number,
): Promise<ResolvedLocalRunLocation> {
  const branch =
    input.newWorktreeBranch ?? input.branch ?? generateDefaultWorktreeBranch(createdAt);
  await assertSafeBranchName(branch, workspaceDir);
  if (input.newWorktreeBase) assertSafeBaseRef(input.newWorktreeBase);
  const worktreeParentDir = await resolveSafeWorktreeParent(workspaceDir);
  const targetDir = join(worktreeParentDir, branch.replaceAll('/', '-'));
  const args = ['worktree', 'add', '-b', branch, targetDir];
  if (input.newWorktreeBase) args.push(input.newWorktreeBase);
  const result = await git(args, workspaceDir);
  if (result.code !== 0) {
    throw new LocalRunLocationError(
      `git worktree add failed: ${result.stderr || result.stdout}`,
      'RUN_LOCATION_WORKTREE_ADD_FAILED',
    );
  }
  return {
    mode: 'new-worktree',
    resolvedDir: targetDir,
    resolvedBranch: branch,
    parentRepoDir: workspaceDir,
    createdAt,
  };
}

async function resolveExistingWorktree(
  input: LocalRunLocationInput,
  workspaceDir: string,
  createdAt: number,
): Promise<ResolvedLocalRunLocation> {
  if (!input.worktreeDir) {
    throw new LocalRunLocationError(
      'runLocation.mode="existing-worktree" requires `worktreeDir`',
      'RUN_LOCATION_WORKTREE_DIR_REQUIRED',
    );
  }
  if (!isAbsolute(input.worktreeDir)) {
    throw new LocalRunLocationError(
      `runLocation.worktreeDir must be an absolute path, got "${input.worktreeDir}"`,
      'RUN_LOCATION_WORKTREE_DIR_NOT_ABSOLUTE',
    );
  }
  if (!existsSync(input.worktreeDir)) {
    throw new LocalRunLocationError(
      `Worktree directory does not exist: ${input.worktreeDir}`,
      'RUN_LOCATION_WORKTREE_NOT_FOUND',
    );
  }
  await checkoutOptionalBranch(input.branch, input.worktreeDir);
  return {
    mode: 'existing-worktree',
    resolvedDir: input.worktreeDir,
    ...(input.branch ? { resolvedBranch: input.branch } : {}),
    parentRepoDir: workspaceDir,
    createdAt,
  };
}

async function checkoutOptionalBranch(branch: string | undefined, cwd: string): Promise<void> {
  if (!branch) return;
  await assertSafeBranchName(branch, cwd);
  const result = await git(['checkout', branch], cwd);
  if (result.code !== 0) {
    throw new LocalRunLocationError(
      `Failed to checkout branch "${branch}" in ${cwd}: ${result.stderr || result.stdout}`,
      'RUN_LOCATION_CHECKOUT_FAILED',
    );
  }
}

async function resolveSafeWorktreeParent(workspaceDir: string): Promise<string> {
  const workspaceReal = await realpath(workspaceDir);
  const parent = join(workspaceDir, '.worktrees');
  await mkdir(parent, { recursive: true });
  const parentReal = await realpath(parent);
  const pathFromParent = relative(resolve(workspaceReal), resolve(parentReal));
  if (pathFromParent.startsWith('..') || isAbsolute(pathFromParent)) {
    throw new LocalRunLocationError(
      `Refusing to create worktree outside workspace: ${parent}`,
      'RUN_LOCATION_WORKTREE_PARENT_ESCAPES',
    );
  }
  return parentReal;
}

function assertSafeBaseRef(baseRef: string): void {
  if (baseRef.startsWith('-') || baseRef.includes('\0')) {
    throw new LocalRunLocationError(
      `Invalid git base ref "${baseRef}"`,
      'RUN_LOCATION_INVALID_BASE',
    );
  }
}

async function assertSafeBranchName(branch: string, cwd: string): Promise<void> {
  if (branch.startsWith('-') || branch.startsWith('@') || branch.includes('\0')) {
    throw new LocalRunLocationError(
      `Invalid git branch name "${branch}"`,
      'RUN_LOCATION_INVALID_BRANCH',
    );
  }
  const result = await git(['check-ref-format', `refs/heads/${branch}`], cwd);
  if (result.code !== 0) {
    throw new LocalRunLocationError(
      `Invalid git branch name "${branch}": ${result.stderr || result.stdout}`,
      'RUN_LOCATION_INVALID_BRANCH',
    );
  }
}

async function git(
  args: readonly string[],
  cwd: string,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  try {
    const result = await execFile('git', args, { cwd, encoding: 'utf-8', env: gitEnv() });
    return { code: 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  } catch (error) {
    const failure = error as ExecFileException & {
      readonly stdout?: string | Buffer;
      readonly stderr?: string | Buffer;
    };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: bufferToString(failure.stdout),
      stderr: bufferToString(failure.stderr) || failure.message,
    };
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

function generateDefaultWorktreeBranch(nowMs: number): string {
  const date = new Date(nowMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  return `feat/auto-${stamp}-${randomBytes(4).toString('hex')}`;
}

function optionalField(value: object, key: string): Record<string, string> {
  const field = Reflect.get(value, key);
  return typeof field === 'string' && field.length > 0 ? { [key]: field } : {};
}

function bufferToString(value: string | Buffer | undefined): string {
  return Buffer.isBuffer(value) ? value.toString('utf-8') : String(value ?? '');
}
