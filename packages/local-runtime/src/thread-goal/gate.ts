import {
  GOAL_CONFIG_DEFAULTS,
  GOAL_CONFIG_LIMITS,
  resolveBetaFeature,
  type ModelAvailabilityConfigView,
  type PartialGoalConfig,
  type GoalVerificationEvidenceMode,
} from '@mavis/config';
import {
  digestThreadGoalObjective,
  type GoalTurnBinding,
  type ThreadGoalBudgetDimension,
  type ThreadGoalBudgetLimits,
  type ThreadGoalState,
  type ThreadGoalWaitReason,
} from '@mavis/goal';

import { firstGoalBlocker } from './blockers.js';

export interface ThreadGoalGateConfig extends ModelAvailabilityConfigView {
  beta?: {
    threadGoal?: boolean;
  };
  goal?: PartialGoalConfig;
}

export type ThreadGoalFinalRecheckReason =
  | 'stale(turn_binding)'
  | 'stale(goal_epoch)'
  | 'stale(objective_digest)'
  | 'deferred(goal_not_active)'
  | 'deferred(questionnaire)'
  | 'deferred(permission)'
  | 'deferred(plan)'
  | 'deferred(required_background)'
  | 'deferred(automation_owner_conflict)'
  | 'deferred(user_work)'
  | `budget_limited(${ThreadGoalBudgetDimension})`;

export interface ThreadGoalFinalRecheckDeps {
  readonly getGoalBySession: (sessionId: string) => Promise<ThreadGoalState | undefined>;
  readonly hasPendingQuestionnaire: (sessionId: string, goalId: string) => Promise<boolean>;
  readonly hasPendingPermission: (sessionId: string) => Promise<boolean>;
  readonly hasPendingPlan: (sessionId: string) => Promise<boolean>;
  readonly hasRequiredBackgroundWork: (sessionId: string) => Promise<boolean>;
  readonly hasAutomationOwnerConflict: (sessionId: string) => Promise<boolean>;
  readonly hasPriorityMailboxWork: (sessionId: string) => Promise<boolean>;
}

export interface ThreadGoalFinalRecheckInput {
  readonly sessionId: string;
  readonly goalId: string;
  readonly expectedUpdatedAt: number;
  readonly expectedObjectiveDigest: string;
  readonly turnId: string;
}

export type ThreadGoalFinalRecheckResult =
  | { readonly decision: 'ready'; readonly binding: GoalTurnBinding }
  | {
      readonly decision: 'defer' | 'cancel';
      readonly reason: Exclude<
        ThreadGoalFinalRecheckReason,
        `budget_limited(${ThreadGoalBudgetDimension})`
      >;
      readonly goal?: ThreadGoalState;
      /**
       * Set only for dependency-gate defers, so admission can project the wait
       * without re-deriving it from the reason string.
       */
      readonly waitReason?: ThreadGoalWaitReason;
    }
  | {
      readonly decision: 'pause';
      readonly reason: `budget_limited(${ThreadGoalBudgetDimension})`;
      readonly goal: ThreadGoalState;
    };

export const GOAL_AUTOMATION_OWNER_CONFLICT = 'GOAL_AUTOMATION_OWNER_CONFLICT';

export class ThreadGoalAutomationOwnerConflictError extends Error {
  override readonly name = 'ThreadGoalAutomationOwnerConflictError';
  readonly statusCode = 409;
  readonly code = GOAL_AUTOMATION_OWNER_CONFLICT;

  constructor(readonly sessionId: string) {
    super(`Session already has an active Cron or AgentTeam automation owner: ${sessionId}`);
  }
}

/**
 * Last Goal-owned policy decision before durable Turn admission. This is an
 * optimistic binding, not a lease: settlement must still compare the captured
 * epoch before attributing work or accepting completion.
 */
export async function finalRecheck(
  deps: ThreadGoalFinalRecheckDeps,
  input: ThreadGoalFinalRecheckInput,
  configGetter?: () => ThreadGoalGateConfig,
): Promise<ThreadGoalFinalRecheckResult> {
  const goal = await deps.getGoalBySession(input.sessionId);
  if (!goal || goal.goalId !== input.goalId) {
    return { decision: 'cancel', reason: 'stale(turn_binding)' };
  }
  if (goal.status !== 'active') {
    return { decision: 'defer', reason: 'deferred(goal_not_active)', goal };
  }
  if (goal.updatedAt !== input.expectedUpdatedAt) {
    return { decision: 'cancel', reason: 'stale(goal_epoch)', goal };
  }
  const objectiveDigest = digestThreadGoalObjective(goal.objective);
  if (objectiveDigest !== input.expectedObjectiveDigest) {
    return { decision: 'cancel', reason: 'stale(objective_digest)', goal };
  }
  const exhaustedDimension = firstExhaustedThreadGoalBudget(
    {
      tokens: goal.tokensUsed,
      mainTurns: goal.turnsUsed,
      activeSeconds: goal.timeUsedSeconds,
    },
    resolveThreadGoalBudgetLimits(goal, configGetter),
  );
  if (exhaustedDimension) {
    return { decision: 'pause', reason: `budget_limited(${exhaustedDimension})`, goal };
  }
  // Same ordered gate list the queue-selection stage evaluates, so the wait
  // reason shown while the Goal is parked is the one that later admits it.
  const blocker = await firstGoalBlocker(deps, {
    sessionId: input.sessionId,
    goalId: goal.goalId,
  });
  if (blocker) {
    return { decision: 'defer', reason: `deferred(${blocker})`, goal, waitReason: blocker };
  }
  // Cancel this Goal snapshot instead of merely releasing it: a queued user
  // message behind the claimed Goal must be able to become the next Turn.
  if (await deps.hasPriorityMailboxWork(input.sessionId)) {
    return { decision: 'cancel', reason: 'deferred(user_work)', goal };
  }
  return {
    decision: 'ready',
    binding: {
      goalId: goal.goalId,
      admittedGoalUpdatedAt: goal.updatedAt,
      objectiveDigest,
      turnId: input.turnId,
    },
  };
}

export function resolveThreadGoalBudgetLimits(
  goal: Pick<ThreadGoalState, 'tokenBudget'>,
  configGetter?: () => ThreadGoalGateConfig,
): ThreadGoalBudgetLimits {
  const budget = configGetter?.().goal?.budget;
  return {
    tokens: goal.tokenBudget ?? positiveIntegerOrNull(budget?.defaultTokens),
    mainTurns: positiveIntegerOrNull(budget?.defaultMainTurns),
    activeSeconds: positiveIntegerOrNull(budget?.defaultActiveSeconds),
  };
}

export function firstExhaustedThreadGoalBudget(
  usage: {
    readonly tokens: number;
    readonly mainTurns: number;
    readonly activeSeconds: number;
  },
  limits: ThreadGoalBudgetLimits,
): ThreadGoalBudgetDimension | undefined {
  if (isExhausted(usage.tokens, limits.tokens)) return 'token';
  if (isExhausted(usage.mainTurns, limits.mainTurns)) return 'main_turn';
  if (isExhausted(usage.activeSeconds, limits.activeSeconds)) return 'active_time';
  return undefined;
}

export function isThreadGoalEnabled(configGetter?: () => ThreadGoalGateConfig): boolean {
  return resolveBetaFeature('threadGoal', configGetter?.().beta?.threadGoal, {
    internalBuild: process.env.__MAVIS_BUILD_INTERNAL === 'true',
  });
}

export function threadGoalRepeatedReplyLimit(configGetter?: () => ThreadGoalGateConfig): number {
  const configured = configGetter?.().goal?.breaker?.repeatedReplyLimit;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : GOAL_CONFIG_DEFAULTS.breaker.repeatedReplyLimit;
}

export function threadGoalBudgetGraceSteps(configGetter?: () => ThreadGoalGateConfig): number {
  const configured = configGetter?.().goal?.budget?.graceSteps;
  return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
    ? Math.min(Math.floor(configured), GOAL_CONFIG_LIMITS.budget.graceSteps)
    : GOAL_CONFIG_DEFAULTS.budget.graceSteps;
}

export function threadGoalRepeatedNotMetLimit(configGetter?: () => ThreadGoalGateConfig): number {
  return positiveIntegerOrDefault(
    configGetter?.().goal?.verifier?.repeatedNotMetLimit,
    GOAL_CONFIG_DEFAULTS.verifier.repeatedNotMetLimit,
  );
}

export function threadGoalVerifierEvidenceMode(
  configGetter?: () => ThreadGoalGateConfig,
): GoalVerificationEvidenceMode {
  const configured = configGetter?.().goal?.verifier?.evidence;
  return configured === 'transcript' ? 'transcript' : GOAL_CONFIG_DEFAULTS.verifier.evidence;
}

export function threadGoalEvaluatorMaxTokens(configGetter?: () => ThreadGoalGateConfig): number {
  return positiveIntegerOrDefault(
    configGetter?.().goal?.evaluator?.maxTokens,
    GOAL_CONFIG_DEFAULTS.evaluator.maxTokens,
  );
}

export function threadGoalSubagentMaxTokens(
  configGetter?: () => ThreadGoalGateConfig,
): number | undefined {
  const configured = configGetter?.().goal?.subagent?.maxTokens;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : undefined;
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function positiveIntegerOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function isExhausted(usage: number, limit: number | null): boolean {
  return limit !== null && Number.isFinite(limit) && limit > 0 && usage >= limit;
}
