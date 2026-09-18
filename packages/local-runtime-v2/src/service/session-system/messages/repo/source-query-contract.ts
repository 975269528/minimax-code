export interface SessionSourceRecord {
  readonly sourceId: string;
  readonly resourceType: string;
  readonly resourceDataJson: string;
  readonly resourceDataVersion: number;
  readonly messageId: string;
  readonly toolCallId: string;
  readonly resourceOrdinal: number;
  readonly createdAtMs: number;
}

export interface SessionSourceTurnRecord {
  readonly turnId: string;
  readonly sourceStartedAtMs: number;
  readonly sources: readonly SessionSourceRecord[];
  /** Internal stable ordering boundary; never exposed through DesktopService. */
  readonly cursorRowId: number;
}

export interface SessionSourceRepositoryPage {
  readonly sourcedTurnCount: number;
  readonly sourceCount: number;
  readonly recentSources: readonly SessionSourceRecord[];
  readonly turns: readonly SessionSourceTurnRecord[];
  readonly hasMore: boolean;
}

export interface SessionSourceProjectionRepository {
  list(input: {
    readonly sessionId: string;
    readonly limit: number;
    readonly beforeRowId?: number;
  }): Promise<SessionSourceRepositoryPage>;
  hasOccurrence(sessionId: string, messageId: string, toolCallId: string): Promise<boolean>;
}
