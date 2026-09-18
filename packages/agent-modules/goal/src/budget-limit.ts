/**
 * Hidden marker that opens the dedicated budget-summary Turn after a Goal
 * transitions to `budget_limited` (`tokens_used >= token_budget`).
 *
 * archon lacks codex's `inject_if_running` mid-turn ResponseItem
 * channel, so the runtime delivers this prompt as a fresh hidden turn
 * AFTER the current turn finishes. Delivery uses a durable clientRequestId
 * derived from Goal id + decision epoch, so startup recovery can replay the
 * same summary without starting a second model turn. The message deliberately
 * does not repeat the objective or transcript: the new Turn already has normal
 * conversation history, while its system reminder owns the summary contract.
 */

import { wrapInternalContext } from './internal-context-fragment.js';
import type { ThreadGoalState } from './types.js';

export const DEFAULT_BUDGET_LIMIT_TEMPLATE = 'The active thread goal has reached its token budget.';

export function renderBudgetLimitPrompt(
  goal?: Pick<ThreadGoalState, 'objective' | 'timeUsedSeconds' | 'tokensUsed' | 'tokenBudget'>,
  template = DEFAULT_BUDGET_LIMIT_TEMPLATE,
): string {
  const body = goal
    ? template
        .replaceAll('{{objective}}', escapeXmlText(goal.objective))
        .replaceAll('{{time_used_seconds}}', String(Math.max(0, Math.floor(goal.timeUsedSeconds))))
        .replaceAll('{{tokens_used}}', String(Math.max(0, Math.floor(goal.tokensUsed))))
        .replaceAll(
          '{{token_budget}}',
          goal.tokenBudget === null
            ? 'unlimited'
            : String(Math.max(0, Math.floor(goal.tokenBudget))),
        )
    : template;
  return body ? wrapInternalContext('goal', body) : '';
}

function escapeXmlText(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
