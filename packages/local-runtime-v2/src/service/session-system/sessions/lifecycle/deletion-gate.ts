import { and, eq } from 'drizzle-orm';

import type { AppDb } from '../../../../infra/db/client.js';
import { sessions } from '../../../../infra/db/schema/sessions.js';
import type { QueueEnqueueAdmission } from '../../queue/repo/contract.js';

export type SessionDeletionStartResult =
  | { readonly status: 'started' | 'already-deleting' }
  | { readonly status: 'not-found' };

export interface TurnSessionAdmission {
  rejectionInTransaction(
    db: AppDb,
    input: { readonly sessionId: string },
  ): 'invalid-session' | 'session-deleting' | undefined;
}

export interface SessionDeletionGateOptions {
  readonly db: AppDb;
}

/**
 * Coordinates deletion only inside the owning local-runtime process.
 *
 * Durable Turn settlement remains in TurnSystem. The Session gate deliberately
 * does not persist deletion state or fence unrelated Session tree mutations.
 */
export class SessionDeletionGate {
  readonly turnAdmission: TurnSessionAdmission;
  readonly queueAdmission: QueueEnqueueAdmission;
  private readonly deleting = new Set<string>();

  constructor(private readonly options: SessionDeletionGateOptions) {
    this.turnAdmission = {
      rejectionInTransaction: (db, input) => this.turnRejection(db, input.sessionId),
    };
    this.queueAdmission = {
      rejectionInTransaction: (db, input) => this.queueRejection(db, input.sessionId),
    };
  }

  begin(sessionId: string): Promise<SessionDeletionStartResult> {
    if (!sessionExists(this.options.db, sessionId)) {
      this.deleting.delete(sessionId);
      return Promise.resolve({ status: 'not-found' });
    }
    const status = this.deleting.has(sessionId) ? 'already-deleting' : 'started';
    this.deleting.add(sessionId);
    return Promise.resolve({ status });
  }

  complete(sessionId: string): void {
    this.deleting.delete(sessionId);
  }

  private turnRejection(
    db: AppDb,
    sessionId: string,
  ): 'invalid-session' | 'session-deleting' | undefined {
    if (!sessionExists(db, sessionId)) return 'invalid-session';
    return this.deleting.has(sessionId) ? 'session-deleting' : undefined;
  }

  private queueRejection(
    db: AppDb,
    sessionId: string,
  ): 'session-not-found' | 'maintenance-active' | undefined {
    const rejection = this.turnRejection(db, sessionId);
    if (rejection === 'invalid-session') return 'session-not-found';
    return rejection === 'session-deleting' ? 'maintenance-active' : undefined;
  }
}

function sessionExists(db: AppDb, sessionId: string): boolean {
  return Boolean(
    db
      .select({ sessionId: sessions.sessionId })
      .from(sessions)
      .where(and(eq(sessions.sessionId, sessionId), eq(sessions.columnarVersion, 3)))
      .get(),
  );
}
