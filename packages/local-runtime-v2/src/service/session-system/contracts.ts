import type { AppDb } from '../../infra/db/client.js';
import type {
  QueueCommittedFact,
  QueueAdmissionRejectionReason,
  QueueClaimConsumeReason,
  QueueClaimRecoveryScope,
  QueueItem,
  QueueMessageInput,
  QueueMessageSource,
  QueuePause,
  QueueRoutingProvenance,
} from './queue/repo/contract.js';
import type { SessionRecord } from './sessions/repo/contract.js';

/**
 * Stable SessionSystem read capability for accepted execution owners.
 *
 * Consumers read the current Session by identity when execution begins; they
 * do not receive a caller-captured execution snapshot or access persistence
 * internals.
 */
export interface SessionSystemReadCapability {
  get(sessionId: string): Promise<SessionRecord | undefined>;
}

/**
 * Queue rows that gave up their FIFO position for this claim.
 *
 * GOAL-05: skipping a blocked autonomous item at claim selection is only half
 * the yield. The admitting transaction fences the claim against every older
 * queued row, so without carrying the same fact the yielded row would still
 * block the work it just stepped aside for. The list is the exact set the
 * selection policy approved for this pass — it exempts those identities and
 * nothing else, and it never relaxes QueuePaused or any other gate.
 */
export type YieldedQueueItemIds = readonly string[];

export type TurnAdmissionPriority =
  | {
      readonly kind: 'fifo';
      readonly candidateCreatedAtMs: number;
      readonly queueClaimId?: string;
      readonly yieldedQueueItemIds?: YieldedQueueItemIds;
    }
  | {
      readonly kind: 'continued-queue-head';
      readonly queueClaimId: string;
      readonly yieldedQueueItemIds?: YieldedQueueItemIds;
    }
  | { readonly kind: 'selected-queue-item'; readonly queueClaimId: string }
  | { readonly kind: 'retry-continuation' }
  | { readonly kind: 'paused-queue-send' }
  | { readonly kind: 'user-input-resume' }
  | { readonly kind: 'turn-continuation' };

/**
 * Session-owned ordering decision used by Turn admission in the same SQLite
 * transaction as the lease and receipt writes.
 *
 * TODO(session-system): bind this contract to Queue row order. The Turn owner
 * must not inspect Queue tables or infer priority from the submission source.
 */
export interface TurnAdmissionPriorityFence {
  blocksInTransaction(
    db: AppDb,
    input: {
      readonly sessionId: string;
      readonly priority: TurnAdmissionPriority;
    },
  ): boolean;
  acceptedInTransaction(
    db: AppDb,
    input: {
      readonly sessionId: string;
      readonly consumeQueuePause: boolean;
    },
  ): {
    readonly facts: readonly QueueCommittedFact[];
    readonly revokeToken?: QueuePause;
  };
  settledInTransaction(
    db: AppDb,
    input: {
      readonly sessionId: string;
      readonly triggerTurnId: string;
      readonly cause?: import('./queue/repo/contract.js').QueuePauseCause;
      readonly pausedAtMs: number;
    },
  ): readonly QueueCommittedFact[];
  revokedInTransaction(
    db: AppDb,
    input: {
      readonly sessionId: string;
      readonly revokeToken?: QueuePause;
      readonly restoredAtMs: number;
    },
  ): readonly QueueCommittedFact[];
  publishCommitted(facts: readonly QueueCommittedFact[]): void;
}

/**
 * Session-owned Queue dispatch seam. Its implementation wraps Queue storage,
 * committed facts and exact claim acknowledgement; Turn never sees the repo.
 *
 * TODO(session-system): bind this facade to the existing Queue repository and
 * claim-recovery implementation when production composition is enabled.
 */
export interface QueueDispatchCapability {
  listPendingSessionIds(): Promise<readonly string[]>;
  claimNext(input: {
    readonly sessionId: string;
    readonly itemId?: string;
    readonly continuePaused?: true;
    /** FIFO selection skips these items for this claim only. */
    readonly excludeItemIds?: readonly string[];
  }): Promise<QueueDispatchClaim | undefined>;
  prepareDelivery(input: {
    readonly sessionId: string;
    readonly claimId: string;
    readonly turnId: string;
  }): Promise<void>;
  acknowledge(input: {
    readonly sessionId: string;
    readonly claimId: string;
    readonly turnId: string;
  }): Promise<void>;
  release(input: {
    readonly sessionId: string;
    readonly claimId: string;
    readonly reason?: QueueAdmissionRejectionReason;
  }): Promise<void>;
  cancelClaim(input: { readonly sessionId: string; readonly claimId: string }): Promise<void>;
  consume(input: {
    readonly sessionId: string;
    readonly claimId: string;
    readonly reason: QueueClaimConsumeReason;
  }): Promise<void>;
  reject(input: {
    readonly sessionId: string;
    readonly claimId: string;
    readonly reason: QueueAdmissionRejectionReason;
  }): Promise<void>;
  recoverClaims(sessionId: string, scope?: QueueClaimRecoveryScope): Promise<void>;
}

export interface QueueDispatchClaim {
  readonly claimId: string;
  readonly sessionId: string;
  readonly source: QueueMessageSource;
  readonly claimOwnerId: string;
  readonly claimLeaseExpiresAt: number;
  readonly selection: 'fifo' | 'exact' | 'continued-fifo';
  readonly item: QueueItem;
  readonly message: QueueMessageInput;
  readonly clientRequestId?: string;
  readonly provenance: QueueRoutingProvenance;
}

export * from './sessions/repo/contract.js';
export * from './sessions/representation/canonical-history-contract.js';
export * from './usage/repo/contract.js';
export * from './projects/repo/contract.js';
export * from './files/repo/contract.js';
export * from './messages/repo/contract.js';
export * from './queue/repo/contract.js';
export * from './legacy-migration/repo/contract.js';
