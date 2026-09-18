export interface SessionTurnDeletionCapability {
  run(sessionId: string, cleanup: () => Promise<void>): Promise<void>;
}
