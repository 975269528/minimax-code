import { basename } from 'node:path';

import type {
  GitBranchesInfo,
  GitChangesBase,
  GitChangesInfo,
  GitChangesMode,
  GitChangesValue,
  GitDefaultBranchInfo,
  GitFileChangeAction,
  GitMetadataInfo,
  GitMetadataValue,
  GitMutationResult,
  GitChangeScope,
  InitializeWorkspaceGitServiceOptions,
  WorkspaceDiffContext,
  WorkspaceDiffSnapshot,
  WorkspaceFileDiff,
  GitWorktreesInfo,
  WorkspaceReviewCommitList,
  WorkspaceReviewFileContent,
  WorkspaceReviewSearchResult,
  WorkspaceReviewSource,
  WorkspaceReviewSummary,
} from './contracts.js';
import {
  captureGitChangesBase,
  classifyWorkspacePathsIgnored,
  enrichGitChanges,
  getDefaultBranch,
  getGitBranches,
  listRecentGitBranches,
  searchGitBranches,
  type GitBranchSearchOptions,
  getGitMetadata,
  isGitRepo,
} from './operations/changes.js';
import {
  getWorkspaceDiffContext,
  getWorkspaceFileDiff,
  listWorkspaceFileDiffs,
} from './operations/diffs.js';
import {
  applyFileChangeAction,
  checkoutBranch,
  commit,
  commitAndPush,
  createBranch,
  push,
  saveWorkspaceFile,
} from './operations/mutations.js';
import { listWorkspaceGitWorktrees } from './operations/worktrees.js';
import {
  getWorkspaceReviewFileContent,
  getWorkspaceReviewSummary,
  listWorkspaceReviewCommits,
  listWorkspaceReviewFileDiffs,
  searchWorkspaceReviewDiffs,
} from './operations/review.js';
import { WorkspaceReviewSearchIndexCache } from './operations/review-search.js';
import { normalizeWorkspacePath } from './operations/workspace-identity.js';
import { WorkspaceGitSnapshotManager } from './snapshot/snapshot-manager.js';
import { createWorkspaceGitWatcher } from './snapshot/watcher.js';

type SnapshotManager = WorkspaceGitSnapshotManager<
  GitChangesBase,
  GitChangesValue,
  GitMetadataValue
>;

export class WorkspaceGitService {
  private readonly manager: SnapshotManager;
  private readonly reviewSearchCache = new WorkspaceReviewSearchIndexCache();
  private readonly projectedChanges = new WeakMap<object, GitChangesInfo>();
  private readonly projectedMetadata = new WeakMap<object, GitMetadataInfo>();

  constructor(options: InitializeWorkspaceGitServiceOptions = {}) {
    this.manager = new WorkspaceGitSnapshotManager({
      loadBase: captureGitChangesBase,
      loadFull: enrichGitChanges,
      loadMetadata: getGitMetadata,
      ...(options.watchWorkspace !== false
        ? {
            changeNotificationWindowMs: 250,
            startWatcher: (workspace, callbacks) =>
              createWorkspaceGitWatcher({
                workspace,
                callbacks,
                classifyIgnored: (paths) => classifyWorkspacePathsIgnored(workspace, paths),
              }),
          }
        : {}),
      ...(options.publishChanged ? { onChanged: options.publishChanged } : {}),
      ...(options.instanceId ? { instanceId: options.instanceId } : {}),
      ...(options.maxWorkspaces ? { maxWorkspaces: options.maxWorkspaces } : {}),
    });
  }

  async getChanges(workspace: string, mode: GitChangesMode): Promise<GitChangesInfo> {
    const identity = await this.resolveSnapshotIdentity(workspace);
    if (mode === 'fast') {
      const snapshot = await this.manager.getChanges(identity, 'fast');
      return this.projectChanges(snapshot.snapshotId, snapshot.value.changes);
    }
    const snapshot = await this.manager.getChanges(identity, 'full');
    return this.projectChanges(snapshot.snapshotId, snapshot.value);
  }

  async getMetadata(workspace: string): Promise<GitMetadataInfo> {
    const identity = await this.resolveSnapshotIdentity(workspace);
    const snapshot = await this.manager.getMetadata(identity);
    const cached = this.projectedMetadata.get(snapshot.value);
    if (cached?.snapshotId === snapshot.snapshotId) return cached;
    const result = { snapshotId: snapshot.snapshotId, ...snapshot.value };
    this.projectedMetadata.set(snapshot.value, result);
    return result;
  }

  async probe(workspace: string): Promise<{ isGitRepo: boolean }> {
    const identity = await this.resolveSnapshotIdentity(workspace);
    await this.manager.observeWorkspace(identity);
    return { isGitRepo: await isGitRepo(identity) };
  }

  async suggestCommitMessage(workspace: string): Promise<string> {
    const changes = await this.getChanges(workspace, 'full');
    if (!changes.isGitRepo) throw new Error('Not a git repository');
    const first = changes.files[0];
    if (!first) throw new Error('No changes to summarize');
    let action = 'update';
    if (first.status === 'added') action = 'add';
    else if (first.status === 'deleted') action = 'remove';
    return `chore: ${action} ${basename(first.path)}`;
  }

  async getBranches(workspace: string, includeRemote = false): Promise<GitBranchesInfo> {
    const identity = await this.resolveWorkspaceIdentity(workspace);
    return getGitBranches(identity, includeRemote);
  }

  async listRecentBranches(
    workspace: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<GitBranchesInfo> {
    const identity = await this.resolveWorkspaceIdentity(workspace);
    return listRecentGitBranches(identity, limit, signal);
  }

  async searchBranches(
    workspace: string,
    query: string,
    options: GitBranchSearchOptions = {},
  ): Promise<GitBranchesInfo> {
    const identity = await this.resolveWorkspaceIdentity(workspace);
    return searchGitBranches(identity, query, options);
  }

  async getDefaultBranch(workspace: string): Promise<GitDefaultBranchInfo> {
    const identity = await this.resolveWorkspaceIdentity(workspace);
    return getDefaultBranch(identity);
  }

  async getBranchPicker(workspace: string): Promise<GitBranchesInfo & GitWorktreesInfo> {
    const identity = await this.resolveWorkspaceIdentity(workspace);
    const [branches, worktrees] = await Promise.all([
      getGitBranches(identity, false),
      listWorkspaceGitWorktrees(identity),
    ]);
    return { ...branches, worktrees: worktrees.worktrees };
  }

  async listWorktrees(workspace: string): Promise<GitWorktreesInfo> {
    const identity = await this.resolveWorkspaceIdentity(workspace);
    return listWorkspaceGitWorktrees(identity);
  }

  async getFileDiff(
    workspace: string,
    filePath: string,
    options?: { scope?: GitChangeScope; snapshotId?: string; lean?: boolean },
  ): Promise<WorkspaceFileDiff> {
    const identity = await this.resolveSnapshotIdentity(workspace);
    return getWorkspaceFileDiff(this.manager, identity, filePath, options);
  }

  async listFileDiffs(
    workspace: string,
    options?: { scope?: GitChangeScope; snapshotId?: string },
  ): Promise<WorkspaceDiffSnapshot> {
    const identity = await this.resolveSnapshotIdentity(workspace);
    return listWorkspaceFileDiffs(this.manager, identity, options);
  }

  async getDiffContext(
    workspace: string,
    filePath: string,
    options?: { scope?: GitChangeScope; snapshotId?: string },
  ): Promise<WorkspaceDiffContext | undefined> {
    const identity = await this.resolveSnapshotIdentity(workspace);
    return getWorkspaceDiffContext(this.manager, identity, filePath, options);
  }

  async getFileStatus(workspace: string) {
    const changes = await this.getChanges(workspace, 'full');
    return changes.files.map((file) => ({
      path: file.path,
      ...(file.originalPath ? { originalPath: file.originalPath } : {}),
      added: file.additions,
      removed: file.deletions,
      status: file.status,
      ...(file.changeScope ? { changeScope: file.changeScope } : {}),
    }));
  }

  async listReviewCommits(
    workspace: string,
    baseRef: string,
    query?: string,
    limit?: number,
  ): Promise<WorkspaceReviewCommitList> {
    const identity = await this.resolveSnapshotIdentity(workspace);
    return listWorkspaceReviewCommits(identity, baseRef, query, limit);
  }

  async getReviewSummary(
    workspace: string,
    source: WorkspaceReviewSource,
  ): Promise<WorkspaceReviewSummary> {
    const identity = await this.resolveSnapshotIdentity(workspace);
    return getWorkspaceReviewSummary(this.manager, identity, source);
  }

  async listReviewFileDiffs(
    workspace: string,
    source: WorkspaceReviewSource,
    request: { reviewSnapshotId: string; fileIds?: string[] },
  ) {
    const identity = await this.resolveSnapshotIdentity(workspace);
    return listWorkspaceReviewFileDiffs({
      manager: this.manager,
      workspace: identity,
      source,
      expectedSnapshotId: request.reviewSnapshotId,
      ...(request.fileIds ? { fileIds: request.fileIds } : {}),
    });
  }

  async getReviewFileContent(
    workspace: string,
    source: WorkspaceReviewSource,
    request: { reviewSnapshotId: string; fileId: string; side: 'old' | 'new' },
  ): Promise<WorkspaceReviewFileContent> {
    const identity = await this.resolveSnapshotIdentity(workspace);
    return getWorkspaceReviewFileContent({
      manager: this.manager,
      workspace: identity,
      source,
      expectedSnapshotId: request.reviewSnapshotId,
      targetFileId: request.fileId,
      side: request.side,
    });
  }

  async searchReviewDiffs(
    workspace: string,
    source: WorkspaceReviewSource,
    request: {
      reviewSnapshotId: string;
      query: string;
      includeUntrackedFiles: boolean;
      pageIndex?: number;
      pageSize?: number;
      signal?: AbortSignal;
    },
  ): Promise<WorkspaceReviewSearchResult> {
    const identity = await this.resolveSnapshotIdentity(workspace);
    return searchWorkspaceReviewDiffs({
      manager: this.manager,
      workspace: identity,
      source,
      expectedSnapshotId: request.reviewSnapshotId,
      query: request.query,
      includeUntrackedFiles: request.includeUntrackedFiles,
      pageIndex: request.pageIndex ?? 0,
      pageSize: request.pageSize ?? 10,
      cache: this.reviewSearchCache,
      ...(request.signal ? { signal: request.signal } : {}),
    });
  }

  async saveFile(workspace: string, filePath: string, content: string): Promise<void> {
    const identity = await this.resolveSnapshotIdentity(workspace);
    return saveWorkspaceFile(this.manager, identity, filePath, content);
  }

  async checkout(workspace: string, branch: string): Promise<GitMutationResult> {
    const identity = await this.resolveSnapshotIdentity(workspace);
    return checkoutBranch(this.manager, identity, branch);
  }

  async createBranch(workspace: string, branch: string): Promise<GitMutationResult> {
    const identity = await this.resolveSnapshotIdentity(workspace);
    return createBranch(this.manager, identity, branch);
  }

  async commit(
    workspace: string,
    message: string,
    includeUnstaged?: boolean,
  ): Promise<GitMutationResult> {
    const identity = await this.resolveSnapshotIdentity(workspace);
    return commit(this.manager, identity, message, includeUnstaged);
  }

  async commitAndPush(workspace: string, message: string, includeUnstaged?: boolean) {
    const identity = await this.resolveSnapshotIdentity(workspace);
    return commitAndPush(this.manager, identity, message, includeUnstaged);
  }

  async push(workspace: string): Promise<GitMutationResult> {
    const identity = await this.resolveSnapshotIdentity(workspace);
    return push(this.manager, identity);
  }

  async applyFileChangeAction(
    workspace: string,
    action: GitFileChangeAction,
    paths: string[],
    scope?: GitChangeScope,
  ): Promise<GitMutationResult> {
    const identity = await this.resolveSnapshotIdentity(workspace);
    return applyFileChangeAction(this.manager, identity, { action, paths, scope });
  }

  async invalidate(
    workspace: string,
    kind: 'workspace' | 'repository' = 'repository',
  ): Promise<string> {
    const identity = await this.resolveSnapshotIdentity(workspace);
    this.reviewSearchCache.clear();
    return this.manager.invalidate(identity, { kind, reason: 'manual' });
  }

  invalidateAll(): void {
    this.reviewSearchCache.clear();
    this.manager.invalidateAll('manual');
  }

  async releaseWorkspace(workspace: string): Promise<boolean> {
    const identity = await this.resolveWorkspaceIdentity(workspace);
    this.reviewSearchCache.clear();
    return this.manager.releaseWorkspace(identity);
  }

  resolveWorkspaceIdentity(workspace: string): Promise<string> {
    return normalizeWorkspacePath(workspace);
  }

  close(): void {
    this.reviewSearchCache.clear();
    this.manager.close();
  }

  private async resolveSnapshotIdentity(workspace: string): Promise<string> {
    const identity = await this.resolveWorkspaceIdentity(workspace);
    this.manager.registerWorkspaceAlias(identity, workspace);
    return identity;
  }

  private projectChanges(snapshotId: string, value: GitChangesValue): GitChangesInfo {
    const cached = this.projectedChanges.get(value);
    if (cached?.snapshotId === snapshotId) return cached;
    const result = { snapshotId, ...value };
    this.projectedChanges.set(value, result);
    return result;
  }
}
