import type {
  ThreadGoalBreakerCause,
  ThreadGoalBreakerInput,
  ThreadGoalBreakerResult,
  ThreadGoalStatus,
  ThreadGoalStatusReason,
} from '@mavis/goal';

import type { DatabaseLike } from '../persistence/db.js';
import { rowToThreadGoalState, type ThreadGoalDbRow } from './store-row.js';

type BreakerAction = 'none' | 'nudge' | 'pause';

/**
 * Both breaker conditions share one occurrence ladder: the first observation is
 * only recorded, the second nudges, and the configured limit pauses. `limit` is
 * expressed as a total count of observations, so a limit of 3 pauses on the
 * third one.
 */
function decideAction(occurrences: number, limit: number): BreakerAction {
  if (occurrences >= limit) return 'pause';
  return occurrences >= 2 ? 'nudge' : 'none';
}

function strongerAction(left: BreakerAction, right: BreakerAction): BreakerAction {
  if (left === 'pause' || right === 'pause') return 'pause';
  if (left === 'nudge' || right === 'nudge') return 'nudge';
  return 'none';
}

/**
 * Apply the repeated-reply and no-tool decisions plus an optional pause in one
 * short transaction.
 *
 * The two counters are independent: an identical reply never increments the
 * no-tool streak and a tool-less turn never increments the repeated-reply
 * streak. They only share the configured limit and the `paused(no_progress)`
 * outcome.
 */
export function updateThreadGoalBreaker(
  db: DatabaseLike,
  nowMs: () => number,
  goalId: string,
  input: ThreadGoalBreakerInput,
): ThreadGoalBreakerResult {
  const apply = (): ThreadGoalBreakerResult => {
    const existing = db
      .prepare(`SELECT * FROM local_runtime_thread_goals WHERE goal_id = ?`)
      .get(goalId) as ThreadGoalDbRow | undefined;
    const state = rowToThreadGoalState(existing);
    if (!state) return { action: 'stale', staleReason: 'missing_goal' };

    const occurrenceLimit = Number.isFinite(input.limit) ? Math.max(2, Math.floor(input.limit)) : 2;

    // Repeated-reply condition. A Turn without usable reply text carries no
    // fingerprint evidence at all, so it leaves both the stored fingerprint and
    // its streak exactly as they were instead of clearing them.
    const scoresReply = input.fingerprint !== null;
    const repeated = scoresReply && state.replyFingerprint === input.fingerprint;
    const nextReplyStreak = scoresReply
      ? repeated
        ? state.noProgressStreak + 1
        : 0
      : state.noProgressStreak;
    const nextFingerprint = scoresReply ? input.fingerprint : state.replyFingerprint;
    // noProgressStreak intentionally stores repeats *after* the first reply,
    // while repeatedReplyLimit is expressed as total identical replies. Add
    // the baseline back before comparing so a limit of 3 pauses on reply 3,
    // not on the third repeat (reply 4).
    const replyOccurrences = nextReplyStreak + 1;
    const replyAction: BreakerAction = repeated
      ? decideAction(replyOccurrences, occurrenceLimit)
      : 'none';

    // No-tool condition. `unknown` is an observation gap, not a trustworthy
    // zero: it resets so a gap can never be stitched into a consecutive run.
    const nextNoToolStreak = input.toolActivity === 'absent' ? state.noToolStreak + 1 : 0;
    const noToolAction: BreakerAction =
      input.toolActivity === 'absent' ? decideAction(nextNoToolStreak, occurrenceLimit) : 'none';

    const action = strongerAction(replyAction, noToolAction);
    const cause: ThreadGoalBreakerCause | undefined =
      action === 'none' ? undefined : replyAction === action ? 'repeated_reply' : 'no_tool';

    const unchanged =
      action === 'none' &&
      nextFingerprint === state.replyFingerprint &&
      nextReplyStreak === state.noProgressStreak &&
      nextNoToolStreak === state.noToolStreak;
    if (unchanged) {
      // Nothing to persist, so skip the write and leave the decision epoch
      // alone. The caller's epoch is still validated here: returning a newer
      // epoch would let this settled Turn commit a terminal proposal on top of
      // a concurrent user PATCH that should have invalidated it.
      if (state.updatedAt !== input.expectedEpoch) {
        return { action: 'stale', staleReason: 'goal_epoch', goal: state };
      }
      if (state.status !== 'active') {
        return { action: 'stale', staleReason: 'goal_status', goal: state };
      }
      return { action: 'none', epoch: state.updatedAt, goal: state };
    }

    const nextStatus: ThreadGoalStatus = action === 'pause' ? 'paused' : state.status;
    const nextStatusReason: ThreadGoalStatusReason | null =
      action === 'pause' ? (input.pauseReason ?? 'paused(no_progress)') : state.statusReason;
    const nextEpoch = Math.max(nowMs(), state.updatedAt + 1);
    const result = db
      .prepare(
        `UPDATE local_runtime_thread_goals
         SET reply_fingerprint = ?, no_progress_streak = ?, no_tool_streak = ?, status = ?,
             status_reason = ?, updated_at_ms = ?
         WHERE goal_id = ? AND updated_at_ms = ? AND status = 'active'`,
      )
      .run(
        nextFingerprint,
        nextReplyStreak,
        nextNoToolStreak,
        nextStatus,
        nextStatusReason,
        nextEpoch,
        goalId,
        input.expectedEpoch,
      ) as { changes?: number };

    if ((result.changes ?? 0) === 0) {
      const latest = db
        .prepare(`SELECT * FROM local_runtime_thread_goals WHERE goal_id = ?`)
        .get(goalId) as ThreadGoalDbRow | undefined;
      const current = rowToThreadGoalState(latest);
      if (!current) return { action: 'stale', staleReason: 'missing_goal' };
      if (current.updatedAt !== input.expectedEpoch) {
        return { action: 'stale', staleReason: 'goal_epoch', goal: current };
      }
      return { action: 'stale', staleReason: 'goal_status', goal: current };
    }

    return {
      action,
      epoch: nextEpoch,
      ...(cause ? { cause } : {}),
      goal: {
        ...state,
        status: nextStatus,
        statusReason: nextStatusReason,
        replyFingerprint: nextFingerprint,
        noProgressStreak: nextReplyStreak,
        noToolStreak: nextNoToolStreak,
        updatedAt: nextEpoch,
        executionWait: null,
      },
    };
  };

  return db.transaction ? db.transaction(apply).immediate() : apply();
}
