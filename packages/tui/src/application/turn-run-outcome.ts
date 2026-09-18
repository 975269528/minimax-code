export type TuiTurnRunStatus =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'awaiting-user-continuation'
  | 'timeout'
  | 'limit_exceeded';

export interface TuiTurnRunError {
  readonly category: 'config' | 'runtime' | 'internal';
  readonly code?: string;
  readonly message: string;
  readonly retryable?: boolean;
}

export interface TuiTurnRunModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  /**
   * The per-Turn selection that was requested. Runtime resolves the level it
   * actually applies, so this is not evidence of the effective effort.
   */
  readonly thinking?: { readonly effort?: string };
}

export interface TuiTurnRunUsage {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/** Response identity is required to reconcile replayed and persisted usage. */
export interface TuiTurnResponseUsage {
  readonly messageId?: string;
  readonly usage?: TuiTurnRunUsage;
  readonly usageIncomplete?: boolean;
}

/** Application-neutral outcome assembled from Runtime-owned Turn facts. */
export interface TuiTurnRunOutcome {
  readonly sessionId: string;
  readonly turnId: string;
  readonly status: TuiTurnRunStatus;
  readonly answer?: string | null;
  readonly model?: TuiTurnRunModel;
  readonly usage?: TuiTurnRunUsage;
  readonly usageResponses?: readonly TuiTurnResponseUsage[];
  /** Other observed Turn activity has usage outside the completed-response projection. */
  readonly usageIncomplete?: boolean;
  readonly error?: TuiTurnRunError;
  readonly durationMs: number;
}
