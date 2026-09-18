import { randomUUID } from 'node:crypto';
import {
  clearWorkspaceEntries,
  currentWorkspaceSnapshotId,
  evictOldestIdleWorkspaceEntry,
  isCurrentWorkspaceSnapshot,
  releaseWorkspaceEntry,
  trimIdleWorkspaceEntries,
} from './snapshot-entry-cache.js';
import {
  createDeferred,
  publishWorkspaceGitChanged,
  StaleWorkspaceGitSnapshotError,
  WorkspaceGitSnapshotManagerClosedError,
  WorkspaceGitSnapshotReleasedError,
  type GitChangesMode,
  type VersionedValue,
  type WorkspaceEntry,
  type WorkspaceGitChangedEvent,
  type WorkspaceGitChangeKind,
  type WorkspaceGitSnapshot,
  type WorkspaceGitSnapshotManagerOptions,
} from './snapshot-support.js';

export type {
  GitChangesMode,
  WorkspaceGitChangedEvent,
  WorkspaceGitChangeKind,
  WorkspaceGitSnapshot,
  WorkspaceGitSnapshotManagerOptions,
  WorkspaceGitWatchCallbacks,
  WorkspaceGitWatchHandle,
} from './snapshot-support.js';

/**
 * Runtime-owned source of truth for one Git snapshot per workspace.
 *
 * In-flight work and completed values share the same snapshot id. A watcher or
 * mutation advances that id before a later request can join the old work. A
 * request that crosses the boundary retries against the new id instead of
 * returning an apparently precise stale result.
 */
export class WorkspaceGitSnapshotManager<TBase, TFull, TMetadata = never> {
  private readonly entries = new Map<string, WorkspaceEntry<TBase, TFull, TMetadata>>();
  private readonly instanceId: string;
  private readonly maxWorkspaces: number;
  private readonly reuseCompletedResults: boolean;
  private readonly changeNotificationWindowMs: number;
  private snapshotSequence = 0;
  private usageSequence = 0;
  private closed = false;

  constructor(
    private readonly options: WorkspaceGitSnapshotManagerOptions<TBase, TFull, TMetadata>,
  ) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.maxWorkspaces = Math.max(1, options.maxWorkspaces ?? 8);
    this.reuseCompletedResults = options.reuseCompletedResults !== false;
    this.changeNotificationWindowMs = Math.max(0, options.changeNotificationWindowMs ?? 0);
  }

  getChanges(workspace: string, mode: 'fast'): Promise<WorkspaceGitSnapshot<TBase>>;
  getChanges(workspace: string, mode: 'full'): Promise<WorkspaceGitSnapshot<TFull>>;
  async getChanges(
    workspace: string,
    mode: GitChangesMode,
  ): Promise<WorkspaceGitSnapshot<TBase | TFull>> {
    for (;;) {
      const entry = this.getOrCreateEntry(workspace);
      entry.activeReaders += 1;
      try {
        const result = await this.readChangesAttempt(entry, mode);
        if (result) return result;
      } finally {
        this.finishRead(entry);
      }
    }
  }

  private async readChangesAttempt(
    entry: WorkspaceEntry<TBase, TFull, TMetadata>,
    mode: GitChangesMode,
  ): Promise<WorkspaceGitSnapshot<TBase | TFull> | undefined> {
    await this.ensureWatcher(entry);
    await this.waitForReadBarrier(entry);
    this.beginReadGeneration(entry);
    const requestSnapshotId = entry.snapshotId;
    const request = mode === 'fast' ? this.getBase(entry) : this.getFull(entry);
    try {
      const result = await request;
      await this.waitForPathClassification(entry);
      if (this.isStableResult(entry, result.snapshotId)) return result;
      if (entry.disposed) throw new WorkspaceGitSnapshotReleasedError();
      await this.waitForReadBarrier(entry);
      return undefined;
    } catch (error) {
      return this.handleChangesFailure(entry, requestSnapshotId, error);
    }
  }

  private async handleChangesFailure(
    entry: WorkspaceEntry<TBase, TFull, TMetadata>,
    requestSnapshotId: string,
    error: unknown,
  ): Promise<undefined> {
    await this.waitForReadBarrier(entry);
    if (this.closed) throw new WorkspaceGitSnapshotManagerClosedError();
    if (error instanceof WorkspaceGitSnapshotReleasedError || entry.disposed) {
      throw new WorkspaceGitSnapshotReleasedError();
    }
    if (error instanceof StaleWorkspaceGitSnapshotError) return undefined;
    if (!this.isCurrentEntry(entry)) return undefined;
    if (entry.snapshotId !== requestSnapshotId || entry.mutating) return undefined;
    throw error;
  }

  async getMetadata(workspace: string): Promise<WorkspaceGitSnapshot<TMetadata>> {
    const loader = this.options.loadMetadata;
    if (!loader) {
      throw new Error('WorkspaceGitSnapshotManager metadata loader is not configured');
    }
    for (;;) {
      const entry = this.getOrCreateEntry(workspace);
      entry.activeReaders += 1;
      try {
        const result = await this.readMetadataAttempt(entry, loader);
        if (result) return result;
      } finally {
        this.finishRead(entry);
      }
    }
  }

  private async readMetadataAttempt(
    entry: WorkspaceEntry<TBase, TFull, TMetadata>,
    loader: (workspace: string) => Promise<TMetadata>,
  ): Promise<WorkspaceGitSnapshot<TMetadata> | undefined> {
    await this.ensureWatcher(entry);
    await this.waitForReadBarrier(entry);
    this.beginReadGeneration(entry);
    if (entry.metadata !== undefined) {
      return { snapshotId: entry.snapshotId, value: entry.metadata };
    }
    const revision = entry.metadataRevision;
    const request = entry.metadataRequest ?? this.startMetadataRequest(entry, revision, loader);
    try {
      const result = await request;
      await this.waitForPathClassification(entry);
      if (this.isStableMetadata(entry, result.revision)) {
        return { snapshotId: entry.snapshotId, value: result.value };
      }
      await this.waitForReadBarrier(entry);
      if (entry.disposed) throw new WorkspaceGitSnapshotReleasedError();
      return undefined;
    } catch (error) {
      return this.handleMetadataFailure(entry, revision, error);
    }
  }

  private async handleMetadataFailure(
    entry: WorkspaceEntry<TBase, TFull, TMetadata>,
    revision: number,
    error: unknown,
  ): Promise<undefined> {
    await this.waitForReadBarrier(entry);
    if (this.closed) throw new WorkspaceGitSnapshotManagerClosedError();
    if (error instanceof WorkspaceGitSnapshotReleasedError || entry.disposed) {
      throw new WorkspaceGitSnapshotReleasedError();
    }
    if (!this.isCurrentEntry(entry)) return undefined;
    if (entry.metadataRevision !== revision || entry.mutating) return undefined;
    throw error;
  }

  private isStableMetadata(
    entry: WorkspaceEntry<TBase, TFull, TMetadata>,
    revision: number,
  ): boolean {
    return this.isCurrentEntry(entry) && !entry.mutating && entry.metadataRevision === revision;
  }

  private finishRead(entry: WorkspaceEntry<TBase, TFull, TMetadata>): void {
    entry.activeReaders -= 1;
    if (entry.activeReaders === 0) {
      entry.readGenerationSnapshotId = undefined;
      if (!this.canReuseCompleted(entry)) {
        entry.base = undefined;
        entry.full = undefined;
        entry.metadata = undefined;
      }
    }
    this.trimEntries();
  }

  currentSnapshotId(workspace: string): string | undefined {
    return currentWorkspaceSnapshotId(this.entries, workspace);
  }

  /** Associates a caller-visible spelling with the canonical snapshot owner. */
  registerWorkspaceAlias(workspace: string, alias: string): void {
    const entry = this.getOrCreateEntry(workspace);
    if (alias !== workspace) entry.aliases.add(alias);
  }

  /**
   * Establishes the workspace watcher without running a Git status query.
   * Probe uses this boundary so a non-Git directory can observe a later
   * `git init` while ordinary file churn remains query-free.
   */
  async observeWorkspace(workspace: string): Promise<void> {
    const entry = this.getOrCreateEntry(workspace);
    entry.activeReaders += 1;
    try {
      await this.ensureWatcher(entry);
      if (!this.isCurrentEntry(entry) || entry.disposed) {
        throw new WorkspaceGitSnapshotReleasedError();
      }
    } finally {
      this.finishRead(entry);
    }
  }

  /** Retires one workspace generation and closes every resource owned by it. */
  releaseWorkspace(workspace: string): boolean {
    return releaseWorkspaceEntry(this.entries, workspace);
  }

  isCurrentSnapshot(workspace: string, snapshotId: string): boolean {
    return isCurrentWorkspaceSnapshot(this.entries, workspace, snapshotId);
  }

  invalidate(
    workspace: string,
    options: {
      kind?: WorkspaceGitChangeKind;
      notify?: boolean;
      reason?: WorkspaceGitChangedEvent['reason'];
    } = {},
  ): string {
    const entry = this.getOrCreateEntry(workspace);
    const kind = options.kind ?? 'repository';
    this.advanceSnapshot(entry, kind);
    if (options.notify !== false) {
      this.publishChanged(entry, kind, options.reason ?? 'manual');
    }
    return entry.snapshotId;
  }

  /** Serializes product-owned Git writes and exposes only the final state to readers. */
  async runMutation<T>(
    workspace: string,
    kind: WorkspaceGitChangeKind,
    operation: () => Promise<T>,
  ): Promise<T> {
    const entry = this.getOrCreateEntry(workspace);
    entry.mutationReservations += 1;
    try {
      const previous = entry.mutationTail;
      const gate = createDeferred();
      entry.mutationTail = this.appendMutationBarrier(previous, gate.promise);
      await this.waitForSettledBarrier(previous);
      if (!this.isCurrentEntry(entry)) {
        gate.resolve();
        if (this.closed) throw new WorkspaceGitSnapshotManagerClosedError();
        throw new WorkspaceGitSnapshotReleasedError();
      }

      entry.mutating = true;
      entry.mutationObservedKind = undefined;
      this.resolvePendingValidation(entry);
      this.advanceSnapshot(entry, kind);
      try {
        return await operation();
      } finally {
        const finalKind = this.mergeChangeKind(entry.mutationObservedKind, kind);
        entry.mutationObservedKind = undefined;
        entry.mutating = false;
        this.advanceSnapshot(entry, finalKind);
        try {
          this.publishChanged(entry, finalKind, 'mutation');
        } finally {
          gate.resolve();
        }
      }
    } finally {
      entry.mutationReservations -= 1;
      this.trimEntries();
    }
  }

  private async appendMutationBarrier(previous: Promise<void>, next: Promise<void>): Promise<void> {
    await this.waitForSettledBarrier(previous);
    await next;
  }

  private async waitForSettledBarrier(barrier: Promise<void>): Promise<void> {
    try {
      await barrier;
    } catch {
      // A failed product operation cannot poison the workspace mutation queue.
    }
  }

  invalidateAll(reason: WorkspaceGitChangedEvent['reason'] = 'manual'): void {
    for (const entry of this.entries.values()) {
      this.advanceSnapshot(entry, 'repository');
      this.publishChanged(entry, 'repository', reason);
    }
  }

  clear(): void {
    clearWorkspaceEntries(this.entries);
  }

  /** Permanently releases this runtime-owned manager and prevents resource resurrection. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clear();
  }

  private getOrCreateEntry(workspace: string): WorkspaceEntry<TBase, TFull, TMetadata> {
    if (this.closed) throw new WorkspaceGitSnapshotManagerClosedError();
    const existing = this.entries.get(workspace);
    if (existing) {
      existing.lastUsed = ++this.usageSequence;
      return existing;
    }

    this.evictIfNeeded();
    const entry = {
      workspace,
      aliases: new Set<string>(),
      snapshotId: this.nextSnapshotId(),
      metadataRevision: 0,
      watcherHealthy: this.options.startWatcher === undefined,
      watcherSetup: Promise.resolve(),
      watcherSetupAttempts: 0,
      watcherSetupPending: false,
      watcherErrorReported: false,
      mutationTail: Promise.resolve(),
      mutating: false,
      mutationObservedKind: undefined,
      mutationReservations: 0,
      activeReaders: 0,
      lastUsed: ++this.usageSequence,
      disposed: false,
    } satisfies WorkspaceEntry<TBase, TFull, TMetadata>;
    this.entries.set(workspace, entry);
    entry.watcherSetup = this.scheduleWatcherSetup(entry);
    return entry;
  }

  /**
   * A failed watcher is retried only when the next product read arrives. The
   * setup itself is singleflight, so progressive fast/full readers do not each
   * create a watcher and persistent failures do not create a background loop.
   */
  private async ensureWatcher(entry: WorkspaceEntry<TBase, TFull, TMetadata>): Promise<void> {
    const setupWasPending = entry.watcherSetupPending;
    await entry.watcherSetup;
    if (
      setupWasPending ||
      !this.options.startWatcher ||
      entry.watcherHealthy ||
      entry.readGenerationSnapshotId === entry.snapshotId ||
      !this.isCurrentEntry(entry)
    ) {
      return;
    }
    await this.scheduleWatcherSetup(entry);
  }

  private scheduleWatcherSetup(entry: WorkspaceEntry<TBase, TFull, TMetadata>): Promise<void> {
    if (!this.options.startWatcher || entry.watcherSetupPending || !this.isCurrentEntry(entry)) {
      return entry.watcherSetup;
    }
    entry.watcherSetupPending = true;
    const recovering = entry.watcherSetupAttempts > 0;
    entry.watcherSetupAttempts += 1;
    const setup = this.startWatcherAndClearPending(entry, recovering);
    entry.watcherSetup = setup;
    return setup;
  }

  private async startWatcherAndClearPending(
    entry: WorkspaceEntry<TBase, TFull, TMetadata>,
    recovering: boolean,
  ): Promise<void> {
    try {
      await this.startWatcher(entry, recovering);
    } finally {
      entry.watcherSetupPending = false;
    }
  }

  private async startWatcher(
    entry: WorkspaceEntry<TBase, TFull, TMetadata>,
    recovering: boolean,
  ): Promise<void> {
    if (!this.options.startWatcher) return;
    let setupFailed = false;
    try {
      const watcher = await this.options.startWatcher(entry.workspace, {
        onPotentialChange: () => this.onPotentialChange(entry),
        onIgnoredOnly: () => this.onIgnoredOnly(entry),
        onChange: (kind) => this.onWatcherChange(entry, kind),
        onError: (error) => {
          setupFailed = true;
          this.onWatcherError(entry, error);
        },
      });
      if (!this.isCurrentEntry(entry) || setupFailed) {
        watcher.close();
        return;
      }
      entry.watcher = watcher;
      if (recovering) this.advanceSnapshot(entry, 'repository');
      entry.watcherHealthy = true;
      entry.watcherErrorReported = false;
    } catch (error) {
      if (!setupFailed) this.onWatcherError(entry, error);
    }
  }

  private onPotentialChange(entry: WorkspaceEntry<TBase, TFull, TMetadata>): void {
    if (!this.isCurrentEntry(entry)) return;
    if (entry.mutating) {
      return;
    }
    entry.pendingValidation ??= createDeferred();
  }

  private onIgnoredOnly(entry: WorkspaceEntry<TBase, TFull, TMetadata>): void {
    if (!this.isCurrentEntry(entry)) return;
    this.resolvePendingValidation(entry);
  }

  private onWatcherChange(
    entry: WorkspaceEntry<TBase, TFull, TMetadata>,
    kind: WorkspaceGitChangeKind,
  ): void {
    if (!this.isCurrentEntry(entry)) return;
    if (entry.mutating) {
      entry.mutationObservedKind = this.mergeChangeKind(entry.mutationObservedKind, kind);
      this.resolvePendingValidation(entry);
      return;
    }
    this.advanceSnapshot(entry, kind);
    this.resolvePendingValidation(entry);
    this.publishChanged(entry, kind, 'watcher');
  }

  private onWatcherError(entry: WorkspaceEntry<TBase, TFull, TMetadata>, _error: unknown): void {
    if (!this.isCurrentEntry(entry)) return;
    const shouldPublish = !entry.watcherErrorReported;
    entry.watcherErrorReported = true;
    if (entry.mutating) entry.mutationObservedKind = 'repository';
    entry.watcher?.close();
    entry.watcher = undefined;
    entry.watcherHealthy = false;
    this.advanceSnapshot(entry, 'repository');
    this.resolvePendingValidation(entry);
    if (shouldPublish) this.publishChanged(entry, 'repository', 'watcher-error');
  }

  private getBase(entry: WorkspaceEntry<TBase, TFull, TMetadata>): Promise<VersionedValue<TBase>> {
    if (entry.base?.snapshotId === entry.snapshotId) {
      return Promise.resolve(entry.base);
    }
    if (entry.baseRequest) return entry.baseRequest;

    const snapshotId = entry.snapshotId;
    const request = this.loadBaseRequestAndClear(entry, snapshotId);
    entry.baseRequest = request;
    return request;
  }

  private async loadBaseRequestAndClear(
    entry: WorkspaceEntry<TBase, TFull, TMetadata>,
    snapshotId: string,
  ): Promise<VersionedValue<TBase>> {
    try {
      const value = await this.options.loadBase(entry.workspace);
      const result = { snapshotId, value };
      if (this.isStableResult(entry, snapshotId)) entry.base = result;
      return result;
    } finally {
      if (entry.snapshotId === snapshotId) entry.baseRequest = undefined;
      this.trimEntries();
    }
  }

  private getFull(entry: WorkspaceEntry<TBase, TFull, TMetadata>): Promise<VersionedValue<TFull>> {
    if (entry.full?.snapshotId === entry.snapshotId) {
      return Promise.resolve(entry.full);
    }
    if (entry.fullRequest) return entry.fullRequest;

    const snapshotId = entry.snapshotId;
    const request = this.loadFullRequestAndClear(entry, snapshotId);
    entry.fullRequest = request;
    return request;
  }

  private async loadFullRequestAndClear(
    entry: WorkspaceEntry<TBase, TFull, TMetadata>,
    snapshotId: string,
  ): Promise<VersionedValue<TFull>> {
    try {
      const base = await this.getBase(entry);
      await this.waitForPathClassification(entry);
      if (!this.isStableResult(entry, base.snapshotId)) {
        throw new StaleWorkspaceGitSnapshotError();
      }
      const value = await this.options.loadFull(entry.workspace, base.value);
      const result = { snapshotId, value };
      if (this.isStableResult(entry, snapshotId)) entry.full = result;
      return result;
    } finally {
      if (entry.snapshotId === snapshotId) entry.fullRequest = undefined;
      this.trimEntries();
    }
  }

  private startMetadataRequest(
    entry: WorkspaceEntry<TBase, TFull, TMetadata>,
    revision: number,
    loader: (workspace: string) => Promise<TMetadata>,
  ): Promise<{ revision: number; value: TMetadata }> {
    const request = this.loadMetadataRequestAndClear(entry, revision, loader);
    entry.metadataRequest = request;
    return request;
  }

  private async loadMetadataRequestAndClear(
    entry: WorkspaceEntry<TBase, TFull, TMetadata>,
    revision: number,
    loader: (workspace: string) => Promise<TMetadata>,
  ): Promise<{ revision: number; value: TMetadata }> {
    try {
      const value = await loader(entry.workspace);
      if (this.isStableMetadata(entry, revision)) entry.metadata = value;
      return { revision, value };
    } finally {
      if (entry.metadataRevision === revision) entry.metadataRequest = undefined;
      this.trimEntries();
    }
  }

  private advanceSnapshot(
    entry: WorkspaceEntry<TBase, TFull, TMetadata>,
    kind: WorkspaceGitChangeKind,
  ): void {
    entry.snapshotId = this.nextSnapshotId();
    entry.readGenerationSnapshotId = undefined;
    entry.base = undefined;
    entry.full = undefined;
    entry.baseRequest = undefined;
    entry.fullRequest = undefined;
    if (kind === 'repository') {
      entry.metadata = undefined;
      entry.metadataRevision += 1;
      entry.metadataRequest = undefined;
    }
  }

  private publishChanged(
    entry: WorkspaceEntry<TBase, TFull, TMetadata>,
    kind: WorkspaceGitChangeKind,
    reason: WorkspaceGitChangedEvent['reason'],
  ): void {
    const onChanged = this.options.onChanged;
    publishWorkspaceGitChanged({
      entry,
      kind,
      reason,
      ...(onChanged
        ? {
            onChanged: (event: WorkspaceGitChangedEvent) => {
              try {
                onChanged(event);
              } catch {
                // The repository/file mutation and snapshot transition already
                // committed. Delivery is best-effort and cannot turn that
                // successful product operation into a caller-visible failure.
              } finally {
                this.trimEntries();
              }
            },
          }
        : { onChanged: undefined }),
      notificationWindowMs: this.changeNotificationWindowMs,
      isCurrent: () => this.isCurrentEntry(entry),
    });
  }

  private canReuseCompleted(entry: WorkspaceEntry<TBase, TFull, TMetadata>): boolean {
    return (
      this.reuseCompletedResults &&
      entry.watcherHealthy &&
      !entry.pendingValidation &&
      !entry.mutating &&
      entry.mutationReservations === 0 &&
      !entry.disposed
    );
  }

  private mergeChangeKind(
    current: WorkspaceGitChangeKind | undefined,
    next: WorkspaceGitChangeKind,
  ): WorkspaceGitChangeKind {
    return current === 'repository' || next === 'repository' ? 'repository' : 'workspace';
  }

  /**
   * An unhealthy watcher cannot prove that two sequential physical reads saw
   * the same repository state. Give each standalone read a fresh identity,
   * while concurrent fast/full/metadata readers still join the active work.
   */
  private beginReadGeneration(entry: WorkspaceEntry<TBase, TFull, TMetadata>): void {
    if (this.canReuseCompleted(entry)) return;
    if (entry.readGenerationSnapshotId === entry.snapshotId) return;
    this.advanceSnapshot(entry, 'repository');
    entry.readGenerationSnapshotId = entry.snapshotId;
  }

  private isStableResult(
    entry: WorkspaceEntry<TBase, TFull, TMetadata>,
    snapshotId: string,
  ): boolean {
    return (
      this.isCurrentEntry(entry) &&
      !entry.mutating &&
      !entry.pendingValidation &&
      entry.snapshotId === snapshotId
    );
  }

  private isCurrentEntry(entry: WorkspaceEntry<TBase, TFull, TMetadata>): boolean {
    return !entry.disposed && this.entries.get(entry.workspace) === entry;
  }

  private async waitForPathClassification(
    entry: WorkspaceEntry<TBase, TFull, TMetadata>,
  ): Promise<void> {
    while (entry.pendingValidation) await entry.pendingValidation.promise;
  }

  private async waitForReadBarrier(entry: WorkspaceEntry<TBase, TFull, TMetadata>): Promise<void> {
    await entry.mutationTail;
    await this.waitForPathClassification(entry);
  }

  private resolvePendingValidation(entry: WorkspaceEntry<TBase, TFull, TMetadata>): void {
    const pending = entry.pendingValidation;
    entry.pendingValidation = undefined;
    pending?.resolve();
  }

  private evictIfNeeded(): void {
    if (this.entries.size < this.maxWorkspaces) return;
    evictOldestIdleWorkspaceEntry(this.entries);
  }

  private trimEntries(): void {
    trimIdleWorkspaceEntries(this.entries, this.maxWorkspaces);
  }

  private nextSnapshotId(): string {
    this.snapshotSequence += 1;
    return `${this.instanceId}:${this.snapshotSequence}`;
  }
}
