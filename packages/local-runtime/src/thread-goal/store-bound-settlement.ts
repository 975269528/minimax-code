import {
  type GoalTurnBinding,
  type ThreadGoalBoundUsageDelta,
  type ThreadGoalBoundUsageResult,
  type ThreadGoalBudgetDimension,
  type ThreadGoalBudgetLimits,
  type ThreadGoalDecisionResult,
  type ThreadGoalSettleBoundTurnInput,
  type ThreadGoalStatus,
  type ThreadGoalStatusReason,
} from '@mavis/goal';

import { runInImmediateTransaction, type DatabaseLike } from '../persistence/db.js';
import { classifyThreadGoalAccountingStale, threadGoalStaleDecision } from './binding-stale.js';
import { numericOrZero, rowToThreadGoalState, type ThreadGoalDbRow } from './store-row.js';
import { materializeThreadGoalWorkerProposal } from './store-worker-proposal.js';

/**
 * Attribute one admitted Turn and make any budget stop in the same short
 * transaction.
 *
 * Note the asymmetry with `settleThreadGoalBoundTurn` below: this operation
 * writes the usage **even when the binding is stale**, and reports the reason
 * alongside the write instead of refusing it. Consumption already happened —
 * the tokens were spent and the wall clock ran regardless of what the row now
 * says — so dropping the write would let a Goal spend real budget for free
 * every time an objective edit or a concurrent decision landed mid-Turn, which
 * is the one failure the three-dimension budget exists to prevent. Decisions
 * are still refused: `settlementStage2ClassifyStale` reads `staleReason` off
 * this result and hard-stops before any decision is derived from it.
 *
 * The same asymmetry applies to `updated_at_ms`. Consumption is a fact about
 * the Goal; the decision epoch is the token for who owns its next step. A
 * charge only advances the epoch when it actually makes a decision — a budget
 * crossing — so a stale charge records the spend and leaves the Goal's current
 * runner alone.
 */
export function bumpThreadGoalBoundUsage(
  db: DatabaseLike,
  nowMs: () => number,
  binding: GoalTurnBinding,
  delta: ThreadGoalBoundUsageDelta,
  limits: ThreadGoalBudgetLimits,
): ThreadGoalBoundUsageResult {
  return runInImmediateTransaction(db, () => {
    const state = readGoal(db, binding.goalId);
    if (!state) return { staleReason: 'missing_goal' };

    const staleReason = classifyThreadGoalAccountingStale(state, {
      expectedEpoch: binding.admittedGoalUpdatedAt,
      objectiveDigest: binding.objectiveDigest,
    });
    const tokens = numericOrZero(delta.tokens);
    const activeSeconds = numericOrZero(delta.activeSeconds);
    const mainTurns = delta.mainTurns === 1 ? 1 : 0;
    if (tokens === 0 && activeSeconds === 0 && mainTurns === 0) {
      return {
        goal: state,
        decisionEpoch: state.updatedAt,
        transitioned: null,
        ...(staleReason ? { staleReason } : {}),
      };
    }

    const tokensUsed = state.tokensUsed + tokens;
    const turnsUsed = state.turnsUsed + mainTurns;
    const timeUsedSeconds = state.timeUsedSeconds + activeSeconds;
    const dimension =
      state.status === 'active'
        ? firstExceededBudget(
            { tokens: tokensUsed, mainTurns: turnsUsed, activeSeconds: timeUsedSeconds },
            limits,
          )
        : undefined;
    const status: ThreadGoalStatus = dimension ? 'budget_limited' : state.status;
    const statusReason: ThreadGoalStatusReason | null = dimension
      ? `budget_limited(${dimension})`
      : state.statusReason;
    /*
     * The decision epoch is the token saying *who owns this Goal's next step*:
     * admission's final recheck, the pre-tool gate, the settlement CAS and the
     * execution-wait projection all read it as one. Advancing it therefore
     * retires whatever the Goal is currently running, and only a writer that
     * takes over the next step has the right to do that.
     *
     * A charge is not automatically such a writer. Two cases keep the epoch:
     *
     *  - `budget_limited`: the explanatory post-limit summary derives its
     *    restart key from this exact epoch.
     *  - a stale charge that decides nothing: the late subagent verifier being
     *    the only producer today. Its binding lost the epoch to a user's
     *    breaker reset, so it owns no decision — but a Turn re-armed by that
     *    same reset may already be running, and invalidating it here strands
     *    the Goal with no runner at all (the re-arm marker is already spent).
     *
     * A stale charge that crosses a budget is excluded: that *is* a lifecycle
     * transition, and stopping the running Turn is the point of it.
     */
    const keepsDecisionEpoch =
      state.status === 'budget_limited' || (staleReason !== undefined && dimension === undefined);
    const decisionEpoch = keepsDecisionEpoch
      ? state.updatedAt
      : Math.max(nowMs(), state.updatedAt + 1);

    db.prepare(
      `UPDATE local_runtime_thread_goals
       SET tokens_used = ?, turns_used = ?, time_used_seconds = ?,
           status = ?, status_reason = ?, updated_at_ms = ?
       WHERE goal_id = ?`,
    ).run(
      tokensUsed,
      turnsUsed,
      timeUsedSeconds,
      status,
      statusReason,
      decisionEpoch,
      binding.goalId,
    );

    return {
      goal: {
        ...state,
        status,
        statusReason,
        tokensUsed,
        turnsUsed,
        timeUsedSeconds,
        updatedAt: decisionEpoch,
        // This value is published as a `thread_goal.updated` event while the
        // row behind `getById` answers the API, so it has to agree with
        // `rowToThreadGoalState`: advancing the epoch retires the wait, and
        // keeping the epoch keeps whatever wait is still visible at it.
        executionWait: keepsDecisionEpoch ? state.executionWait : null,
      },
      decisionEpoch,
      transitioned: dimension ?? null,
      ...(staleReason ? { staleReason } : {}),
    };
  });
}

/** Commit one host-owned terminal decision against the exact accounting epoch. */
export function settleThreadGoalBoundTurn(
  db: DatabaseLike,
  nowMs: () => number,
  input: ThreadGoalSettleBoundTurnInput,
): ThreadGoalDecisionResult {
  return runInImmediateTransaction(db, () => {
    const state = readGoal(db, input.goalId);
    if (!state) return { status: 'stale', staleReason: 'missing_goal' };
    const stale = threadGoalStaleDecision(state, input);
    if (stale) return stale;

    const decisionEpoch = Math.max(nowMs(), input.expectedEpoch + 1);
    const workerProposal = materializeThreadGoalWorkerProposal(input.workerProposal, decisionEpoch);
    const result = db
      .prepare(
        `UPDATE local_runtime_thread_goals
         SET status = ?, status_reason = ?, updated_at_ms = ?,
             last_worker_proposal = COALESCE(?, last_worker_proposal)
         WHERE goal_id = ? AND updated_at_ms = ? AND status = 'active'`,
      )
      .run(
        input.next.status,
        input.next.statusReason,
        decisionEpoch,
        workerProposal ? JSON.stringify(workerProposal) : null,
        input.goalId,
        input.expectedEpoch,
      ) as { changes?: number };
    if ((result.changes ?? 0) === 0) {
      return (
        threadGoalStaleDecision(readGoal(db, input.goalId), input) ?? {
          status: 'stale',
          staleReason: 'goal_status',
        }
      );
    }

    return {
      status: 'settled',
      decisionEpoch,
      goal: {
        ...state,
        status: input.next.status,
        statusReason: input.next.statusReason,
        updatedAt: decisionEpoch,
        ...(workerProposal ? { lastWorkerProposal: workerProposal } : {}),
        executionWait: null,
      },
    };
  });
}

function firstExceededBudget(
  usage: { readonly tokens: number; readonly mainTurns: number; readonly activeSeconds: number },
  limits: ThreadGoalBudgetLimits,
): ThreadGoalBudgetDimension | undefined {
  if (isPositiveLimit(limits.tokens) && usage.tokens >= limits.tokens) return 'token';
  if (isPositiveLimit(limits.mainTurns) && usage.mainTurns >= limits.mainTurns) {
    return 'main_turn';
  }
  if (isPositiveLimit(limits.activeSeconds) && usage.activeSeconds >= limits.activeSeconds) {
    return 'active_time';
  }
  return undefined;
}

function isPositiveLimit(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function readGoal(db: DatabaseLike, goalId: string) {
  const row = db
    .prepare(`SELECT * FROM local_runtime_thread_goals WHERE goal_id = ?`)
    .get(goalId) as ThreadGoalDbRow | undefined;
  return rowToThreadGoalState(row);
}
