import { PeekContextService, StaleCompactionMessageRepair } from './messages/index.js';
import type { PromptSnapshotSource } from '@mavis/agent-runtime';
import { initializeSessionDiffCapability, type SessionDiffService } from './diffs/index.js';
import {
  RootArchiveTitleService,
  SessionDeletionService,
  SessionLifecycleService,
  SessionMaintenanceService,
  type RootArchiveTitleFactObserver,
  type RootArchiveTitleModel,
  type SessionFactSink,
  type SessionMaintenanceGuard,
} from './sessions/index.js';
import type { CommittedQueueCapability, QueueCommittedFactSink } from './queue/index.js';
import type { SessionSystemOwner } from './owner.js';
import type { SessionConversationFactSink } from './agent-projection.js';

export * from './sessions/repo/drizzle.js';
export * from './sessions/representation/canonical-history.js';
export * from './usage/repo/drizzle.js';
export * from './projects/repo/drizzle.js';
export { createSessionAssetRepository } from './files/repo/assets.js';
export * from './messages/repo/drizzle.js';
export * from './queue/repo/drizzle.js';
export * from './legacy-migration/repo/migration-repository.js';
export * from './owner.js';

export interface SessionApplicationFactPorts {
  readonly session: SessionFactSink;
  readonly queue: QueueCommittedFactSink;
  readonly archiveTitle?: RootArchiveTitleFactObserver;
}

export interface SessionSystemFactPorts extends SessionApplicationFactPorts {
  readonly conversation: SessionConversationFactSink;
}

export interface SessionSystemExternalPorts {
  readonly diff: {
    deleteSession(sessionId: string): Promise<void>;
  };
  readonly communication: {
    deleteSession(sessionId: string): Promise<void>;
  };
  readonly channelBindings: {
    deleteSession(sessionId: string): Promise<void>;
  };
  readonly questionnaires: {
    deleteSession(sessionId: string): Promise<void>;
  };
  readonly permissions: {
    deleteSession(sessionId: string): Promise<void>;
  };
  readonly goals: {
    deleteSession(sessionId: string): Promise<void>;
  };
}

export interface InitializeSessionApplicationSystemOptions {
  /** The only Session owner graph. No repository may be constructed here. */
  readonly owner: SessionSystemOwner;
  readonly pin: {
    removeSession(sessionId: string): Promise<void>;
  };
  readonly canvas: {
    deleteSession(sessionId: string): Promise<void>;
  };
  readonly compatibility: SessionSystemExternalPorts;
  readonly archiveTitleModel: RootArchiveTitleModel;
  /** Optional shared source for direct title-generation model calls. */
  readonly promptSnapshots?: PromptSnapshotSource;
  readonly maintenance: SessionMaintenanceGuard;
  readonly facts: SessionApplicationFactPorts;
  readonly processStartedAtMs: number;
  readonly locale?: () => string;
}

export interface InitializedSessionApplicationSystem {
  readonly repositories: SessionSystemOwner['repositories'];
  readonly session: {
    readonly query: SessionSystemOwner['sessions']['query'];
    readonly lifecycle: SessionLifecycleService;
    readonly maintenance: SessionMaintenanceService;
    readonly deletion: {
      create(): SessionDeletionService;
    };
  };
  readonly messages: {
    readonly query: SessionSystemOwner['messages']['query'];
    readonly sources: SessionSystemOwner['messages']['sources'];
    readonly conversationActions: SessionSystemOwner['messages']['conversationActions'];
    readonly inputSummaries: SessionSystemOwner['messages']['inputSummaries'];
    readonly staleCompactionRepair: StaleCompactionMessageRepair;
    readonly peekContext: PeekContextService;
  };
  readonly files: SessionSystemOwner['files'];
  readonly usage: SessionSystemOwner['usage']['service'];
  readonly queryCollapse: SessionSystemOwner['queryCollapse']['state'];
  readonly root: {
    readonly invariant: SessionSystemOwner['sessions']['root'];
    readonly archiveTitle: RootArchiveTitleService;
    readonly archiveTitleModel: RootArchiveTitleModel;
  };
  readonly diff: SessionDiffService;
  readonly queue: {
    readonly committed: Pick<
      CommittedQueueCapability,
      | 'requireMutableSession'
      | 'snapshot'
      | 'list'
      | 'get'
      | 'enqueue'
      | 'update'
      | 'reorder'
      | 'cancel'
    >;
  };
  readonly stream: SessionSystemOwner['stream'];
  readonly project: SessionSystemOwner['projects']['service'];
  readonly sidebar: SessionSystemOwner['projects']['sidebar'];
  readonly cleanup: {
    readonly deleteCanvas: (sessionId: string) => Promise<void>;
    readonly deleteArtifacts: (
      sessionId: string,
      options?: { readonly preserveUsage?: boolean },
    ) => Promise<void>;
    readonly deleteDiff: (sessionId: string) => Promise<void>;
    readonly deleteCommunication: (sessionId: string) => Promise<void>;
    readonly deleteChannelBindings: (sessionId: string) => Promise<void>;
    readonly deleteQuestionnaires: (sessionId: string) => Promise<void>;
    readonly deletePermissions: (sessionId: string) => Promise<void>;
    readonly deleteGoal: (sessionId: string) => Promise<void>;
    readonly deleteQueryCollapse: (sessionId: string) => Promise<void>;
    readonly removePin: (sessionId: string) => Promise<void>;
    readonly markLegacyMigrationDeleted: (sessionId: string) => Promise<void>;
  };
}

/**
 * Adds Application use cases to the already-owned Session graph. This function
 * intentionally accepts no AppDb and creates no repository or duplicate
 * Session service.
 */
export function initializeSessionApplicationSystem(
  options: InitializeSessionApplicationSystemOptions,
): InitializedSessionApplicationSystem {
  const owner = options.owner;
  const maintenance = new SessionMaintenanceService(options.maintenance);
  const lifecycle = new SessionLifecycleService({
    clearSessionReference: (session) => owner.sessions.root.clearSessionReference(session),
    records: owner.sessions.records,
    maintenance,
    preferences: { removePin: (sessionId) => options.pin.removeSession(sessionId) },
    facts: options.facts.session,
  });
  const staleCompactionRepair = new StaleCompactionMessageRepair({
    messages: owner.repositories.messages,
    processStartedAtMs: options.processStartedAtMs,
  });
  const peekContext = new PeekContextService({
    sessions: owner.repositories.sessions,
    messages: owner.repositories.messages,
    readiness: owner.legacy,
  });
  const archiveTitle = new RootArchiveTitleService({
    sessions: owner.repositories.sessions,
    messages: {
      listRecent: async (sessionId, input) =>
        (await owner.repositories.messages.listRecent(sessionId, input)).flatMap((message) => {
          if (typeof message.role !== 'string') return [];
          return [
            {
              role: message.role,
              content: message.msg_content ?? message.msgContent ?? message.content,
            },
          ];
        }),
    },
    model: options.archiveTitleModel,
    ...(options.promptSnapshots ? { promptSnapshots: options.promptSnapshots } : {}),
    ...(options.facts.archiveTitle ? { facts: options.facts.archiveTitle } : {}),
    ...(options.locale ? { locale: options.locale } : {}),
  });
  const cleanup = {
    deleteCanvas: (sessionId: string) => options.canvas.deleteSession(sessionId),
    deleteArtifacts: (sessionId: string, artifactOptions?: { readonly preserveUsage?: boolean }) =>
      owner.artifacts.deleteSession(sessionId, artifactOptions),
    deleteDiff: (sessionId: string) => options.compatibility.diff.deleteSession(sessionId),
    deleteCommunication: (sessionId: string) =>
      options.compatibility.communication.deleteSession(sessionId),
    deleteChannelBindings: (sessionId: string) =>
      options.compatibility.channelBindings.deleteSession(sessionId),
    deleteQuestionnaires: (sessionId: string) =>
      options.compatibility.questionnaires.deleteSession(sessionId),
    deletePermissions: (sessionId: string) =>
      options.compatibility.permissions.deleteSession(sessionId),
    deleteGoal: (sessionId: string) => options.compatibility.goals.deleteSession(sessionId),
    deleteQueryCollapse: (sessionId: string) => owner.queryCollapse.state.deleteSession(sessionId),
    removePin: (sessionId: string) => options.pin.removeSession(sessionId),
    markLegacyMigrationDeleted: (sessionId: string) => owner.legacy.markDeleted(sessionId),
  };

  return {
    repositories: owner.repositories,
    session: {
      query: owner.sessions.query,
      lifecycle,
      maintenance,
      deletion: {
        create: () =>
          new SessionDeletionService({
            sessions: owner.repositories.sessions,
            clearSessionReference: (session) => owner.sessions.root.clearSessionReference(session),
            records: owner.sessions.records,
            cleanup,
            facts: options.facts.session,
          }),
      },
    },
    messages: {
      query: owner.messages.query,
      sources: owner.messages.sources,
      conversationActions: owner.messages.conversationActions,
      inputSummaries: owner.messages.inputSummaries,
      staleCompactionRepair,
      peekContext,
    },
    files: owner.files,
    usage: owner.usage.service,
    queryCollapse: owner.queryCollapse.state,
    root: {
      invariant: owner.sessions.root,
      archiveTitle,
      archiveTitleModel: options.archiveTitleModel,
    },
    diff: initializeSessionDiffCapability(owner.repositories.sessions),
    queue: {
      committed: owner.queue.committed,
    },
    stream: owner.stream,
    project: owner.projects.service,
    sidebar: owner.projects.sidebar,
    cleanup,
  };
}
