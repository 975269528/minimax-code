import type { ThreadGoalState } from '@mavis/goal';

import type { ThreadGoalRuntimeEventSink } from './events.js';
import type { GoalPromptKind } from './prompt.js';
import {
  goalReminderReasons,
  selectGoalReminderPromptKind,
  type GoalReminderPromptKind,
} from './reminder-policy.js';

interface GoalPromptCoordinatorDeps {
  readonly nowMs: () => number;
  readonly emitRuntimeEvent: ThreadGoalRuntimeEventSink;
}

/** Owns transient prompt markers and their reminder observation lifecycle. */
export class GoalPromptCoordinator {
  private readonly pendingObjectiveUpdates = new Set<string>();
  private readonly pendingRecoveryGoals = new Set<string>();
  private readonly deliveredAuditTurns = new Map<string, number>();

  constructor(private readonly deps: GoalPromptCoordinatorDeps) {}

  armObjectiveUpdate(goalId: string): void {
    this.pendingObjectiveUpdates.add(goalId);
  }

  clearObjectiveUpdate(goalId: string): void {
    this.pendingObjectiveUpdates.delete(goalId);
  }

  armRecovery(goalId: string): void {
    this.pendingRecoveryGoals.add(goalId);
  }

  clearRecovery(goalId: string): void {
    this.pendingRecoveryGoals.delete(goalId);
  }

  clear(goalId: string): void {
    this.pendingObjectiveUpdates.delete(goalId);
    this.pendingRecoveryGoals.delete(goalId);
    this.deliveredAuditTurns.delete(goalId);
  }

  selectOverride(goal: ThreadGoalState): GoalPromptKind | undefined {
    if (this.pendingObjectiveUpdates.has(goal.goalId)) return 'objective-updated';
    return selectGoalReminderPromptKind({
      goal,
      recoveryPending: this.pendingRecoveryGoals.has(goal.goalId),
      auditAlreadyDelivered: this.deliveredAuditTurns.get(goal.goalId) === goal.turnsUsed,
    });
  }

  recordSubmitted(goal: ThreadGoalState, kind: GoalPromptKind): void {
    if (kind === 'objective-updated') this.clearObjectiveUpdate(goal.goalId);
    if (kind === 'recovery' || kind === 'recovery-terminal-audit') {
      this.clearRecovery(goal.goalId);
    }
    if (!isGoalReminderPromptKind(kind)) return;

    const reasons = goalReminderReasons(kind);
    if (reasons.includes('terminal-audit')) {
      this.deliveredAuditTurns.set(goal.goalId, goal.turnsUsed);
    }
    this.deps.emitRuntimeEvent({
      type: 'goal.reminder_injected',
      at: this.deps.nowMs(),
      payload: {
        goalId: goal.goalId,
        sessionId: goal.sessionId,
        turnsUsed: goal.turnsUsed,
        reasons: [...reasons],
      },
    });
  }
}

function isGoalReminderPromptKind(kind: GoalPromptKind): kind is GoalReminderPromptKind {
  return kind === 'recovery' || kind === 'terminal-audit' || kind === 'recovery-terminal-audit';
}
