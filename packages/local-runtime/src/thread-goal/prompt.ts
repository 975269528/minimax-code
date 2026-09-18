import { randomUUID } from 'node:crypto';

import type { InternalTurnPromptReadRegistry, PromptSnapshotSource } from '@mavis/agent-core';
import {
  DEFAULT_BUDGET_LIMIT_TEMPLATE,
  DEFAULT_GOAL_CONTINUATION_TEMPLATE,
  DEFAULT_GOAL_RECOVERY_TEMPLATE,
  DEFAULT_GOAL_RECOVERY_TERMINAL_AUDIT_TEMPLATE,
  DEFAULT_GOAL_TERMINAL_AUDIT_TEMPLATE,
  DEFAULT_OBJECTIVE_UPDATED_TEMPLATE,
  renderBudgetLimitPrompt,
  renderContinuationPrompt,
  renderKickoffPrompt,
  renderNudgePrompt,
  renderObjectiveUpdatedPrompt,
  renderRecoveryPrompt,
  renderRecoveryTerminalAuditPrompt,
  renderTerminalAuditPrompt,
  type ThreadGoalState,
} from '@mavis/goal';

import { readPromptBundleScopeWithBuiltinFallback } from '../runtime/prompt-read.js';
import type { InternalGoalPromptTurn } from './host-deps.js';

const GOAL_PROMPT_KEYS = {
  budgetLimit: 'workflow/goal/budget-limit.md',
  continuation: 'workflow/goal/continuation.md',
  objectiveUpdated: 'workflow/goal/objective-updated.md',
  recovery: 'workflow/goal/recovery.md',
  recoveryTerminalAudit: 'workflow/goal/recovery-terminal-audit.md',
  terminalAudit: 'workflow/goal/terminal-audit.md',
} as const;

export type GoalPromptKind =
  | 'kickoff'
  | 'continuation'
  | 'nudge'
  | 'recovery'
  | 'terminal-audit'
  | 'recovery-terminal-audit'
  | 'objective-updated'
  | 'budget-limit';

export interface PreparedGoalPrompt {
  readonly content: string;
  readonly internalPromptRead?: InternalGoalPromptTurn;
}

export async function prepareGoalPrompt(
  goal: ThreadGoalState,
  kind: GoalPromptKind,
  options: {
    readonly promptSnapshots?: PromptSnapshotSource;
    readonly internalTurnPromptReads?: InternalTurnPromptReadRegistry;
  },
): Promise<PreparedGoalPrompt> {
  if (!options.promptSnapshots) return { content: renderBuiltinGoalPrompt(goal, kind) };
  const resolved = await readPromptBundleScopeWithBuiltinFallback(options.promptSnapshots, [
    { key: GOAL_PROMPT_KEYS.budgetLimit, builtin: DEFAULT_BUDGET_LIMIT_TEMPLATE },
    { key: GOAL_PROMPT_KEYS.continuation, builtin: DEFAULT_GOAL_CONTINUATION_TEMPLATE },
    { key: GOAL_PROMPT_KEYS.objectiveUpdated, builtin: DEFAULT_OBJECTIVE_UPDATED_TEMPLATE },
    { key: GOAL_PROMPT_KEYS.recovery, builtin: DEFAULT_GOAL_RECOVERY_TEMPLATE },
    {
      key: GOAL_PROMPT_KEYS.recoveryTerminalAudit,
      builtin: DEFAULT_GOAL_RECOVERY_TERMINAL_AUDIT_TEMPLATE,
    },
    { key: GOAL_PROMPT_KEYS.terminalAudit, builtin: DEFAULT_GOAL_TERMINAL_AUDIT_TEMPLATE },
  ]);
  const content = renderGoalPrompt(goal, kind, resolved.templates);
  if (!resolved.promptRead || !options.internalTurnPromptReads) return { content };

  const requestedTurnId = `turn_goal_${randomUUID()}`;
  if (!options.internalTurnPromptReads.reserve(requestedTurnId)) {
    throw new Error('Thread Goal prompt snapshot handoff is unavailable.');
  }
  options.internalTurnPromptReads.remember(requestedTurnId, resolved.promptRead);
  return {
    content,
    internalPromptRead: { requestedTurnId, promptRead: resolved.promptRead },
  };
}

function renderGoalPrompt(
  goal: ThreadGoalState,
  kind: GoalPromptKind,
  templates: ReadonlyMap<string, string>,
): string {
  const continuation =
    templates.get(GOAL_PROMPT_KEYS.continuation) ?? DEFAULT_GOAL_CONTINUATION_TEMPLATE;
  if (kind === 'kickoff') return renderKickoffPrompt(goal, continuation);
  if (kind === 'continuation') return renderContinuationPrompt(goal, continuation);
  if (kind === 'nudge') return renderNudgePrompt(goal, continuation);
  if (kind === 'recovery') {
    return renderRecoveryPrompt(
      goal,
      continuation,
      templates.get(GOAL_PROMPT_KEYS.recovery) ?? DEFAULT_GOAL_RECOVERY_TEMPLATE,
    );
  }
  if (kind === 'terminal-audit') {
    return renderTerminalAuditPrompt(
      goal,
      continuation,
      templates.get(GOAL_PROMPT_KEYS.terminalAudit) ?? DEFAULT_GOAL_TERMINAL_AUDIT_TEMPLATE,
    );
  }
  if (kind === 'recovery-terminal-audit') {
    return renderRecoveryTerminalAuditPrompt(
      goal,
      continuation,
      templates.get(GOAL_PROMPT_KEYS.recoveryTerminalAudit) ??
        DEFAULT_GOAL_RECOVERY_TERMINAL_AUDIT_TEMPLATE,
    );
  }
  if (kind === 'objective-updated') {
    return renderObjectiveUpdatedPrompt(
      goal,
      templates.get(GOAL_PROMPT_KEYS.objectiveUpdated) ?? DEFAULT_OBJECTIVE_UPDATED_TEMPLATE,
    );
  }
  return renderBudgetLimitPrompt(
    goal,
    templates.get(GOAL_PROMPT_KEYS.budgetLimit) ?? DEFAULT_BUDGET_LIMIT_TEMPLATE,
  );
}

function renderBuiltinGoalPrompt(goal: ThreadGoalState, kind: GoalPromptKind): string {
  if (kind === 'kickoff') return renderKickoffPrompt(goal);
  if (kind === 'continuation') return renderContinuationPrompt(goal);
  if (kind === 'nudge') return renderNudgePrompt(goal);
  if (kind === 'recovery') return renderRecoveryPrompt(goal);
  if (kind === 'terminal-audit') return renderTerminalAuditPrompt(goal);
  if (kind === 'recovery-terminal-audit') return renderRecoveryTerminalAuditPrompt(goal);
  if (kind === 'objective-updated') return renderObjectiveUpdatedPrompt(goal);
  return renderBudgetLimitPrompt();
}
