import type { ThreadGoalToolActivity } from '@mavis/goal';

import type { BoundGoalTurnKind } from './turn-context.js';
import type { ThreadGoalSettlementInput } from './verification-context.js';

/** The settlement facts this decision needs, without importing the pipeline context. */
interface ThreadGoalToolActivityInput {
  readonly input: ThreadGoalSettlementInput;
  readonly accounting: { readonly boundTurn: { readonly kind: BoundGoalTurnKind } };
}

/**
 * Decide what this settling Turn is known to have done with tools.
 *
 * Only a Goal-bound main execution Turn that ended normally can score the
 * GOAL-11 no-tool condition. Everything else — a budget-summary Turn, a failed
 * or aborted Turn, or a Turn whose committed history the host never observed —
 * reports `unknown`, which clears the streak instead of counting as a
 * trustworthy zero. Turns that never reach the breaker stage (dependency waits,
 * verification decisions, budget-limited settlements) are excluded earlier by
 * the settlement pipeline itself.
 */
export function threadGoalTurnToolActivity(
  context: ThreadGoalToolActivityInput,
): ThreadGoalToolActivity {
  if (context.accounting.boundTurn.kind !== 'main') return 'unknown';
  if (context.input.status !== 'completed' || context.input.retracted) return 'unknown';
  const observed = context.input.workSignals;
  if (!observed || !Number.isInteger(observed.toolCalls) || observed.toolCalls < 0) {
    return 'unknown';
  }
  return observed.toolCalls > 0 ? 'used' : 'absent';
}

/** Usage counters arrive from hosts; a negative or non-finite value counts as none. */
export function sanitizeUsageCounter(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
