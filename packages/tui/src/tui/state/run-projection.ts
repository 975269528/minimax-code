import type { TuiQueuedMessage } from '../../types/runtime-models.js';

export interface TuiRunProjectionSnapshot {
  queuedItems: readonly TuiQueuedMessage[];
  queuedCount: number;
  queuePaused: boolean;
  queuePendingCount: number;
  queueHandoffPending: boolean;
  latestRuntimeTurnId?: string;
  stoppingRuntimeTurnId?: string;
}

export class TuiRunProjection {
  private queuedItemsValue: TuiQueuedMessage[] = [];
  private queuedCountValue = 0;
  private queuePausedValue = false;
  private queuePendingCountValue = 0;
  private queueHandoffPendingValue = false;
  private readonly queueTurnIds = new Set<string>();
  private recoveredTurnId?: string;
  private stoppingRuntimeTurnId?: string;

  snapshot(): TuiRunProjectionSnapshot {
    return {
      queuedItems: this.queuedItemsValue.map((item) => ({ ...item })),
      queuedCount: this.queuedCountValue,
      queuePaused: this.queuePausedValue,
      queuePendingCount: this.queuePendingCountValue,
      queueHandoffPending: this.queueHandoffPendingValue,
      latestRuntimeTurnId: [...this.queueTurnIds].at(-1) ?? this.recoveredTurnId,
      stoppingRuntimeTurnId: this.stoppingRuntimeTurnId,
    };
  }

  reset(): void {
    this.queuedItemsValue = [];
    this.queuedCountValue = 0;
    this.queuePausedValue = false;
    this.queuePendingCountValue = 0;
    this.queueHandoffPendingValue = false;
    this.queueTurnIds.clear();
    this.recoveredTurnId = undefined;
    this.stoppingRuntimeTurnId = undefined;
  }

  replaceQueue(
    items: readonly TuiQueuedMessage[],
    summary?: { readonly paused: boolean; readonly pendingCount: number },
  ): void {
    this.queuedItemsValue = [...items];
    this.queuedCountValue = countQueuedItems(items);
    this.queuePausedValue = summary?.paused ?? items.some((item) => item.status === 'paused');
    this.queuePendingCountValue = summary?.pendingCount ?? this.queuedCountValue;
  }

  recordEnqueued(item: TuiQueuedMessage, position?: number): void {
    const wasQueued = isPendingQueueStatus(this.findQueueItem(item.itemId)?.status);
    this.upsertQueueItem(item);
    this.queuedCountValue = Math.max(
      countQueuedItems(this.queuedItemsValue),
      this.queuedCountValue + (!wasQueued && isPendingQueueStatus(item.status) ? 1 : 0),
      position ?? 0,
    );
  }

  setQueuedCount(count: number): void {
    this.queuedCountValue = Math.max(0, count);
  }

  findQueueItem(itemId: string): TuiQueuedMessage | undefined {
    return this.queuedItemsValue.find((item) => item.itemId === itemId);
  }

  updateQueueItem(item: TuiQueuedMessage): void {
    const wasQueued = isPendingQueueStatus(this.findQueueItem(item.itemId)?.status);
    if (
      isPendingQueueStatus(item.status) ||
      item.status === 'running' ||
      item.status === 'failed'
    ) {
      this.upsertQueueItem(item);
    } else {
      this.queuedItemsValue = this.queuedItemsValue.filter(
        (candidate) => candidate.itemId !== item.itemId,
      );
    }
    const isQueued = isPendingQueueStatus(item.status);
    this.queuedCountValue = Math.max(
      countQueuedItems(this.queuedItemsValue),
      this.queuedCountValue + Number(isQueued) - Number(wasQueued),
    );
  }

  markRecoveredTurn(turnId?: string): void {
    if (turnId) this.queueHandoffPendingValue = false;
    this.recoveredTurnId = turnId;
  }

  markQueueHandoffPending(): void {
    this.queueHandoffPendingValue = true;
  }

  markQueueTurnStarted(turnId?: string): void {
    this.queueHandoffPendingValue = false;
    this.recoveredTurnId = undefined;
    if (turnId) this.queueTurnIds.add(turnId);
  }

  reconcileRuntimeTurn(turnId?: string): void {
    this.queueHandoffPendingValue = false;
    this.queueTurnIds.clear();
    this.recoveredTurnId = turnId;
    if (!turnId || (this.stoppingRuntimeTurnId && this.stoppingRuntimeTurnId !== turnId)) {
      this.stoppingRuntimeTurnId = undefined;
    }
  }

  markRuntimeTurnStopping(turnId: string): void {
    this.stoppingRuntimeTurnId = turnId;
  }

  clearRuntimeTurnStopping(turnId?: string): void {
    if (!turnId || this.stoppingRuntimeTurnId === turnId) this.stoppingRuntimeTurnId = undefined;
  }

  clearRuntimeTurn(turnId?: string): boolean {
    const deletedQueueTurn = turnId ? this.queueTurnIds.delete(turnId) : false;
    const deletedRecoveredTurn = this.recoveredTurnId !== undefined;
    this.recoveredTurnId = undefined;
    this.clearRuntimeTurnStopping(turnId);
    return deletedQueueTurn || deletedRecoveredTurn;
  }

  removeRuntimeTurn(turnId: string): void {
    this.queueTurnIds.delete(turnId);
    if (this.recoveredTurnId === turnId) this.recoveredTurnId = undefined;
    this.clearRuntimeTurnStopping(turnId);
  }

  private upsertQueueItem(item: TuiQueuedMessage): void {
    const index = this.queuedItemsValue.findIndex((candidate) => candidate.itemId === item.itemId);
    if (index < 0) {
      this.queuedItemsValue = [...this.queuedItemsValue, item];
      return;
    }
    this.queuedItemsValue = this.queuedItemsValue.map((candidate, candidateIndex) =>
      candidateIndex === index ? item : candidate,
    );
  }
}

function countQueuedItems(items: readonly TuiQueuedMessage[]): number {
  return items.filter((item) => isPendingQueueStatus(item.status)).length;
}

export function isPendingQueueStatus(status: string | undefined): boolean {
  return status === 'queued' || status === 'paused';
}
