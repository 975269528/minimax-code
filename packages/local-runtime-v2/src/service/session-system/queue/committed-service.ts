import type {
  QueueEnqueueInput,
  QueueEnqueueResult,
  QueueExecutionSnapshot,
  QueueItem,
  QueueMessageSource,
  QueuePause,
  QueuePauseInput,
  QueueReorderInput,
  QueueUpdateInput,
} from './repo/contract.js';
import type { QueueService, QueueSessionRecord } from './service.js';
import type { QueueCommittedFact } from './types.js';

export interface QueueCommittedFactSink {
  handle(facts: readonly QueueCommittedFact[]): void;
}

export interface CommittedQueueServiceOptions {
  readonly queue: QueueService;
  readonly facts: QueueCommittedFactSink;
}

export interface QueueCancellationResult extends QueueItem {
  readonly removedAtMs: number;
}

export interface CommittedQueueCapability {
  /** Sessions with queued or claimed durable items; used only for bounded recovery. */
  listPendingSessionIds(): Promise<readonly string[]>;
  snapshot(sessionId: string): Promise<QueueExecutionSnapshot>;
  continueQueue(sessionId: string, expectedPause?: QueuePause): Promise<QueueExecutionSnapshot>;
  /** Writes the pause only while pending items exist; used by Stop-shaped owners. */
  pauseIfPending(input: QueuePauseInput): Promise<QueueExecutionSnapshot>;
  /** Composer-visible queued items; claimed execution items are omitted. */
  list(sessionId: string): Promise<QueueItem[]>;
  /** Exact idempotency lookup includes queued and claimed items. */
  findByClientRequestId(sessionId: string, clientRequestId: string): Promise<QueueItem | undefined>;
  /** Exact lookup includes claimed items so in-flight state is distinguishable from absence. */
  get(sessionId: string, itemId: string): Promise<QueueItem | undefined>;
  enqueue(input: QueueEnqueueInput): Promise<QueueEnqueueResult | undefined>;
  update(input: QueueUpdateInput): Promise<QueueItem | 'invalid' | 'not_editable' | undefined>;
  promote(
    sessionId: string,
    itemId: string,
    source: QueueMessageSource,
  ): Promise<QueueItem | 'not_editable' | undefined>;
  cancel(
    sessionId: string,
    itemId: string,
  ): Promise<QueueCancellationResult | 'not_editable' | undefined>;
  clearUserManageable(sessionId: string): Promise<QueueItem[]>;
  reorder(input: QueueReorderInput): Promise<QueueItem[] | 'invalid'>;
  deleteSession(sessionId: string): Promise<void>;
  requireMutableSession(sessionId: string): Promise<QueueSessionRecord>;
}

export class CommittedQueueService implements CommittedQueueCapability {
  constructor(private readonly options: CommittedQueueServiceOptions) {}

  listPendingSessionIds(): Promise<readonly string[]> {
    return this.options.queue.listPendingSessionIds();
  }

  snapshot(sessionId: string): Promise<QueueExecutionSnapshot> {
    return this.consume(this.options.queue.snapshot(sessionId));
  }

  continueQueue(sessionId: string, expectedPause?: QueuePause): Promise<QueueExecutionSnapshot> {
    return this.consume(this.options.queue.continueQueue(sessionId, expectedPause));
  }

  pauseIfPending(input: QueuePauseInput): Promise<QueueExecutionSnapshot> {
    return this.consume(this.options.queue.pauseIfPending(input));
  }

  list(sessionId: string): Promise<QueueItem[]> {
    return this.consume(this.options.queue.list(sessionId));
  }

  findByClientRequestId(
    sessionId: string,
    clientRequestId: string,
  ): Promise<QueueItem | undefined> {
    return this.consume(this.options.queue.findByClientRequestId(sessionId, clientRequestId));
  }

  get(sessionId: string, itemId: string): Promise<QueueItem | undefined> {
    return this.consume(this.options.queue.get(sessionId, itemId));
  }

  enqueue(input: QueueEnqueueInput): Promise<QueueEnqueueResult | undefined> {
    return this.consume(this.options.queue.enqueue(input));
  }

  update(input: QueueUpdateInput): Promise<QueueItem | 'invalid' | 'not_editable' | undefined> {
    return this.consume(this.options.queue.update(input));
  }

  promote(
    sessionId: string,
    itemId: string,
    source: QueueMessageSource,
  ): Promise<QueueItem | 'not_editable' | undefined> {
    return this.consume(this.options.queue.promote(sessionId, itemId, source));
  }

  async cancel(
    sessionId: string,
    itemId: string,
  ): Promise<QueueCancellationResult | 'not_editable' | undefined> {
    const result = await this.options.queue.cancel(sessionId, itemId);
    this.options.facts.handle(result.facts);
    const value = result.value;
    if (!value || value === 'not_editable') return value;
    const removal = result.facts.find(
      (fact) =>
        fact.kind === 'removed' && fact.itemId === value.itemId && fact.reason === 'cancelled',
    );
    if (!removal || removal.kind !== 'removed') {
      throw new Error(`Queue cancellation did not emit a removal fact: ${sessionId}/${itemId}`);
    }
    return { ...value, removedAtMs: removal.removedAtMs };
  }

  clearUserManageable(sessionId: string): Promise<QueueItem[]> {
    return this.consume(this.options.queue.clearUserManageable(sessionId));
  }

  reorder(input: QueueReorderInput): Promise<QueueItem[] | 'invalid'> {
    return this.consume(this.options.queue.reorder(input));
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.consume(this.options.queue.deleteSession(sessionId));
  }

  requireMutableSession(sessionId: string): Promise<QueueSessionRecord> {
    return this.options.queue.requireMutableSession(sessionId);
  }

  private async consume<T>(
    operation: Promise<{
      readonly value: T;
      readonly facts: readonly QueueCommittedFact[];
    }>,
  ): Promise<T> {
    const result = await operation;
    this.options.facts.handle(result.facts);
    return result.value;
  }
}
