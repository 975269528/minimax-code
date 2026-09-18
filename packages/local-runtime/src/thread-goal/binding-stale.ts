import {
  digestThreadGoalObjective,
  type ThreadGoalBoundUsageStaleReason,
  type ThreadGoalDecisionResult,
  type ThreadGoalDecisionStaleReason,
  type ThreadGoalState,
} from '@mavis/goal';

/**
 * The staleness predicate for everything bound to a `GoalTurnBinding`.
 *
 * A binding is admitted once per Turn and carries the epoch and objective
 * digest it was admitted against. Four things can invalidate it before the bound
 * work lands, checked in this order because each later check is only meaningful
 * once the earlier one holds:
 *
 * 1. `missing_goal` — the row is gone (deleted mid-Turn).
 * 2. `goal_epoch` — the CAS epoch moved; another decision won the race.
 * 3. `objective_digest` — the objective was rewritten, so the work answered a
 *    question nobody is asking any more.
 * 4. `goal_status` — the Goal already left `active`.
 *
 * Accounting deliberately stops after check 3 — see
 * {@link classifyThreadGoalAccountingStale}.
 */
export function classifyThreadGoalBindingStale(
  state: ThreadGoalState | undefined,
  expected: ThreadGoalBindingExpectation,
): ThreadGoalDecisionStaleReason | undefined {
  const bindingStale = classifyThreadGoalAccountingStale(state, expected);
  if (bindingStale) return bindingStale;
  return state?.status === 'active' ? undefined : 'goal_status';
}

/**
 * Same predicate without check 4, for `bumpBoundUsage`.
 *
 * A non-active Goal is not stale for accounting: the post-limit budget-summary
 * Turn runs after the Goal is already `budget_limited`, and its tokens must
 * still be attributed. Charging it is required, not merely tolerated.
 */
export function classifyThreadGoalAccountingStale(
  state: ThreadGoalState | undefined,
  expected: ThreadGoalBindingExpectation,
): ThreadGoalBoundUsageStaleReason | undefined {
  if (!state) return 'missing_goal';
  if (state.updatedAt !== expected.expectedEpoch) return 'goal_epoch';
  return digestThreadGoalObjective(state.objective) !== expected.objectiveDigest
    ? 'objective_digest'
    : undefined;
}

export interface ThreadGoalBindingExpectation {
  readonly expectedEpoch: number;
  readonly objectiveDigest: string;
}

/** Store-shaped wrapper for the two operations that must refuse a stale binding. */
export function threadGoalStaleDecision(
  state: ThreadGoalState | undefined,
  expected: ThreadGoalBindingExpectation,
): Extract<ThreadGoalDecisionResult, { status: 'stale' }> | undefined {
  const staleReason = classifyThreadGoalBindingStale(state, expected);
  if (!staleReason) return undefined;
  return { status: 'stale', staleReason, ...(state ? { goal: state } : {}) };
}
