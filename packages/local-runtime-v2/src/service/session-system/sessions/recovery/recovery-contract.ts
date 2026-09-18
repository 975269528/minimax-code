export interface SessionProcessRestartRecoveryResult {
  readonly interruptedSessionIds: readonly string[];
}

export interface SessionProcessRestartRecovery {
  recoverPreviousProcess(input: {
    readonly processStartedAtMs: number;
    readonly protectedSessionIds?: readonly string[];
  }): Promise<SessionProcessRestartRecoveryResult>;
}
