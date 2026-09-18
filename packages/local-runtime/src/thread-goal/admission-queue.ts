import { isContinuationStatus, type ThreadGoalState, type ThreadGoalWaitReason } from '@mavis/goal';

import type { GoalDependencyGates } from './dependency-gates.js';
import { firstGoalBlocker } from './blockers.js';
import {
  isThreadGoalContinuationQueueItem,
  isThreadGoalKickoffQueueItem,
  readThreadGoalContinuationOrigin,
  readThreadGoalKickoffOrigin,
  type ThreadGoalQueueItemIdentity,
} from './kickoff.js';

export type GoalQueueAdmissionDecision = 'ready' | 'defer' | 'cancel';

interface GoalQueueAdmissionDeps {
  readonly getGoalBySession: (sessionId: string) => Promise<ThreadGoalState | undefined>;
  readonly gates: GoalDependencyGates;
  readonly failures: {
    readonly report: (sessionId: string, message: string) => void;
    readonly format: (error: unknown) => string;
  };
  readonly emitDecision: (
    sessionId: string,
    goalId: string,
    decision: 'ready' | 'deferred' | 'cancelled',
    reason?: string,
  ) => void;
  readonly emitQueueItemDeferred: (sessionId: string, reason: 'questionnaire_unresolved') => void;
  readonly projectExecutionWait: (
    goal: Pick<ThreadGoalState, 'goalId' | 'sessionId' | 'updatedAt'>,
    reason: ThreadGoalWaitReason,
  ) => Promise<void>;
}

/** Classify one queued item against the current Goal and ordered dependency gates. */
export async function classifyThreadGoalQueueItem(
  item: ThreadGoalQueueItemIdentity,
  hasPendingPlan: ((sessionId: string) => Promise<boolean>) | undefined,
  deps: GoalQueueAdmissionDeps,
): Promise<GoalQueueAdmissionDecision> {
  if (isThreadGoalKickoffQueueItem(item)) {
    return classifyKickoffQueueItem(item, hasPendingPlan, deps);
  }
  if (isThreadGoalContinuationQueueItem(item)) {
    return classifyContinuationQueueItem(item, hasPendingPlan, deps);
  }
  if (await deps.gates.hasPendingQuestionnaire(item.sessionId)) {
    deps.emitQueueItemDeferred(item.sessionId, 'questionnaire_unresolved');
    return 'defer';
  }
  return 'ready';
}

async function classifyKickoffQueueItem(
  item: ThreadGoalQueueItemIdentity,
  hasPendingPlan: ((sessionId: string) => Promise<boolean>) | undefined,
  deps: GoalQueueAdmissionDeps,
): Promise<GoalQueueAdmissionDecision> {
  const origin = readThreadGoalKickoffOrigin(item.message.origin);
  if (!origin) return 'cancel';
  const goal = await deps.getGoalBySession(item.sessionId);
  if (!goal || goal.goalId !== origin.goalId || goal.status === 'complete') return 'cancel';
  if (goal.kickoffState === 'consumed') return 'cancel';
  if (goal.status !== 'active') return 'defer';
  return classifyAgainstBlockers(goal, hasPendingPlan, deps);
}

async function classifyContinuationQueueItem(
  item: ThreadGoalQueueItemIdentity,
  hasPendingPlan: ((sessionId: string) => Promise<boolean>) | undefined,
  deps: GoalQueueAdmissionDeps,
): Promise<GoalQueueAdmissionDecision> {
  const origin = readThreadGoalContinuationOrigin(item.message.origin);
  if (!origin) return 'cancel';
  const goal = await deps.getGoalBySession(item.sessionId);
  if (!goal || goal.goalId !== origin.goalId || goal.updatedAt !== origin.goalUpdatedAt) {
    return 'cancel';
  }
  if (origin.kind === 'budget-limit') {
    if (await deps.gates.hasAutomationOwnerConflict(goal.sessionId)) {
      deps.emitDecision(
        goal.sessionId,
        goal.goalId,
        'deferred',
        'deferred(automation_owner_conflict)',
      );
      return 'defer';
    }
    return goal.status === 'budget_limited' ? 'ready' : 'cancel';
  }
  if (!isContinuationStatus(goal.status)) return 'cancel';
  return classifyAgainstBlockers(goal, hasPendingPlan, deps);
}

/**
 * Record the queue-selection blocker before returning `defer`. The dispatcher
 * releases that claim with `drainAgain: false`, so this is the durable evidence
 * explaining why an otherwise-active Goal is parked.
 */
async function classifyAgainstBlockers(
  goal: ThreadGoalState,
  hasPendingPlan: ((sessionId: string) => Promise<boolean>) | undefined,
  deps: GoalQueueAdmissionDeps,
): Promise<'ready' | 'defer'> {
  let blocker: ThreadGoalWaitReason | undefined;
  try {
    blocker = await firstGoalBlocker(
      {
        hasPendingQuestionnaire: (sessionId, goalId) =>
          deps.gates.hasPendingQuestionnaire(sessionId, goalId),
        hasPendingPermission: (sessionId) => deps.gates.hasPendingPermission(sessionId),
        ...(hasPendingPlan ? { hasPendingPlan } : {}),
        hasRequiredBackgroundWork: (sessionId) => deps.gates.hasRequiredBackgroundWork(sessionId),
        hasAutomationOwnerConflict: (sessionId) => deps.gates.hasAutomationOwnerConflict(sessionId),
      },
      { sessionId: goal.sessionId, goalId: goal.goalId },
    );
  } catch (error) {
    deps.failures.report(
      goal.sessionId,
      `thread_goal_queue_blocker_read_failed:${deps.failures.format(error)}`,
    );
    blocker = 'dependency_unavailable';
  }
  if (!blocker) return 'ready';
  deps.emitDecision(goal.sessionId, goal.goalId, 'deferred', `deferred(${blocker})`);
  await deps.projectExecutionWait(goal, blocker);
  return 'defer';
}
