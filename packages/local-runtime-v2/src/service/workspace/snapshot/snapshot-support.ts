export type GitChangesMode = 'fast' | 'full';
export type WorkspaceGitChangeKind = 'workspace' | 'repository';

export interface WorkspaceGitSnapshot<T> {
  snapshotId: string;
  value: T;
}

export interface WorkspaceGitChangedEvent {
  /** Canonical realpath used by the Runtime-owned snapshot entry. */
  workspace: string;
  /** Non-canonical spellings observed from callers of the same physical workspace. */
  aliases?: string[];
  snapshotId: string;
  reason: 'watcher' | 'watcher-error' | 'mutation' | 'manual';
  kind: WorkspaceGitChangeKind;
}

export interface WorkspaceGitWatchCallbacks {
  /** A raw file event arrived; completed values must not be served until classification finishes. */
  onPotentialChange(): void;
  /** The whole coalesced path batch is ignored by Git and cannot affect the snapshot. */
  onIgnoredOnly(): void;
  /** At least one path in the batch can affect Git state. */
  onChange(kind: WorkspaceGitChangeKind): void;
  /** The watcher can no longer prove that completed values are current. */
  onError(error: unknown): void;
}

export interface WorkspaceGitWatchHandle {
  close(): void;
}

export interface VersionedValue<T> {
  snapshotId: string;
  value: T;
}

export interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

export interface WorkspaceEntry<TBase, TFull, TMetadata> {
  workspace: string;
  aliases: Set<string>;
  snapshotId: string;
  base?: VersionedValue<TBase>;
  full?: VersionedValue<TFull>;
  metadata?: TMetadata;
  metadataRevision: number;
  baseRequest?: Promise<VersionedValue<TBase>>;
  fullRequest?: Promise<VersionedValue<TFull>>;
  metadataRequest?: Promise<{ revision: number; value: TMetadata }>;
  watcher?: WorkspaceGitWatchHandle;
  watcherSetup: Promise<void>;
  watcherSetupAttempts: number;
  watcherSetupPending: boolean;
  watcherHealthy: boolean;
  watcherErrorReported: boolean;
  pendingValidation?: Deferred;
  pendingChanged?: Pick<WorkspaceGitChangedEvent, 'kind' | 'reason'>;
  changedTimer?: ReturnType<typeof setTimeout>;
  mutationTail: Promise<void>;
  mutating: boolean;
  mutationObservedKind?: WorkspaceGitChangeKind;
  mutationReservations: number;
  activeReaders: number;
  readGenerationSnapshotId?: string;
  lastUsed: number;
  disposed: boolean;
}

export interface WorkspaceGitSnapshotManagerOptions<TBase, TFull, TMetadata = never> {
  loadBase: (workspace: string) => Promise<TBase>;
  loadFull: (workspace: string, base: TBase) => Promise<TFull>;
  loadMetadata?: (workspace: string) => Promise<TMetadata>;
  startWatcher?: (
    workspace: string,
    callbacks: WorkspaceGitWatchCallbacks,
  ) => Promise<WorkspaceGitWatchHandle> | WorkspaceGitWatchHandle;
  onChanged?: (event: WorkspaceGitChangedEvent) => void;
  instanceId?: string;
  maxWorkspaces?: number;
  reuseCompletedResults?: boolean;
  changeNotificationWindowMs?: number;
}

export class StaleWorkspaceGitSnapshotError extends Error {
  constructor() {
    super('Workspace Git snapshot changed while the request was running');
  }
}

export class WorkspaceGitSnapshotManagerClosedError extends Error {
  constructor() {
    super('Workspace Git snapshot manager is closed');
  }
}

export class WorkspaceGitSnapshotReleasedError extends Error {
  constructor() {
    super('Workspace Git snapshot was released');
  }
}

export function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function mergeChangedEvent(
  current: Pick<WorkspaceGitChangedEvent, 'kind' | 'reason'> | undefined,
  next: Pick<WorkspaceGitChangedEvent, 'kind' | 'reason'>,
): Pick<WorkspaceGitChangedEvent, 'kind' | 'reason'> {
  if (!current) return next;
  const kind =
    current.kind === 'repository' || next.kind === 'repository' ? 'repository' : 'workspace';
  const reasonPriority: Record<WorkspaceGitChangedEvent['reason'], number> = {
    watcher: 0,
    manual: 1,
    mutation: 2,
    'watcher-error': 3,
  };
  const reason =
    reasonPriority[next.reason] > reasonPriority[current.reason] ? next.reason : current.reason;
  return { kind, reason };
}

export function publishWorkspaceGitChanged<TBase, TFull, TMetadata>(options: {
  entry: WorkspaceEntry<TBase, TFull, TMetadata>;
  kind: WorkspaceGitChangeKind;
  reason: WorkspaceGitChangedEvent['reason'];
  onChanged: ((event: WorkspaceGitChangedEvent) => void) | undefined;
  notificationWindowMs: number;
  isCurrent: () => boolean;
}): void {
  const { entry, kind, reason, onChanged, notificationWindowMs, isCurrent } = options;
  if (!onChanged || !isCurrent()) return;
  const emit = (nextKind: WorkspaceGitChangeKind, nextReason: WorkspaceGitChangedEvent['reason']) =>
    onChanged({
      workspace: entry.workspace,
      ...(entry.aliases.size > 0 ? { aliases: [...entry.aliases] } : {}),
      snapshotId: entry.snapshotId,
      kind: nextKind,
      reason: nextReason,
    });
  if (notificationWindowMs === 0) {
    emit(kind, reason);
    return;
  }
  entry.pendingChanged = mergeChangedEvent(entry.pendingChanged, { kind, reason });
  entry.changedTimer ??= setTimeout(() => {
    entry.changedTimer = undefined;
    const pending = entry.pendingChanged;
    entry.pendingChanged = undefined;
    if (pending && isCurrent()) emit(pending.kind, pending.reason);
  }, notificationWindowMs);
}
