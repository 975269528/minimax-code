/** Compatibility types; worktree operations are owned by the V2 session service. */
export type LocalRunLocationMode = 'current' | 'new-worktree' | 'existing-worktree';

export interface LocalRunLocationInput {
  mode: LocalRunLocationMode;
  worktreeDir?: string;
  branch?: string;
  newWorktreeBranch?: string;
  /** Optional start point passed as the final `<commit-ish>` to `git worktree add`. */
  newWorktreeBase?: string;
}

export interface ResolvedLocalRunLocation {
  mode: LocalRunLocationMode;
  resolvedDir: string;
  resolvedBranch?: string;
  parentRepoDir?: string;
  createdAt: number;
}
