import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  lt,
  min,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';

import type { AppDb } from '../../../infra/db/client.js';
import { queueItems, queuePauses } from '../../../infra/db/schema/queue.js';
import type { TurnAdmissionPriority, TurnAdmissionPriorityFence } from '../contracts.js';
import type { QueueCommittedFactSink } from './committed-service.js';
import type { QueuePause } from './repo/contract.js';

/**
 * Gives already-enqueued work priority without leaking Queue persistence into
 * TurnSystem. Exact Queue claims and explicit retry continuations bypass the
 * durable Pause; ordinary candidates are fenced by Queue order.
 */
export function createQueueTurnAdmissionPriorityFence(
  options: {
    readonly facts?: QueueCommittedFactSink;
  } = {},
): TurnAdmissionPriorityFence {
  return {
    blocksInTransaction: blocksQueueCandidate,
    acceptedInTransaction: (db, input) => {
      if (!input.consumeQueuePause) return { facts: [] };
      const row = db
        .select()
        .from(queuePauses)
        .where(eq(queuePauses.sessionId, input.sessionId))
        .get();
      if (!row) return { facts: [] };
      db.delete(queuePauses).where(eq(queuePauses.sessionId, input.sessionId)).run();
      const revokeToken: QueuePause = {
        cause: row.cause as QueuePause['cause'],
        triggerTurnId: row.triggerTurnId,
        pausedAtMs: row.pausedAtMs,
      };
      return {
        revokeToken,
        facts: [
          {
            kind: 'execution-state-changed',
            sessionId: input.sessionId,
            paused: false,
          },
        ],
      };
    },
    settledInTransaction: (db, input) => {
      if (!input.cause) return [];
      const pendingCount =
        db
          .select({ total: sql<number>`count(*)`.mapWith(Number) })
          .from(queueItems)
          .where(
            and(
              eq(queueItems.sessionId, input.sessionId),
              inArray(queueItems.status, ['queued', 'claimed']),
              or(
                eq(queueItems.status, 'claimed'),
                isNull(queueItems.expiresAtMs),
                gt(queueItems.expiresAtMs, input.pausedAtMs),
              ),
            ),
          )
          .get()?.total ?? 0;
      if (pendingCount === 0) return [];
      const recorded =
        db
          .insert(queuePauses)
          .values({
            sessionId: input.sessionId,
            cause: input.cause,
            triggerTurnId: input.triggerTurnId,
            pausedAtMs: input.pausedAtMs,
          })
          .onConflictDoUpdate({
            target: queuePauses.sessionId,
            set: {
              cause: input.cause,
              triggerTurnId: input.triggerTurnId,
              pausedAtMs: input.pausedAtMs,
            },
          })
          .run().changes === 1;
      return recorded
        ? [
            {
              kind: 'execution-state-changed',
              sessionId: input.sessionId,
              paused: true,
            },
          ]
        : [];
    },
    revokedInTransaction: (db, input) => {
      if (!input.revokeToken) return [];
      const pending = Boolean(
        db
          .select({ id: queueItems.id })
          .from(queueItems)
          .where(
            and(
              eq(queueItems.sessionId, input.sessionId),
              inArray(queueItems.status, ['queued', 'claimed']),
              or(
                eq(queueItems.status, 'claimed'),
                isNull(queueItems.expiresAtMs),
                gt(queueItems.expiresAtMs, input.restoredAtMs),
              ),
            ),
          )
          .limit(1)
          .get(),
      );
      if (!pending) return [];
      const inserted =
        db
          .insert(queuePauses)
          .values({
            sessionId: input.sessionId,
            cause: input.revokeToken.cause,
            triggerTurnId: input.revokeToken.triggerTurnId,
            pausedAtMs: input.revokeToken.pausedAtMs,
          })
          .onConflictDoNothing({ target: queuePauses.sessionId })
          .run().changes === 1;
      return inserted
        ? [
            {
              kind: 'execution-state-changed',
              sessionId: input.sessionId,
              paused: true,
            },
          ]
        : [];
    },
    publishCommitted: (facts) => options.facts?.handle(facts),
  };
}

function blocksQueueCandidate(
  db: AppDb,
  input: {
    readonly sessionId: string;
    readonly priority: TurnAdmissionPriority;
  },
): boolean {
  const paused = Boolean(
    db
      .select({ sessionId: queuePauses.sessionId })
      .from(queuePauses)
      .where(eq(queuePauses.sessionId, input.sessionId))
      .limit(1)
      .get(),
  );
  if (paused && !bypassesQueuePause(input.priority)) return true;
  if (bypassesQueueOrder(input.priority)) return false;
  const queueClaimId = 'queueClaimId' in input.priority ? input.priority.queueClaimId : undefined;
  if (queueClaimId) {
    return claimedQueueItemBlocks(db, input.sessionId, input.priority, queueClaimId);
  }
  if (input.priority.kind === 'selected-queue-item') return true;
  if (input.priority.kind === 'continued-queue-head') return true;
  return Boolean(
    db
      .select({ id: queueItems.id })
      .from(queueItems)
      .where(
        and(
          eq(queueItems.sessionId, input.sessionId),
          inArray(queueItems.status, ['queued', 'claimed']),
          lte(queueItems.createdAtMs, input.priority.candidateCreatedAtMs),
        ),
      )
      .orderBy(asc(queueItems.id))
      .limit(1)
      .get(),
  );
}

function claimedQueueItemBlocks(
  db: AppDb,
  sessionId: string,
  priority: Extract<
    TurnAdmissionPriority,
    { readonly kind: 'fifo' | 'continued-queue-head' | 'selected-queue-item' }
  >,
  queueClaimId: string,
): boolean {
  const firstClaimedId = db
    .select({ id: min(queueItems.id) })
    .from(queueItems)
    .where(
      and(
        eq(queueItems.sessionId, sessionId),
        eq(queueItems.claimId, queueClaimId),
        eq(queueItems.status, 'claimed'),
      ),
    )
    .get()?.id;
  if (firstClaimedId === null || firstClaimedId === undefined) return true;
  if (priority.kind === 'selected-queue-item') return false;
  // Rows that yielded their position for this very claim are not blockers.
  // They keep their queue position and identity; only this admission ignores
  // them, and only because the selection policy already approved the yield.
  const yieldedItemIds =
    'yieldedQueueItemIds' in priority ? (priority.yieldedQueueItemIds ?? []) : [];
  return Boolean(
    db
      .select({ id: queueItems.id })
      .from(queueItems)
      .where(
        and(
          eq(queueItems.sessionId, sessionId),
          inArray(queueItems.status, ['queued', 'claimed']),
          lt(queueItems.id, firstClaimedId),
          ...(yieldedItemIds.length > 0
            ? [notInArray(queueItems.itemId, [...yieldedItemIds])]
            : []),
        ),
      )
      .orderBy(asc(queueItems.id))
      .limit(1)
      .get(),
  );
}

function bypassesQueuePause(priority: TurnAdmissionPriority): boolean {
  return (
    priority.kind === 'continued-queue-head' ||
    priority.kind === 'selected-queue-item' ||
    priority.kind === 'retry-continuation' ||
    priority.kind === 'turn-continuation' ||
    priority.kind === 'paused-queue-send' ||
    priority.kind === 'user-input-resume'
  );
}

function bypassesQueueOrder(
  priority: TurnAdmissionPriority,
): priority is Extract<
  TurnAdmissionPriority,
  {
    readonly kind:
      | 'retry-continuation'
      | 'turn-continuation'
      | 'paused-queue-send'
      | 'user-input-resume';
  }
> {
  return (
    priority.kind === 'retry-continuation' ||
    priority.kind === 'turn-continuation' ||
    priority.kind === 'paused-queue-send' ||
    priority.kind === 'user-input-resume'
  );
}
