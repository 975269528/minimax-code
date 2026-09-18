import type { ThreadGoalState } from '@mavis/goal';

export const GOAL_TERMINAL_AUDIT_INTERVAL = 5;

export type GoalReminderReason = 'recovery' | 'terminal-audit';
export type GoalReminderPromptKind = 'recovery' | 'terminal-audit' | 'recovery-terminal-audit';

export function selectGoalReminderPromptKind(input: {
  readonly goal: Pick<ThreadGoalState, 'status' | 'turnsUsed'>;
  readonly recoveryPending: boolean;
  readonly auditAlreadyDelivered?: boolean;
}): GoalReminderPromptKind | undefined {
  if (input.goal.status !== 'active') return undefined;
  const auditDue =
    input.auditAlreadyDelivered !== true &&
    input.goal.turnsUsed > 0 &&
    input.goal.turnsUsed % GOAL_TERMINAL_AUDIT_INTERVAL === 0;
  if (input.recoveryPending && auditDue) return 'recovery-terminal-audit';
  if (input.recoveryPending) return 'recovery';
  if (auditDue) return 'terminal-audit';
  return undefined;
}

export function goalReminderReasons(kind: GoalReminderPromptKind): readonly GoalReminderReason[] {
  if (kind === 'recovery-terminal-audit') return ['recovery', 'terminal-audit'];
  return [kind];
}
