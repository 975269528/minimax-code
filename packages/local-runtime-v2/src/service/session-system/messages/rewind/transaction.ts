import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm';

import type { AppDb } from '../../../../infra/db/client.js';
import {
  messageRows,
  sessionAssetIndexState,
  sessionAssets,
} from '../../../../infra/db/schema/messages.js';
import { tokenUsage } from '../../../../infra/db/schema/usage.js';
import type { SessionRewindCommitInput, SessionRewindCommitResult } from './contracts.js';

export function commitSessionRewind(
  db: AppDb,
  nowMs: () => number,
  input: SessionRewindCommitInput,
): SessionRewindCommitResult {
  return db.transaction(
    (tx) => {
      const target = requireTargetOrIdempotent(tx, input);
      const deletedMessageIds = target
        ? readDeletedMessageIds(tx, input.sessionId, target.id)
        : [...input.expectedDeletedMessageIds];
      assertExpectedSuffix(input, deletedMessageIds);
      if (target) {
        tx.delete(messageRows)
          .where(and(eq(messageRows.sessionId, input.sessionId), gte(messageRows.id, target.id)))
          .run();
        if (deletedMessageIds.length > 0) {
          tx.delete(sessionAssets)
            .where(
              and(
                eq(sessionAssets.sessionId, input.sessionId),
                inArray(sessionAssets.messageId, deletedMessageIds),
              ),
            )
            .run();
        }
      }
      if (input.affectedTurnIds.length > 0) {
        tx.delete(tokenUsage)
          .where(
            and(
              eq(tokenUsage.sessionId, input.sessionId),
              inArray(tokenUsage.turnId, input.affectedTurnIds),
            ),
          )
          .run();
      }
      const displayRevision = latestDisplayRevision(tx, input.sessionId);
      markAssetIndexCurrent(tx, input.sessionId, displayRevision, nowMs());
      return { deletedMessageIds, displayRevision };
    },
    { behavior: 'immediate' },
  );
}

function requireTargetOrIdempotent(db: AppDb, input: SessionRewindCommitInput) {
  if (!input.fromMessageId.startsWith('msg-user-v1-')) {
    throw new Error(`Rewind target must be a committed user message: ${input.fromMessageId}`);
  }
  const target = db
    .select({ id: messageRows.id, role: messageRows.role })
    .from(messageRows)
    .where(
      and(
        eq(messageRows.sessionId, input.sessionId),
        eq(messageRows.messageId, input.fromMessageId),
      ),
    )
    .get();
  if (target?.role === 'user') return target;
  const remaining =
    input.expectedDeletedMessageIds.length === 0
      ? undefined
      : db
          .select({ id: messageRows.id })
          .from(messageRows)
          .where(
            and(
              eq(messageRows.sessionId, input.sessionId),
              inArray(messageRows.messageId, input.expectedDeletedMessageIds),
            ),
          )
          .limit(1)
          .get();
  if (!remaining) return undefined;
  throw new Error(
    `Rewind target user message not found: ${input.sessionId}/${input.fromMessageId}`,
  );
}

function readDeletedMessageIds(db: AppDb, sessionId: string, targetId: number): string[] {
  return db
    .select({ messageId: messageRows.messageId })
    .from(messageRows)
    .where(and(eq(messageRows.sessionId, sessionId), gte(messageRows.id, targetId)))
    .orderBy(asc(messageRows.id))
    .all()
    .map(({ messageId }) => messageId);
}

function assertExpectedSuffix(
  input: SessionRewindCommitInput,
  deletedMessageIds: readonly string[],
): void {
  if (
    deletedMessageIds.length !== input.expectedDeletedMessageIds.length ||
    deletedMessageIds.some(
      (messageId, index) => messageId !== input.expectedDeletedMessageIds[index],
    )
  ) {
    throw new Error(`Display Rewind suffix changed: ${input.sessionId}/${input.fromMessageId}`);
  }
}

function latestDisplayRevision(db: AppDb, sessionId: string): number {
  return (
    db
      .select({ id: messageRows.id })
      .from(messageRows)
      .where(eq(messageRows.sessionId, sessionId))
      .orderBy(desc(messageRows.id))
      .limit(1)
      .get()?.id ?? 0
  );
}

function markAssetIndexCurrent(
  db: AppDb,
  sessionId: string,
  displayRevision: number,
  indexedAtMs: number,
): void {
  const state = {
    sessionId,
    indexVersion: 1,
    indexedThroughMessageRowId: displayRevision,
    indexedAtMs,
    status: 'ready',
    errorJson: null,
  };
  db.insert(sessionAssetIndexState)
    .values(state)
    .onConflictDoUpdate({ target: sessionAssetIndexState.sessionId, set: state })
    .run();
}
