import type { SessionRecord } from '../sessions/repo/contract.js';

export interface SessionDiffTarget {
  readonly sessionId: string;
  readonly workspaceDir: string;
}

export interface SessionDiffReader {
  get(sessionId: string): Promise<SessionRecord | undefined>;
}

export type SessionDiffFailureReason = 'session-not-found' | 'runtime-unsupported';
