import type { ThreadGoalBudgetCheckResult, ThreadGoalFailureClass } from '@mavis/goal';

export interface HostedTurnLifecycleInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly source?: string;
}

export interface HostedTurnBudgetCheckInput extends HostedTurnLifecycleInput {
  readonly observedTokens: number;
}

export type HostedTurnBudgetCheckResult = ThreadGoalBudgetCheckResult;

export interface HostedTurnSettlementInput extends HostedTurnLifecycleInput {
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly tokens: number;
  readonly retracted: boolean;
  /** At least one committed assistant response omitted provider usage. */
  readonly usageIncomplete?: boolean;
  readonly failureClass?: ThreadGoalFailureClass;
  /** Last durable assistant text produced by this Turn, if it produced one. */
  readonly finalAssistantText?: string;
  /** Secret-free provider/model identity captured from the exact resolved worker Turn. */
  readonly workerModelKey?: string;
  /**
   * Work observed on this Turn's committed history. Omitted when the host could
   * not observe the history at all; a caller must never substitute a zero,
   * because the no-tool breaker treats a missing signal as an observation gap
   * rather than as a tool-less Turn.
   */
  readonly workSignals?: { readonly toolCalls: number };
}
