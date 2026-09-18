import type { ThreadGoalWaitReason } from '@mavis/goal';

export type GoalDependencyBlockerReason = Extract<
  ThreadGoalWaitReason,
  'questionnaire' | 'permission' | 'plan' | 'required_background' | 'automation_owner_conflict'
>;

/**
 * The dependency gates a Goal must clear before a Turn can start. Each reads an
 * external subsystem, so every one of them is fail-closed by the caller
 * (`GoalDependencyGates`): an unavailable gate blocks rather than waves the Goal
 * through.
 *
 * `hasPendingPlan` stays optional for legacy/direct queue callers. Runtime v2
 * supplies it to Goal queue selection so Plan participates in this same order
 * without being evaluated again by the outer Plan fence.
 */
export interface GoalBlockerGates {
  readonly hasPendingQuestionnaire: (sessionId: string, goalId: string) => Promise<boolean>;
  readonly hasPendingPermission: (sessionId: string) => Promise<boolean>;
  readonly hasPendingPlan?: (sessionId: string) => Promise<boolean>;
  readonly hasRequiredBackgroundWork: (sessionId: string) => Promise<boolean>;
  readonly hasAutomationOwnerConflict: (sessionId: string) => Promise<boolean>;
}

/**
 * Single ordered source of truth for "which blocker is the Goal sitting on".
 *
 * Queue selection and final admission both evaluate the same list in the same
 * order so the reason projected to the user while waiting is the same one that
 * later admits or re-defers the Turn. Order is by how directly the user can act
 * on the blocker: things they can resolve now come before things they can only
 * wait out.
 *
 * Returns `undefined` when nothing blocks the Goal.
 */
export async function firstGoalBlocker(
  gates: GoalBlockerGates,
  input: { readonly sessionId: string; readonly goalId: string },
): Promise<GoalDependencyBlockerReason | undefined> {
  if (await gates.hasPendingQuestionnaire(input.sessionId, input.goalId)) return 'questionnaire';
  if (await gates.hasPendingPermission(input.sessionId)) return 'permission';
  if (gates.hasPendingPlan && (await gates.hasPendingPlan(input.sessionId))) return 'plan';
  if (await gates.hasRequiredBackgroundWork(input.sessionId)) return 'required_background';
  if (await gates.hasAutomationOwnerConflict(input.sessionId)) return 'automation_owner_conflict';
  return undefined;
}
