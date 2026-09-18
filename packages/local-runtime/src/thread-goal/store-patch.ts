import {
  ThreadGoalBudgetLimitedError,
  ThreadGoalEpochConflictError,
  ThreadGoalObjectiveConflictError,
  ThreadGoalStatusConflictError,
  ThreadGoalTokenBudgetExhaustedError,
  type ThreadGoalPatchInput,
  type ThreadGoalState,
} from '@mavis/goal';

import type { DatabaseLike } from '../persistence/db.js';
import {
  isKnownThreadGoalStatus,
  positiveOrNull,
  rowToThreadGoalState,
  type ThreadGoalDbRow,
} from './store-row.js';

/** Apply a user-authored Goal mutation and advance the admission epoch. */
export function patchThreadGoal(
  db: DatabaseLike,
  nowMs: () => number,
  goalId: string,
  input: ThreadGoalPatchInput,
): ThreadGoalState {
  const existing = db
    .prepare(`SELECT * FROM local_runtime_thread_goals WHERE goal_id = ?`)
    .get(goalId) as ThreadGoalDbRow | undefined;
  const state = rowToThreadGoalState(existing);
  if (!state) {
    throw new Error(`Thread goal not found: ${goalId}`);
  }
  if (state.status === input.rejectIfCurrentStatus) {
    throw new ThreadGoalStatusConflictError(goalId, state.status);
  }
  if (
    input.rejectIfObjectiveChangedFrom !== undefined &&
    state.objective !== input.rejectIfObjectiveChangedFrom
  ) {
    throw new ThreadGoalObjectiveConflictError(
      goalId,
      input.rejectIfObjectiveChangedFrom,
      state.objective,
    );
  }
  if (
    input.rejectIfUpdatedAtChangedFrom !== undefined &&
    state.updatedAt !== input.rejectIfUpdatedAtChangedFrom
  ) {
    throw new ThreadGoalEpochConflictError(
      goalId,
      input.rejectIfUpdatedAtChangedFrom,
      state.updatedAt,
    );
  }
  if (typeof input.tokenBudget === 'number' && input.tokenBudget <= state.tokensUsed) {
    throw new ThreadGoalTokenBudgetExhaustedError(goalId, state.tokensUsed, input.tokenBudget);
  }

  const resumesTokenLimited =
    input.status === 'active' &&
    state.status === 'budget_limited' &&
    state.statusReason === 'budget_limited(token)' &&
    input.tokenBudget !== undefined &&
    (input.tokenBudget === null || input.tokenBudget > state.tokensUsed);
  if (input.status === 'active' && state.status === 'budget_limited' && !resumesTokenLimited) {
    throw new ThreadGoalBudgetLimitedError(goalId);
  }
  if (input.status === 'active' && !isKnownThreadGoalStatus(existing?.status)) {
    throw new ThreadGoalStatusConflictError(goalId, 'paused');
  }
  if (input.status === 'active' && state.status === 'complete') {
    throw new ThreadGoalStatusConflictError(goalId, state.status);
  }

  // `updated_at_ms` is also the Goal decision epoch. A user-authored
  // mutation must invalidate an in-flight settlement even when both
  // writes happen inside the same wall-clock millisecond.
  const now = Math.max(nowMs(), state.updatedAt + 1);
  const nextStatus = input.status ?? state.status;
  const nextObjective = input.objective ?? state.objective;
  const nextResources = input.objectiveResources ?? state.objectiveResources ?? [];
  // `tokenBudget === undefined` means "don't touch"; an explicit
  // `null` clears the cap; a positive integer sets it. Anything
  // else collapses to `null` via `positiveOrNull`.
  const nextTokenBudget =
    input.tokenBudget === undefined ? state.tokenBudget : positiveOrNull(input.tokenBudget);
  const objectiveChanged =
    (input.objective !== undefined && input.objective !== state.objective) ||
    JSON.stringify(nextResources) !== JSON.stringify(state.objectiveResources ?? []);
  const resumed =
    input.status === 'active' &&
    (state.status === 'paused' ||
      state.status === 'blocked' ||
      state.status === 'usage_limited' ||
      resumesTokenLimited);
  const nextReplyFingerprint = objectiveChanged || resumed ? null : state.replyFingerprint;
  const nextNoProgressStreak = objectiveChanged || resumed ? 0 : state.noProgressStreak;
  // The no-tool streak is a separate column with its own explicit clear list:
  // advancing the epoch alone must never be read as "the user re-armed this
  // counter", so every user-authored reset writes it by name.
  const nextNoToolStreak = objectiveChanged || resumed ? 0 : state.noToolStreak;
  const nextLastVerification = objectiveChanged ? undefined : state.lastVerification;
  const nextLastWorkerProposal = objectiveChanged ? undefined : state.lastWorkerProposal;
  const nextStatusReason =
    input.statusReason !== undefined
      ? input.statusReason
      : input.status !== undefined && input.status !== state.status
        ? null
        : state.statusReason;

  const rejectStatus = input.rejectIfCurrentStatus;
  const expectedObjective = input.rejectIfObjectiveChangedFrom;
  const expectedUpdatedAt = input.rejectIfUpdatedAtChangedFrom;
  const result = db
    .prepare(
      `UPDATE local_runtime_thread_goals
       SET status = ?, objective = ?, token_budget = ?, reply_fingerprint = ?,
           no_progress_streak = ?, no_tool_streak = ?, last_verification = ?,
           last_worker_proposal = ?,
           status_reason = ?, updated_at_ms = ?, objective_resources_json = ?
       WHERE goal_id = ?${rejectStatus ? ' AND status <> ?' : ''}${
         expectedObjective !== undefined ? ' AND objective = ?' : ''
       }${expectedUpdatedAt !== undefined ? ' AND updated_at_ms = ?' : ''}`,
    )
    .run(
      nextStatus,
      nextObjective,
      nextTokenBudget,
      nextReplyFingerprint,
      nextNoProgressStreak,
      nextNoToolStreak,
      nextLastVerification === undefined ? null : JSON.stringify(nextLastVerification),
      nextLastWorkerProposal === undefined ? null : JSON.stringify(nextLastWorkerProposal),
      nextStatusReason,
      now,
      JSON.stringify(nextResources),
      goalId,
      ...(rejectStatus ? [rejectStatus] : []),
      ...(expectedObjective !== undefined ? [expectedObjective] : []),
      ...(expectedUpdatedAt !== undefined ? [expectedUpdatedAt] : []),
    ) as { changes?: number };

  if (
    (rejectStatus || expectedObjective !== undefined || expectedUpdatedAt !== undefined) &&
    (result.changes ?? 0) === 0
  ) {
    const latest = db
      .prepare(`SELECT * FROM local_runtime_thread_goals WHERE goal_id = ?`)
      .get(goalId) as ThreadGoalDbRow | undefined;
    const current = rowToThreadGoalState(latest);
    if (!current) throw new Error(`Thread goal not found: ${goalId}`);
    if (rejectStatus && current.status === rejectStatus) {
      throw new ThreadGoalStatusConflictError(goalId, current.status);
    }
    if (expectedObjective !== undefined && current.objective !== expectedObjective) {
      throw new ThreadGoalObjectiveConflictError(goalId, expectedObjective, current.objective);
    }
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
      throw new ThreadGoalEpochConflictError(goalId, expectedUpdatedAt, current.updatedAt);
    }
    throw new Error(`Thread goal guarded patch made no change: ${goalId}`);
  }

  return {
    goalId: state.goalId,
    sessionId: state.sessionId,
    objective: nextObjective,
    objectiveResources: nextResources,
    status: nextStatus,
    createdAt: state.createdAt,
    updatedAt: now,
    // patch never touches accounting — it's status / objective / budget only.
    tokensUsed: state.tokensUsed,
    turnsUsed: state.turnsUsed,
    timeUsedSeconds: state.timeUsedSeconds,
    tokenBudget: nextTokenBudget,
    replyFingerprint: nextReplyFingerprint,
    noProgressStreak: nextNoProgressStreak,
    noToolStreak: nextNoToolStreak,
    lastVerification: nextLastVerification,
    lastWorkerProposal: nextLastWorkerProposal,
    statusReason: nextStatusReason,
    kickoffAttachments: state.kickoffAttachments,
    kickoffState: state.kickoffState,
    executionWait: null,
  };
}
