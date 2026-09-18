import { rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, posix, resolve } from 'node:path';

import type {
  GitChangeScope,
  GitChangesBase,
  GitChangesValue,
  GitFileChangeAction,
  GitMetadataValue,
  GitMutationResult,
} from '../contracts.js';
import { isGitRepo, parsePorcelainStatus } from './changes.js';
import { git, type GitRunResult } from './git-process.js';
import type { WorkspaceGitSnapshotManager } from '../snapshot/snapshot-manager.js';
import { isPathInside, resolveWorkspaceWritePath } from './workspace-path.js';

type SnapshotManager = WorkspaceGitSnapshotManager<
  GitChangesBase,
  GitChangesValue,
  GitMetadataValue
>;

export async function saveWorkspaceFile(
  manager: SnapshotManager,
  workspace: string,
  filePath: string,
  content: string,
): Promise<void> {
  await manager.runMutation(workspace, 'workspace', async () => {
    const absolute = await resolveWorkspaceWritePath(workspace, filePath);
    if (!absolute) throw new Error('Path traversal denied');
    await writeFile(absolute, content, 'utf8');
  });
}

export async function checkoutBranch(
  manager: SnapshotManager,
  workspace: string,
  branch: string,
): Promise<GitMutationResult> {
  const invalid = await validateGitBranch(workspace, branch);
  if (invalid) return { success: false, error: invalid };
  return runGitMutation(manager, workspace, ['checkout', branch]);
}

export async function createBranch(
  manager: SnapshotManager,
  workspace: string,
  branch: string,
): Promise<GitMutationResult> {
  const invalid = await validateGitBranch(workspace, branch);
  if (invalid) return { success: false, error: invalid };
  return runGitMutation(manager, workspace, ['checkout', '-b', branch]);
}

export async function commit(
  manager: SnapshotManager,
  workspace: string,
  message: string,
  includeUnstaged = true,
): Promise<GitMutationResult> {
  return manager.runMutation(workspace, 'repository', async () => {
    if (includeUnstaged) {
      const add = await git(['add', '--all'], workspace);
      if (add.code !== 0) return toMutationResult(add);
    }
    return toMutationResult(await git(['commit', '-m', message], workspace));
  });
}

export async function commitAndPush(
  manager: SnapshotManager,
  workspace: string,
  message: string,
  includeUnstaged = true,
): Promise<{
  success: boolean;
  commit: GitMutationResult;
  push?: GitMutationResult;
}> {
  return manager.runMutation(workspace, 'repository', async () => {
    if (includeUnstaged) {
      const add = await git(['add', '--all'], workspace);
      if (add.code !== 0) {
        const commitResult = toMutationResult(add);
        return { success: false, commit: commitResult };
      }
    }
    const commitResult = toMutationResult(await git(['commit', '-m', message], workspace));
    if (!commitResult.success) return { success: false, commit: commitResult };
    const pushResult = toMutationResult(await pushWorkspace(workspace));
    return { success: pushResult.success, commit: commitResult, push: pushResult };
  });
}

export async function push(
  manager: SnapshotManager,
  workspace: string,
): Promise<GitMutationResult> {
  return manager.runMutation(workspace, 'repository', async () =>
    toMutationResult(await pushWorkspace(workspace)),
  );
}

export async function applyFileChangeAction(
  manager: SnapshotManager,
  workspace: string,
  options: {
    action: GitFileChangeAction;
    paths: string[];
    scope?: GitChangeScope;
  },
): Promise<GitMutationResult> {
  const { action, paths, scope = 'all' } = options;
  if (!(await isGitRepo(workspace))) return { success: false, error: 'Not a git repository' };
  let normalizedPaths: string[];
  try {
    normalizedPaths = normalizeGitActionPaths(resolve(workspace), paths);
  } catch (error) {
    return { success: false, error: describeError(error) };
  }
  if (normalizedPaths.length === 0) return { success: false, error: 'No paths provided' };
  return manager.runMutation(workspace, 'repository', async () => {
    if (action === 'stage') {
      return toMutationResult(await git(['add', '--', ...normalizedPaths], workspace));
    }
    if (action === 'unstage') {
      return toMutationResult(
        await git(['restore', '--staged', '--', ...normalizedPaths], workspace),
      );
    }
    if (scope === 'staged') {
      return {
        success: false,
        error: 'Staged changes cannot be discarded directly. Unstage them first.',
      };
    }
    return discardGitPaths(workspace, normalizedPaths);
  });
}

async function runGitMutation(
  manager: SnapshotManager,
  workspace: string,
  args: string[],
): Promise<GitMutationResult> {
  return manager.runMutation(workspace, 'repository', async () =>
    toMutationResult(await git(args, workspace)),
  );
}

async function discardGitPaths(workspace: string, paths: string[]): Promise<GitMutationResult> {
  const status = await git(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths],
    workspace,
  );
  if (status.code !== 0) return toMutationResult(status);
  const untrackedPaths = parsePorcelainStatus(status.stdout).untrackedPaths;
  const trackedPaths = paths.filter((filePath) => !untrackedPaths.has(filePath));
  if (trackedPaths.length > 0) {
    const result = await git(['restore', '--worktree', '--', ...trackedPaths], workspace);
    if (result.code !== 0) return toMutationResult(result);
  }
  await Promise.all(
    Array.from(untrackedPaths, async (filePath) => {
      const absolutePath = resolve(workspace, ...filePath.split('/'));
      if (isPathInside(resolve(workspace), absolutePath)) {
        await rm(absolutePath, { recursive: true, force: true });
      }
    }),
  );
  return { success: true };
}

function normalizeGitActionPaths(workspaceRoot: string, paths: string[]): string[] {
  const normalizedPaths = new Set<string>();
  for (const filePath of paths) {
    const normalized = normalizeGitActionPath(filePath);
    const absolutePath = resolve(join(workspaceRoot, ...normalized.split('/')));
    if (!isPathInside(workspaceRoot, absolutePath)) {
      throw new Error(`Path is outside workspace: ${filePath}`);
    }
    normalizedPaths.add(normalized);
  }
  return Array.from(normalizedPaths);
}

function normalizeGitActionPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (
    !trimmed ||
    trimmed.includes('\0') ||
    isAbsolute(trimmed) ||
    /^[a-zA-Z]:[\\/]/u.test(trimmed)
  ) {
    throw new Error(`Invalid git path: ${filePath}`);
  }
  const normalized = posix.normalize(trimmed.replace(/\\/gu, '/'));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Invalid git path: ${filePath}`);
  }
  return normalized;
}

async function validateGitBranch(workspace: string, branch: string): Promise<string | undefined> {
  if (branch.startsWith('-') || branch.startsWith('@') || branch.includes('\0')) {
    return `Invalid git branch name: ${branch}`;
  }
  const check = await git(['check-ref-format', `refs/heads/${branch}`], workspace);
  return check.code === 0 ? undefined : `Invalid git branch name: ${check.stderr || check.stdout}`;
}

async function pushWorkspace(workspace: string): Promise<GitRunResult> {
  const result = await git(['push'], workspace);
  if (result.code !== 0 && /no upstream branch|set-upstream|--set-upstream/i.test(result.stderr)) {
    return git(['push', '-u', 'origin', 'HEAD'], workspace);
  }
  return result;
}

function toMutationResult(result: GitRunResult): GitMutationResult {
  return result.code === 0
    ? { success: true, output: result.stdout || result.stderr }
    : { success: false, error: result.stderr || result.stdout };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
