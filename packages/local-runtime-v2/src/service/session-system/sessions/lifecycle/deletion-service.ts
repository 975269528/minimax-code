import type { SessionRecord } from '../repo/contract.js';
import { isPeekSession } from '../repo/normalization.js';
import { SessionServiceError } from '../errors.js';
import type { SessionFactSink } from './record-service.js';

export interface SessionDeletionServiceOptions {
  readonly sessions: {
    get(sessionId: string): Promise<SessionRecord | undefined>;
    reparentChildren(sessionId: string, parentSessionId: string | null): Promise<void>;
  };
  readonly clearSessionReference: (session: SessionRecord) => Promise<void>;
  readonly records: { deleteSessionRecord(sessionId: string): Promise<void> };

  readonly cleanup: {
    deleteCanvas(sessionId: string): Promise<void>;
    deleteArtifacts(
      sessionId: string,
      options?: { readonly preserveUsage?: boolean },
    ): Promise<void>;
    deleteDiff(sessionId: string): Promise<void>;
    deleteCommunication(sessionId: string): Promise<void>;
    deleteChannelBindings(sessionId: string): Promise<void>;
    deleteQuestionnaires(sessionId: string): Promise<void>;
    deletePermissions(sessionId: string): Promise<void>;
    deleteGoal(sessionId: string): Promise<void>;
    deleteQueryCollapse(sessionId: string): Promise<void>;
    removePin(sessionId: string): Promise<void>;
    markLegacyMigrationDeleted(sessionId: string): Promise<void>;
  };
  readonly facts: SessionFactSink;
}

export class SessionDeletionService {
  constructor(private readonly options: SessionDeletionServiceOptions) {}

  async deleteSession(sessionId: string): Promise<SessionRecord | undefined> {
    const current = await this.options.sessions.get(sessionId);
    if (!current) return undefined;
    if (current.runtime !== 'pi-agent') {
      throw new SessionServiceError(
        'runtime-unsupported',
        'Legacy opencode Session mutation is unavailable',
      );
    }
    await this.options.cleanup.markLegacyMigrationDeleted(sessionId);
    await this.options.cleanup.deleteCanvas(sessionId);
    // Peek Sessions are ephemeral, but their token/cost ledger is not. Drop
    // transcript, files and every other Session-owned artifact while retaining
    // the usage rows keyed by side sessionId + turnId for attribution.
    if (isPeekSession(current)) {
      await this.options.cleanup.deleteArtifacts(sessionId, { preserveUsage: true });
    } else {
      await this.options.cleanup.deleteArtifacts(sessionId);
    }
    await this.options.cleanup.deleteDiff(sessionId);
    await this.options.cleanup.deleteCommunication(sessionId);
    await this.options.cleanup.deleteChannelBindings(sessionId);
    await this.options.cleanup.deleteQuestionnaires(sessionId);
    await this.options.cleanup.deletePermissions(sessionId);
    await this.options.cleanup.deleteGoal(sessionId);
    await this.options.cleanup.deleteQueryCollapse(sessionId);
    await this.options.cleanup.removePin(sessionId);
    await this.options.sessions.reparentChildren(sessionId, current.parentSessionId ?? null);
    await this.options.clearSessionReference(current);
    await this.options.records.deleteSessionRecord(sessionId);
    this.options.facts.handle({ kind: 'deleted', sessionId });
    return current;
  }
}
