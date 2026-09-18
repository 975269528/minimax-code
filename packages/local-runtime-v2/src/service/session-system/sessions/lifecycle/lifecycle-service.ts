import type { SessionRecord } from '../repo/contract.js';
import type { SessionMutationFields } from './lifecycle-contract.js';
import type { MaintenanceMutationLane, SessionMaintenanceService } from './maintenance-service.js';
import type {
  InternalSessionCreateInput,
  SessionCommittedFact,
  SessionCreateInput,
  SessionInternalCreationCapability,
  SessionRootCreationCapability,
} from './record-service.js';

export interface SessionArchiveCapability {
  archiveSessionById(sessionId: string): Promise<void>;
}

export interface SessionLifecycleFactSink {
  handle(fact: SessionCommittedFact): void;
}

export interface SessionLifecycleRecordPort {
  createSession(input: SessionCreateInput): Promise<SessionRecord>;
  createInternalSession(input: InternalSessionCreateInput): Promise<SessionRecord>;
  createRootSession(input: {
    readonly agentName: string;
    readonly workspaceDir?: string;
    readonly isDefaultWorkspace?: boolean;
  }): Promise<SessionRecord>;
  mutateSession(sessionId: string, fields: SessionMutationFields): Promise<SessionRecord>;
}

export interface SessionLifecycleServiceOptions {
  readonly records: SessionLifecycleRecordPort;
  readonly maintenance: SessionMaintenanceService;
  readonly preferences: { removePin(sessionId: string): Promise<void> };
  readonly clearSessionReference: (session: SessionRecord) => Promise<void>;
  readonly facts: SessionLifecycleFactSink;
}

export class SessionLifecycleService
  implements
    SessionArchiveCapability,
    SessionRootCreationCapability,
    SessionInternalCreationCapability
{
  constructor(private readonly options: SessionLifecycleServiceOptions) {}

  createSession(input: SessionCreateInput): Promise<SessionRecord> {
    return this.options.records.createSession(input);
  }

  createInternalSession(input: InternalSessionCreateInput): Promise<SessionRecord> {
    return this.options.records.createInternalSession(input);
  }

  createRootSession(input: {
    readonly agentName: string;
    readonly workspaceDir?: string;
    readonly isDefaultWorkspace?: boolean;
  }): Promise<SessionRecord> {
    return this.options.records.createRootSession(input);
  }

  archiveSession(sessionId: string, archived = true): Promise<SessionRecord> {
    return this.mutateSession(sessionId, { archived });
  }

  mutateSession(sessionId: string, fields: SessionMutationFields): Promise<SessionRecord> {
    if (fields.archived !== true) return this.mutateAndEmit(sessionId, fields);
    return this.options.maintenance.runExclusive(sessionId, (lane) =>
      this.archiveSessionInMaintenanceLane(sessionId, lane),
    );
  }

  async archiveSessionInMaintenanceLane(
    sessionId: string,
    lane: MaintenanceMutationLane,
  ): Promise<SessionRecord> {
    const fields: SessionMutationFields = { archived: true };
    const updated = await lane.run(() => this.options.records.mutateSession(sessionId, fields));
    await lane.run(() => this.options.clearSessionReference(updated));
    await lane.run(() => this.options.preferences.removePin(sessionId));
    this.emitMutationFacts(updated, fields);
    return updated;
  }

  async archiveSessionById(sessionId: string): Promise<void> {
    await this.archiveSession(sessionId, true);
  }

  private async mutateAndEmit(
    sessionId: string,
    fields: SessionMutationFields,
  ): Promise<SessionRecord> {
    const updated = await this.options.records.mutateSession(sessionId, fields);
    this.emitMutationFacts(updated, fields);
    return updated;
  }

  private emitMutationFacts(session: SessionRecord, fields: SessionMutationFields): void {
    if (fields.title !== undefined && fields.title !== null) {
      this.options.facts.handle({ kind: 'title-updated', session, title: fields.title });
    }
    if (
      Object.hasOwn(fields, 'effectiveModel') ||
      Object.hasOwn(fields, 'effectiveModelVariant') ||
      Object.hasOwn(fields, 'effectiveModelThinking') ||
      Object.hasOwn(fields, 'effectiveModelContextWindow') ||
      Object.hasOwn(fields, 'effectiveModelMaxOutputTokens')
    ) {
      this.options.facts.handle({ kind: 'model-updated', session });
    }
    if (fields.archived !== undefined) {
      this.options.facts.handle({
        kind: 'archive-changed',
        sessionId: session.sessionId,
        archived: fields.archived,
      });
    }
    if (Object.hasOwn(fields, 'interactionMode')) {
      this.options.facts.handle({ kind: 'interaction-mode-updated', session });
    }
  }
}
