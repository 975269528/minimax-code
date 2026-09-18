import type { LocalMessageChannelContext, LocalMessageInput } from './input.js';
import type { LocalModelOverride } from '../model-provider/model-selection.js';
import type { LocalQueuedMessageSource } from './queue-source.js';

export type LocalQueuedMessageStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled'
  | 'injected';

export interface LocalQueuedMessage {
  itemId: string;
  sessionId: string;
  agentName: string;
  source: LocalQueuedMessageSource;
  status: LocalQueuedMessageStatus;
  message: LocalMessageInput;
  /**
   * Persisted channel origin (raised from `message.channelContext` at enqueue time).
   * Stays on the queue item across runtime restarts so the idle-drain can
   * locate the originating IM binding even after a `replaceQueue` + reload
   * round-trip via the SQLite blob.
   */
  channelContext?: LocalMessageChannelContext;
  model?: LocalModelOverride;
  turnId?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  failedReason?: string;
  /** Idempotency key from the public session queue API. */
  clientRequestId?: string;
  /** Latest-wins key: a new queued item with the same key replaces the old one. */
  dedupeKey?: string;
  /** Unix ms after which a still-queued item is harvested as 'expired'. */
  expiresAt?: number;
}

export interface LocalEnqueueOptions {
  source?: LocalQueuedMessageSource;
  clientRequestId?: string;
  dedupeKey?: string;
  expiresAt?: number;
}

/** Compatibility port consumed by shared channel and cron adapters. V2 owns queue storage. */
export interface LocalMessageQueueStore {
  list(sessionId: string): Promise<LocalQueuedMessage[]>;

  find(sessionId: string, itemId: string): Promise<LocalQueuedMessage | undefined>;

  enqueue(
    session: { sessionId: string; agentName: string },
    body: Record<string, unknown>,
    options?: LocalEnqueueOptions,
  ): Promise<LocalQueuedMessage | undefined>;

  claimSource(
    sessionId: string,
    itemId: string,
    source: LocalQueuedMessageSource,
  ): Promise<LocalQueuedMessage | 'not_editable' | undefined>;

  update(
    sessionId: string,
    itemId: string,
    body: Record<string, unknown>,
  ): Promise<LocalQueuedMessage | 'invalid' | 'not_editable' | undefined>;

  cancel(
    sessionId: string,
    itemId: string,
  ): Promise<LocalQueuedMessage | 'not_editable' | undefined>;

  reorder(
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<LocalQueuedMessage[] | 'invalid'>;

  startDrain(sessionId: string, itemIds: string[]): Promise<void>;

  finishDrain(sessionId: string, itemIds: string[], status: string): Promise<void>;

  drainInjectable(sessionId: string): Promise<LocalQueuedMessage[]>;

  deleteSession(sessionId: string): Promise<void>;
}
