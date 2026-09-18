import type {
  SessionDiffFailureReason,
  SessionDiffReader,
  SessionDiffTarget,
} from './contracts.js';

export class SessionDiffServiceError extends Error {
  constructor(
    readonly reason: SessionDiffFailureReason,
    readonly sessionId: string,
  ) {
    super(
      reason === 'session-not-found'
        ? `Session not found: ${sessionId}`
        : 'Legacy opencode Session diff is unavailable through the v2 Diff owner.',
    );
    this.name = 'SessionDiffServiceError';
  }
}

/** Owns eligibility only. Diff capture/query/revert/reapply storage remains external. */
export class SessionDiffService {
  constructor(private readonly sessions: SessionDiffReader) {}

  async requireTarget(sessionId: string): Promise<SessionDiffTarget> {
    const session = await this.sessions.get(sessionId);
    if (!session) throw new SessionDiffServiceError('session-not-found', sessionId);
    if (session.runtime === 'opencode') {
      throw new SessionDiffServiceError('runtime-unsupported', sessionId);
    }
    return { sessionId: session.sessionId, workspaceDir: session.workspaceDir };
  }
}
