import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { git } from './git-process.js';

export type WorktreeDiscoveryCode =
  | 'not_git_repository'
  | 'workspace_unavailable'
  | 'worktree_list_failed';

export interface WorkspaceGitWorktree {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
  isLocked: boolean;
  isActive: boolean;
  isMcodeManaged: boolean;
  lastModifiedMs?: number;
}

export interface WorkspaceGitWorktreeList {
  success: boolean;
  current?: string;
  worktrees: WorkspaceGitWorktree[];
  error?: string;
  code?: WorktreeDiscoveryCode;
}

export async function listWorkspaceGitWorktrees(
  workspace: string,
  options: { usePrimaryWorktree?: boolean } = {},
): Promise<WorkspaceGitWorktreeList> {
  const workspaceInfo = await stat(workspace).catch(() => undefined);
  if (!workspaceInfo?.isDirectory()) {
    return {
      success: false,
      worktrees: [],
      error: 'Workspace directory is unavailable',
      code: 'workspace_unavailable',
    };
  }
  const rootResult = await git(['rev-parse', '--show-toplevel'], workspace);
  if (rootResult.code !== 0) {
    const error = rootResult.stderr || rootResult.stdout || 'Failed to inspect Git workspace';
    return {
      success: false,
      worktrees: [],
      error,
      code: /not a git repository/i.test(error) ? 'not_git_repository' : 'workspace_unavailable',
    };
  }
  const root = rootResult.stdout.trim();
  const result = await git(['worktree', 'list', '--porcelain'], root);
  if (result.code !== 0) {
    return {
      success: false,
      worktrees: [],
      error: result.stderr || result.stdout || 'Failed to inspect Git worktrees',
      code: 'worktree_list_failed',
    };
  }
  const entries = result.stdout
    .split(/\n\n+/)
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
    .filter((item) => item.worktree);
  const mainWorktreePath = options.usePrimaryWorktree ? entries[0]?.worktree : root;
  const activeWorktreePath = await realpath(workspace).catch(() => resolve(workspace));
  const mcodeWorktreeParent =
    typeof mainWorktreePath === 'string'
      ? await realpath(join(mainWorktreePath, '.worktrees')).catch(() => undefined)
      : undefined;
  const worktrees = await Promise.all(
    entries.map(async (item): Promise<WorkspaceGitWorktree | null> => {
      const worktreePath = String(item.worktree);
      const [canonicalWorktreePath, lastModifiedMs] = await Promise.all([
        realpath(worktreePath).catch(() => resolve(worktreePath)),
        worktreeLastModifiedMs(worktreePath),
      ]);
      if (lastModifiedMs === null) return null;
      return {
        path: worktreePath,
        branch: String(item.branch ?? '').replace(/^refs\/heads\//, ''),
        head: String(item.HEAD ?? ''),
        ...(lastModifiedMs === undefined ? {} : { lastModifiedMs }),
        isMain:
          typeof mainWorktreePath === 'string' &&
          resolve(worktreePath) === resolve(mainWorktreePath),
        isLocked: 'locked' in item,
        isActive: canonicalWorktreePath === activeWorktreePath,
        isMcodeManaged:
          mcodeWorktreeParent !== undefined &&
          isPathInside(mcodeWorktreeParent, canonicalWorktreePath),
      } satisfies WorkspaceGitWorktree;
    }),
  );
  return {
    success: true,
    current: String(mainWorktreePath ?? root),
    worktrees: worktrees.filter((entry): entry is WorkspaceGitWorktree => entry !== null),
  };
}

/** null means confirmed missing; undefined means metadata could not be read. */
async function worktreeLastModifiedMs(worktreePath: string): Promise<number | undefined | null> {
  try {
    return Math.trunc((await stat(worktreePath)).mtimeMs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
  }

  const reflog = await git(['reflog', '-1', '--format=%ct'], worktreePath);
  const reflogSeconds = Number.parseInt(reflog.stdout.trim(), 10);
  if (Number.isFinite(reflogSeconds) && reflogSeconds > 0) return reflogSeconds * 1000;
  return undefined;
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
