import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { GitWorktreeInfo, GitWorktreesInfo } from '../contracts.js';
import { git } from './git-process.js';

export async function listWorkspaceGitWorktrees(
  workspace: string,
  options: { usePrimaryWorktree?: boolean } = {},
): Promise<GitWorktreesInfo> {
  const workspaceInfo = await readStat(workspace);
  if (!workspaceInfo?.isDirectory()) {
    return { success: false, worktrees: [], error: 'Workspace directory is unavailable' };
  }
  const rootResult = await git(['rev-parse', '--show-toplevel'], workspace);
  if (rootResult.code !== 0) {
    return {
      success: false,
      worktrees: [],
      error: rootResult.stderr || rootResult.stdout || 'Failed to inspect Git workspace',
    };
  }
  const root = rootResult.stdout.trim();
  const result = await git(['worktree', 'list', '--porcelain'], root);
  if (result.code !== 0) {
    return {
      success: false,
      worktrees: [],
      error: result.stderr || result.stdout || 'Failed to inspect Git worktrees',
    };
  }
  const entries = parseWorktreeEntries(result.stdout);
  const mainWorktreePath = options.usePrimaryWorktree ? entries[0]?.worktree : root;
  const activeWorktreePath = await canonicalPath(workspace);
  const managedParent = await resolveManagedParent(mainWorktreePath);
  const worktrees = await Promise.all(
    entries.map((entry) =>
      toWorktreeInfo(entry, { mainWorktreePath, activeWorktreePath, managedParent }),
    ),
  );
  return {
    success: true,
    current: String(mainWorktreePath ?? root),
    worktrees: worktrees.filter((entry): entry is GitWorktreeInfo => entry !== null),
  };
}

type WorktreeEntry = Record<string, string>;

function parseWorktreeEntries(output: string): WorktreeEntry[] {
  return output
    .split(/\n\n+/u)
    .map((block) =>
      Object.fromEntries(
        block
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [key, ...rest] = line.split(' ');
            return [key, rest.join(' ')];
          }),
      ),
    )
    .filter((entry) => Boolean(entry.worktree));
}

async function toWorktreeInfo(
  entry: WorktreeEntry,
  context: {
    mainWorktreePath?: string;
    activeWorktreePath: string;
    managedParent?: string;
  },
): Promise<GitWorktreeInfo | null> {
  const worktreePath = String(entry.worktree);
  const [canonicalWorktreePath, lastModifiedMs] = await Promise.all([
    canonicalPath(worktreePath),
    readLastModifiedMs(worktreePath),
  ]);
  if (lastModifiedMs === null) return null;
  return {
    path: worktreePath,
    branch: String(entry.branch ?? '').replace(/^refs\/heads\//u, ''),
    head: String(entry.HEAD ?? ''),
    isMain:
      context.mainWorktreePath !== undefined &&
      resolve(worktreePath) === resolve(context.mainWorktreePath),
    isLocked: 'locked' in entry,
    isActive: canonicalWorktreePath === context.activeWorktreePath,
    isMcodeManaged:
      context.managedParent !== undefined &&
      isPathInside(context.managedParent, canonicalWorktreePath),
    ...(lastModifiedMs === undefined ? {} : { lastModifiedMs }),
  };
}

async function resolveManagedParent(
  mainWorktreePath: string | undefined,
): Promise<string | undefined> {
  if (!mainWorktreePath) return undefined;
  try {
    return await realpath(join(mainWorktreePath, '.worktrees'));
  } catch {
    return undefined;
  }
}

async function canonicalPath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return resolve(target);
  }
}

async function readStat(target: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(target);
  } catch {
    return undefined;
  }
}

/** null means confirmed missing; undefined means metadata could not be read. */
async function readLastModifiedMs(target: string): Promise<number | undefined | null> {
  try {
    return Math.trunc(Number((await stat(target)).mtimeMs));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    return undefined;
  }
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
