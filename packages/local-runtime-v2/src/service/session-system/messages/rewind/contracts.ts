export interface SessionRewindPlan {
  readonly deletedMessageIds: readonly string[];
  readonly affectedTurnIds: readonly string[];
  readonly targetTurnId?: string;
  readonly subsequentUserMessageIds?: readonly `msg-user-v1-${string}`[];
  readonly partiallyRetainedTurnIds?: readonly string[];
  readonly targetIsQuestionnaireResponse?: boolean;
  readonly targetQuestionnaireResponseRewindEligible?: boolean;
}

export interface SessionRewindCommitInput {
  readonly sessionId: string;
  readonly fromMessageId: string;
  readonly expectedDeletedMessageIds: readonly string[];
  readonly affectedTurnIds: readonly string[];
}

export interface SessionRewindCommitResult {
  readonly deletedMessageIds: readonly string[];
  readonly displayRevision: number;
}

export interface SessionRewindCapability {
  planInclusive(input: {
    readonly sessionId: string;
    readonly fromMessageId: string;
  }): Promise<SessionRewindPlan>;
  commit(input: SessionRewindCommitInput): Promise<SessionRewindCommitResult>;
}
