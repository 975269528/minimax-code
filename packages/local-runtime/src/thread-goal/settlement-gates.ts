import type { ThreadGoalBudgetLimits, ThreadGoalState } from '@mavis/goal';

import type { GoalDependencyGates } from './dependency-gates.js';
import { resolveThreadGoalBudgetLimits, type ThreadGoalGateConfig } from './gate.js';

/** The dependency classes that defer a settling Turn at stage 5. */
export type ThreadGoalSettlementDependency =
  | 'questionnaire'
  | 'permission'
  | 'required_background'
  | 'automation_owner_conflict';

/**
 * The first blocker that must defer this settling Turn, in user-actionable
 * order: a questionnaire the user can answer outranks background work they can
 * only wait for. A reader that throws is treated as blocking by
 * {@link GoalDependencyGates} itself, so this only sees booleans.
 */
export async function firstGoalSettlementDependency(
  goal: ThreadGoalState,
  gates: GoalDependencyGates,
): Promise<ThreadGoalSettlementDependency | undefined> {
  if (await gates.hasPendingQuestionnaire(goal.sessionId, goal.goalId)) return 'questionnaire';
  if (await gates.hasPendingPermission(goal.sessionId)) return 'permission';
  if (await gates.hasRequiredBackgroundWork(goal.sessionId)) return 'required_background';
  if (await gates.hasAutomationOwnerConflict(goal.sessionId)) return 'automation_owner_conflict';
  return undefined;
}

/** Budget limits for this Goal, falling back to config defaults when it is gone. */
export function effectiveGoalBudgetLimits(
  goal: ThreadGoalState | undefined,
  configGetter: () => ThreadGoalGateConfig,
): ThreadGoalBudgetLimits {
  return resolveThreadGoalBudgetLimits(goal ?? { tokenBudget: null }, configGetter);
}
