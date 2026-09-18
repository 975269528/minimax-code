import { digestThreadGoalObjective, type ThreadGoalState } from '@mavis/goal';

import type { LocalMessageAttachment, LocalMessageInput } from '../messages/input.js';
import type { LocalQueuedMessage } from '../messages/queue.js';

export const THREAD_GOAL_KICKOFF_PREFIX = 'thread-goal-kickoff:';
export const THREAD_GOAL_KICKOFF_ORIGIN_TYPE = 'thread-goal-kickoff';
export const THREAD_GOAL_CONTINUATION_PREFIX = 'thread-goal-followup:';
export const THREAD_GOAL_CONTINUATION_ORIGIN_TYPE = 'thread-goal-continuation';

export interface ThreadGoalKickoffOrigin {
  type: typeof THREAD_GOAL_KICKOFF_ORIGIN_TYPE;
  goalId: string;
  goalUpdatedAt: number;
  objectiveDigest: string;
  displayContent: string;
}

export type ThreadGoalContinuationKind = 'active' | 'budget-limit';

export interface ThreadGoalContinuationOrigin {
  type: typeof THREAD_GOAL_CONTINUATION_ORIGIN_TYPE;
  goalId: string;
  goalUpdatedAt: number;
  objectiveDigest: string;
  kind: ThreadGoalContinuationKind;
}

export type ThreadGoalQueueItemIdentity = Pick<
  LocalQueuedMessage,
  'sessionId' | 'clientRequestId'
> & {
  readonly message: { readonly origin?: unknown };
};

export function threadGoalKickoffClientRequestId(goalId: string): string {
  return `${THREAD_GOAL_KICKOFF_PREFIX}${goalId}`;
}

export function threadGoalContinuationClientRequestId(turnId: string): string {
  return `${THREAD_GOAL_CONTINUATION_PREFIX}${turnId}`;
}

export function threadGoalRecoveryClientRequestId(
  goal: Pick<ThreadGoalState, 'goalId' | 'updatedAt'>,
): string {
  return threadGoalContinuationClientRequestId(`recovery:${goal.goalId}:${goal.updatedAt}`);
}

/**
 * Idempotency key for a re-armed follow-up, scoped to the Goal epoch it is
 * rebuilt at.
 *
 * A re-arm rebuilds from the settling Turn, so the default
 * `thread-goal-followup:<turnId>` key belongs to the epoch that was just
 * invalidated. Reusing it makes the Queue dedupe the new follow-up onto the
 * stale row, which is then cancelled for being stale — the Goal stops. Keying
 * by Goal id and epoch keeps retries of the same rebuild idempotent while a
 * genuinely new epoch gets its own admissible row.
 */
export function threadGoalRearmClientRequestId(
  goal: Pick<ThreadGoalState, 'goalId' | 'updatedAt'>,
): string {
  return threadGoalContinuationClientRequestId(`rearm:${goal.goalId}:${goal.updatedAt}`);
}

/** Stable across restart; a later re-arm receives a new Goal epoch. */
export function threadGoalBudgetLimitClientRequestId(
  goal: Pick<ThreadGoalState, 'goalId' | 'updatedAt'>,
): string {
  return threadGoalContinuationClientRequestId(`budget-limit:${goal.goalId}:${goal.updatedAt}`);
}

export function buildThreadGoalKickoffMessage(
  goal: ThreadGoalState,
  content: string,
  attachments: LocalMessageAttachment[] = [],
): LocalMessageInput {
  return {
    content,
    attachments: [...attachments, ...(goal.objectiveResources ?? [])],
    source: 'thread-goal',
    origin: {
      type: THREAD_GOAL_KICKOFF_ORIGIN_TYPE,
      goalId: goal.goalId,
      goalUpdatedAt: goal.updatedAt,
      objectiveDigest: digestThreadGoalObjective(goal.objective),
      displayContent: goal.objective,
    } satisfies ThreadGoalKickoffOrigin,
  };
}

/**
 * Continuation turns intentionally carry no attachments: the kickoff message
 * already pushed objective resources once, and every later turn can pull them
 * on demand via `get_goal` (`objective_resources` file paths), which the
 * recovery prompt and the periodic terminal audit already instruct the worker
 * to call. Re-attaching screenshots here would resend every image on every
 * continuation turn.
 */
export function buildThreadGoalContinuationMessage(
  goal: Pick<ThreadGoalState, 'goalId' | 'updatedAt' | 'objective'>,
  content: string,
  kind: ThreadGoalContinuationKind,
): LocalMessageInput {
  return {
    content,
    attachments: [],
    origin: {
      type: THREAD_GOAL_CONTINUATION_ORIGIN_TYPE,
      goalId: goal.goalId,
      goalUpdatedAt: goal.updatedAt,
      objectiveDigest: digestThreadGoalObjective(goal.objective),
      kind,
    } satisfies ThreadGoalContinuationOrigin,
  };
}

export function readThreadGoalKickoffOrigin(value: unknown): ThreadGoalKickoffOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type !== THREAD_GOAL_KICKOFF_ORIGIN_TYPE) return undefined;
  if (
    typeof record.goalId !== 'string' ||
    typeof record.displayContent !== 'string' ||
    typeof record.objectiveDigest !== 'string' ||
    !isUnixMs(record.goalUpdatedAt)
  ) {
    return undefined;
  }
  return {
    type: THREAD_GOAL_KICKOFF_ORIGIN_TYPE,
    goalId: record.goalId,
    goalUpdatedAt: record.goalUpdatedAt,
    objectiveDigest: record.objectiveDigest,
    displayContent: record.displayContent,
  };
}

/**
 * Queue/UI compatibility for kickoff items persisted before admission metadata
 * was added. This intentionally does not make the strict reader above accept
 * an incomplete identity: old items remain fenced as Goal work, then fail
 * closed when the dispatcher asks for a trusted admission origin.
 */
export function readThreadGoalKickoffDisplayContent(value: unknown): string | undefined {
  const record = readOriginRecord(value, THREAD_GOAL_KICKOFF_ORIGIN_TYPE);
  return typeof record?.displayContent === 'string' ? record.displayContent : undefined;
}

export function readThreadGoalContinuationOrigin(
  value: unknown,
): ThreadGoalContinuationOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type !== THREAD_GOAL_CONTINUATION_ORIGIN_TYPE) return undefined;
  if (typeof record.goalId !== 'string' || record.goalId.length === 0) return undefined;
  if (!isUnixMs(record.goalUpdatedAt) || typeof record.objectiveDigest !== 'string') {
    return undefined;
  }
  if (record.kind !== 'active' && record.kind !== 'budget-limit') return undefined;
  return {
    type: THREAD_GOAL_CONTINUATION_ORIGIN_TYPE,
    goalId: record.goalId,
    goalUpdatedAt: record.goalUpdatedAt,
    objectiveDigest: record.objectiveDigest,
    kind: record.kind,
  };
}

function isUnixMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isThreadGoalKickoffQueueItem(
  item: Pick<ThreadGoalQueueItemIdentity, 'clientRequestId' | 'message'>,
): boolean {
  return (
    item.clientRequestId?.startsWith(THREAD_GOAL_KICKOFF_PREFIX) === true ||
    readOriginRecord(item.message.origin, THREAD_GOAL_KICKOFF_ORIGIN_TYPE) !== undefined
  );
}

export function isThreadGoalContinuationQueueItem(
  item: Pick<ThreadGoalQueueItemIdentity, 'clientRequestId' | 'message'>,
): boolean {
  return (
    item.clientRequestId?.startsWith(THREAD_GOAL_CONTINUATION_PREFIX) === true ||
    readOriginRecord(item.message.origin, THREAD_GOAL_CONTINUATION_ORIGIN_TYPE) !== undefined
  );
}

function readOriginRecord(
  value: unknown,
  type: typeof THREAD_GOAL_KICKOFF_ORIGIN_TYPE | typeof THREAD_GOAL_CONTINUATION_ORIGIN_TYPE,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return record.type === type ? record : undefined;
}
