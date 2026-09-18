import type {
  ThreadGoalDecisionResult,
  ThreadGoalFailureClass,
  ThreadGoalSettleBoundTurnInput,
  ThreadGoalStatusReason,
} from '@mavis/goal';

export type ThreadGoalSettlementStage = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface ThreadGoalSettlementDecision {
  readonly stage: ThreadGoalSettlementStage;
  readonly action:
    | 'ignored'
    | 'stale'
    | 'settled'
    | 'stopped'
    | 'budget_limited'
    | 'deferred'
    | 'continued';
  readonly reason: string;
  readonly goalId?: string;
  readonly decisionEpoch?: number;
}

export function settlementTransitionDecision(
  stage: 3 | 9,
  reason: ThreadGoalStatusReason,
  result: ThreadGoalDecisionResult,
): ThreadGoalSettlementDecision {
  if (result.status === 'stale') {
    return {
      stage,
      action: 'stale',
      reason: result.staleReason,
      ...(result.goal ? { goalId: result.goal.goalId } : {}),
    };
  }
  return {
    stage,
    action: 'settled',
    reason,
    goalId: result.goal.goalId,
    decisionEpoch: result.decisionEpoch,
  };
}

export function goalFailureTransition(
  failureClass: ThreadGoalFailureClass,
): ThreadGoalSettleBoundTurnInput['next'] {
  if (failureClass === 'provider_quota') {
    return { status: 'usage_limited', statusReason: 'usage_limited(provider_quota)' };
  }
  if (failureClass === 'rate_limit') {
    return { status: 'usage_limited', statusReason: 'usage_limited(rate_limit)' };
  }
  if (failureClass === 'safety') {
    return { status: 'blocked', statusReason: 'blocked(safety_policy)' };
  }
  return { status: 'paused', statusReason: 'paused(infra_retryable)' };
}
