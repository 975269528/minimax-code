import type { WorkspaceGitChangedEvent } from './snapshot/snapshot-support.js';

export interface HtmlPreviewLeaseError {
  ok: false;
  status: number;
  code: string;
  error: string;
}

export interface CreateWorkspaceHtmlPreviewOptions {
  bridgeScriptTag?: string;
  managed?: boolean;
}

export type CreateHtmlPreviewLeaseResult =
  | { ok: true; url: string; lease?: { token: string; ownerToken: string } }
  | HtmlPreviewLeaseError;

export type WorkspaceHtmlPreviewResourceResult =
  | {
      ok: true;
      body: string | ReadableStream<Uint8Array> | null;
      status: number;
      headers: Record<string, string>;
    }
  | HtmlPreviewLeaseError;

export interface ResolvedHtmlPreviewResource {
  ok: true;
  absolutePath: string;
  contentType: string;
}

export type GitChangesMode = 'fast' | 'full';
export type GitChangeScope = 'staged' | 'unstaged' | 'all';
export type ScopedGitChangeScope = Exclude<GitChangeScope, 'all'>;
export type GitFileChangeAction = 'stage' | 'unstage' | 'discard';

export interface GitChangedFile {
  path: string;
  originalPath?: string;
  status: 'added' | 'deleted' | 'modified';
  additions: number;
  deletions: number;
  changeScope?: ScopedGitChangeScope;
}

export interface GitChangesInfo {
  snapshotId: string;
  isGitRepo: boolean;
  changedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  insertions: number;
  deletions: number;
  hasHead: boolean;
  files: GitChangedFile[];
  lineStatsStatus: 'ready' | 'partial' | 'skipped';
  error?: string;
}

export type GitChangesValue = Omit<GitChangesInfo, 'snapshotId'>;

export interface GitChangesBase {
  changes: GitChangesValue;
  untrackedPaths: Set<string>;
}

export interface GitMetadataInfo {
  snapshotId: string;
  isGitRepo: boolean;
  branch: string;
  isWorktree?: boolean;
  ahead?: number;
  behind?: number;
  hasUpstream?: boolean;
  hasRemote?: boolean;
  canPush?: boolean;
  hasHead?: boolean;
  error?: string;
}

export type GitMetadataValue = Omit<GitMetadataInfo, 'snapshotId'>;

export interface WorkspaceFileContent {
  type: 'text' | 'binary';
  content: string;
  encoding?: string;
  mimeType?: string;
  error?: string;
}

export interface WorkspaceFileDiff extends WorkspaceFileContent {
  file?: string;
  originalPath?: string;
  additions?: number;
  deletions?: number;
  status?: GitChangedFile['status'];
  diff?: string;
  previewState?: 'ready' | 'binary' | 'too_large' | 'no_diff';
  changeScope?: ScopedGitChangeScope;
}

export interface WorkspaceDiffSnapshot {
  snapshotId: string;
  diffs: WorkspaceFileDiff[];
}

export interface WorkspaceDiffContext {
  contextContent: string;
  changeScope?: ScopedGitChangeScope;
}

export type WorkspaceReviewSource =
  | { type: 'workspace' }
  | { type: 'commit'; baseRef: string; commitSha: string }
  | { type: 'branch'; baseRef: string };

export interface WorkspaceReviewCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  message?: string;
  committedAtMs: number;
  additions?: number;
  deletions?: number;
  isMerge?: boolean;
}

export interface WorkspaceReviewCommitList {
  baseCommit: string;
  headCommit: string;
  totalCount: number;
  items: WorkspaceReviewCommit[];
}

export interface WorkspaceReviewUntrackedOmission {
  count: number;
  limit: number;
}

export interface WorkspaceReviewFile {
  fileId: string;
  path: string;
  originalPath?: string;
  status: GitChangedFile['status'];
  changeScope?: ScopedGitChangeScope;
  revision: string;
  type?: 'text' | 'binary';
  additions: number;
  deletions: number;
  changedBytes?: number;
  maxChangedLineBytes?: number;
  generated?: boolean;
  untracked?: boolean;
}

export interface WorkspaceReviewSummary {
  repositoryId: string;
  reviewSnapshotId: string;
  source: WorkspaceReviewSource;
  baseCommit?: string;
  headCommit?: string;
  workspaceSnapshotId?: string;
  files: WorkspaceReviewFile[];
  totals: {
    files: number;
    additions: number;
    deletions: number;
    changedBytes?: number;
  };
  untrackedFilesOmitted?: WorkspaceReviewUntrackedOmission;
}

export interface WorkspaceReviewFileDiff {
  fileId: string;
  diff?: WorkspaceFileDiff;
  errorCode?: string;
  error?: string;
}

export interface WorkspaceReviewFileContent extends WorkspaceFileContent {
  fileId: string;
  path: string;
  side: 'old' | 'new';
}

interface WorkspaceReviewSearchFile {
  fileId: string;
  path: string;
  matchCount: number;
}

export interface WorkspaceReviewSearchResult {
  reviewSnapshotId: string;
  matchedFiles: WorkspaceReviewSearchFile[];
  totalMatches: number;
  totalMatchedFiles: number;
  pageIndex: number;
  pageSize: number;
  matchesBeforePage: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  untrackedFilesOmitted?: WorkspaceReviewUntrackedOmission;
}

export type WorkspaceReviewSearchTooLargeReason = 'index';

export class WorkspaceReviewSearchTooLargeError extends Error {
  override readonly name = 'WorkspaceReviewSearchTooLargeError';

  constructor(readonly reason: WorkspaceReviewSearchTooLargeReason) {
    super('Review search exceeded its safe in-memory index budget');
  }
}

export interface GitMutationResult {
  success: boolean;
  output?: string;
  error?: string;
}

export interface GitBranchesInfo {
  success: boolean;
  current: string;
  branches: string[];
  local?: string[];
  remote?: string[];
  error?: string;
}

export interface GitDefaultBranchInfo {
  success: boolean;
  branch?: string;
  source?: string;
  error?: string;
}

export interface GitWorktreeInfo {
  path?: string;
  branch?: string;
  head?: string;
  isMain?: boolean;
  isLocked?: boolean;
  isActive?: boolean;
  isMcodeManaged?: boolean;
  lastModifiedMs?: number;
}

export interface GitWorktreesInfo {
  success: boolean;
  current?: string;
  worktrees?: GitWorktreeInfo[];
  error?: string;
}

export interface InitializeWorkspaceGitServiceOptions {
  watchWorkspace?: boolean;
  publishChanged?: (event: WorkspaceGitChangedEvent) => void;
  instanceId?: string;
  maxWorkspaces?: number;
}

export class WorkspaceGitSnapshotChangedError extends Error {
  override readonly name = 'WorkspaceGitSnapshotChangedError';

  constructor(readonly snapshotId?: string) {
    super('Workspace Git snapshot changed while the requested content was being generated');
  }
}

export class WorkspaceGitCommandError extends Error {
  override readonly name = 'WorkspaceGitCommandError';

  constructor(
    readonly operation: 'diff' | 'ls-files',
    readonly exitCode: number,
    details: string,
  ) {
    super(`Git ${operation} failed with exit code ${exitCode}: ${details || 'unknown error'}`);
  }
}
