import type {
  GoalTurnBinding,
  GoalTurnSignal,
  ThreadGoalSettleBoundTurnInput,
  ThreadGoalState,
  VerificationAttempt,
  VerificationDispatchError,
  VerificationResult,
} from '@mavis/goal';

export interface ThreadGoalSettlementInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly tokens: number;
  readonly retracted: boolean;
  readonly usageIncomplete?: boolean;
  readonly failureClass?: import('@mavis/goal').ThreadGoalFailureClass;
  readonly finalAssistantText?: string;
  readonly workerModelKey?: string;
  /**
   * Work observed on this Turn's committed history. Absent means the host could
   * not observe it — callers must never synthesize a zero here, because the
   * no-tool breaker treats a missing signal as an observation gap rather than a
   * tool-less Turn.
   */
  readonly workSignals?: { readonly toolCalls: number };
}

export interface ThreadGoalVerificationSettlementContext {
  readonly input: ThreadGoalSettlementInput;
  readonly accounting: {
    readonly boundTurn: {
      readonly binding: GoalTurnBinding;
      readonly kind: 'main' | 'budget-summary';
    };
  };
  readonly signal?: GoalTurnSignal;
  goal: ThreadGoalState;
  proposedTransition?: ThreadGoalSettleBoundTurnInput['next'];
  verificationAttempt?: VerificationAttempt;
  verificationOutcome?:
    | { readonly type: 'result'; readonly result: VerificationResult }
    | { readonly type: 'failure'; readonly error: VerificationDispatchError };
  verificationAlreadyRecorded?: boolean;
  verificationPreDispatchStale?: ThreadGoalVerificationDecision;
  /**
   * Observed verification cost. Subagent-backend spend is charged against the
   * Goal budget by `ThreadGoalVerificationSettlement.chargeVerifierUsage` after the
   * verdict records; evaluator-backend spend stays report-only.
   */
  verificationUsageAccounting?: {
    readonly reportedTokens: number | null;
    readonly activeSeconds: number;
    readonly incomplete: boolean;
    readonly childTurns?: number;
  };
}

export interface ThreadGoalVerificationDecision {
  readonly stage: 6 | 7;
  readonly action: 'stale' | 'settled' | 'budget_limited';
  readonly reason: string;
  readonly goalId?: string;
  readonly decisionEpoch?: number;
}
