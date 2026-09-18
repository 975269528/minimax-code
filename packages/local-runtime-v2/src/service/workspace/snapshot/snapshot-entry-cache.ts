import type { WorkspaceEntry } from './snapshot-support.js';

export function currentWorkspaceSnapshotId<TBase, TFull, TMetadata>(
  entries: Map<string, WorkspaceEntry<TBase, TFull, TMetadata>>,
  workspace: string,
): string | undefined {
  return entries.get(workspace)?.snapshotId;
}

export function isCurrentWorkspaceSnapshot<TBase, TFull, TMetadata>(
  entries: Map<string, WorkspaceEntry<TBase, TFull, TMetadata>>,
  workspace: string,
  snapshotId: string,
): boolean {
  const entry = entries.get(workspace);
  return Boolean(
    entry &&
    !entry.disposed &&
    !entry.mutating &&
    !entry.pendingValidation &&
    entry.snapshotId === snapshotId,
  );
}

export function releaseWorkspaceEntry<TBase, TFull, TMetadata>(
  entries: Map<string, WorkspaceEntry<TBase, TFull, TMetadata>>,
  workspace: string,
): boolean {
  const entry = entries.get(workspace);
  if (!entry) return false;
  entries.delete(workspace);
  disposeWorkspaceEntry(entry);
  return true;
}

export function clearWorkspaceEntries<TBase, TFull, TMetadata>(
  entries: Map<string, WorkspaceEntry<TBase, TFull, TMetadata>>,
): void {
  for (const entry of entries.values()) disposeWorkspaceEntry(entry);
  entries.clear();
}

export function evictOldestIdleWorkspaceEntry<TBase, TFull, TMetadata>(
  entries: Map<string, WorkspaceEntry<TBase, TFull, TMetadata>>,
): boolean {
  let oldest: WorkspaceEntry<TBase, TFull, TMetadata> | undefined;
  for (const entry of entries.values()) {
    if (!isIdleWorkspaceEntry(entry)) continue;
    if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry;
  }
  if (!oldest) return false;
  entries.delete(oldest.workspace);
  disposeWorkspaceEntry(oldest);
  return true;
}

export function trimIdleWorkspaceEntries<TBase, TFull, TMetadata>(
  entries: Map<string, WorkspaceEntry<TBase, TFull, TMetadata>>,
  maxWorkspaces: number,
): void {
  // Busy entries may temporarily exceed the completed-snapshot budget. Do
  // not evict a newer idle entry merely because the true LRU is still busy;
  // once that work settles, normal LRU order can be restored.
  while (countIdleWorkspaceEntries(entries) > maxWorkspaces) {
    if (!evictOldestIdleWorkspaceEntry(entries)) return;
  }
}

function disposeWorkspaceEntry<TBase, TFull, TMetadata>(
  entry: WorkspaceEntry<TBase, TFull, TMetadata>,
): void {
  if (entry.disposed) return;
  entry.disposed = true;
  const pendingValidation = entry.pendingValidation;
  entry.pendingValidation = undefined;
  pendingValidation?.resolve();
  entry.watcher?.close();
  entry.watcher = undefined;
  entry.watcherSetupPending = false;
  if (entry.changedTimer) clearTimeout(entry.changedTimer);
  entry.changedTimer = undefined;
  entry.pendingChanged = undefined;
  entry.base = undefined;
  entry.full = undefined;
  entry.metadata = undefined;
  entry.baseRequest = undefined;
  entry.fullRequest = undefined;
  entry.metadataRequest = undefined;
}

function countIdleWorkspaceEntries<TBase, TFull, TMetadata>(
  entries: Map<string, WorkspaceEntry<TBase, TFull, TMetadata>>,
): number {
  let count = 0;
  for (const entry of entries.values()) {
    if (isIdleWorkspaceEntry(entry)) count += 1;
  }
  return count;
}

function isIdleWorkspaceEntry<TBase, TFull, TMetadata>(
  entry: WorkspaceEntry<TBase, TFull, TMetadata>,
): boolean {
  return !(
    entry.mutating ||
    entry.mutationReservations > 0 ||
    entry.activeReaders > 0 ||
    entry.pendingValidation ||
    entry.pendingChanged ||
    entry.changedTimer ||
    entry.baseRequest ||
    entry.fullRequest ||
    entry.metadataRequest
  );
}
