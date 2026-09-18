import {
  digestThreadGoalObjective,
  type ThreadGoalBudgetCheckResult,
  type ThreadGoalState,
  type ThreadGoalStore,
} from '@mavis/goal';

import type { LocalActiveTurnTimingReader } from '../turns/active-turn-timing.js';
import {
  firstExhaustedThreadGoalBudget,
  resolveThreadGoalBudgetLimits,
  threadGoalBudgetGraceSteps,
  type ThreadGoalGateConfig,
} from './gate.js';
import type { GoalTurnContextRegistry } from './turn-context.js';

interface GoalBudgetAdmissionDeps {
  readonly store: () => Pick<ThreadGoalStore, 'getById'>;
  readonly turnContext: GoalTurnContextRegistry;
  readonly turnTimingReader: LocalActiveTurnTimingReader;
  readonly configGetter: () => ThreadGoalGateConfig;
  readonly failures: {
    readonly report: (sessionId: string, message: string) => void;
    readonly format: (error: unknown) => string;
  };
}

/** Enforce the live Goal budget immediately before a v2 tool call. */
export async function checkThreadGoalTurnBudget(
  input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly observedTokens: number;
  },
  deps: GoalBudgetAdmissionDeps,
): Promise<ThreadGoalBudgetCheckResult> {
  const boundTurn = deps.turnContext.getBinding(input.turnId);
  if (!boundTurn) return { decision: 'allow' };

  let goal: ThreadGoalState | undefined;
  try {
    goal = await deps.store().getById(boundTurn.binding.goalId);
  } catch (error) {
    deps.failures.report(
      input.sessionId,
      `thread_goal_budget_check_failed:${deps.failures.format(error)}`,
    );
    return {
      decision: 'stop',
      message:
        'GOAL_BUDGET_CHECK_UNAVAILABLE: Tool execution is disabled because the Goal budget check failed closed.',
    };
  }
  if (
    !goal ||
    goal.sessionId !== input.sessionId ||
    goal.status !== 'active' ||
    goal.updatedAt !== boundTurn.binding.admittedGoalUpdatedAt ||
    digestThreadGoalObjective(goal.objective) !== boundTurn.binding.objectiveDigest
  ) {
    return {
      decision: 'stop',
      message:
        'GOAL_TURN_NOT_CURRENT: This Goal turn is no longer current. Do not call another tool; provide a brief final response.',
    };
  }

  const timing = deps.turnTimingReader.getByTurn(input.sessionId, input.turnId);
  const activeSeconds = timing ? deps.turnTimingReader.elapsedSeconds(timing) : 0;
  const dimension = firstExhaustedThreadGoalBudget(
    {
      tokens: goal.tokensUsed + sanitizeUsageCounter(input.observedTokens),
      mainTurns: goal.turnsUsed + boundTurn.mainTurns,
      activeSeconds: goal.timeUsedSeconds + activeSeconds,
    },
    resolveThreadGoalBudgetLimits(goal, deps.configGetter),
  );
  if (!dimension) return { decision: 'allow' };
  if (boundTurn.graceStepsUsed < threadGoalBudgetGraceSteps(deps.configGetter)) {
    boundTurn.graceStepsUsed += 1;
    return {
      decision: 'steer',
      message: `GOAL_BUDGET_EXHAUSTED(${dimension}): The Goal budget is exhausted. Do not call another tool; respond now with a concise final summary.`,
    };
  }
  return {
    decision: 'stop',
    message: `GOAL_BUDGET_EXHAUSTED(${dimension}): Tool execution remains disabled for this Goal turn.`,
  };
}

function sanitizeUsageCounter(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
