export type {
  AgentSessionStateMutation,
  AgentSessionStateWriteResult,
  AppMode,
  SessionCreateInput as SessionRepositoryCreateInput,
  SessionDataOrigin,
  SessionAgentDefinitionBackfill,
  SessionInteractionMode,
  SessionKind,
  SessionListOptions,
  SessionOrigin,
  SessionPage,
  SessionRecord,
  SessionRepository,
  SessionRuntime,
  SessionStatus,
  SessionTaskAgentBindingBackfill,
  SessionType,
  SessionUpdateFields,
  SessionVisibility,
} from './repo/contract.js';

export type {
  AnyFrozenAgentExecutionDefinition,
  FrozenAgentExecutionDefinition,
  LegacyFrozenAgentExecutionDefinition,
  SessionAgentDefinition,
  SessionAgentDefinitionCreate,
  TaskSessionBinding,
  TaskSessionBindingCreate,
} from './repo/agent-binding.js';

export type {
  InternalSessionCreateInput,
  SessionCommittedFact,
  SessionCreateInput as DomainSessionCreateInput,
  SessionFactSink,
  SessionInternalCreationCapability,
  SessionMetadataCreateInput,
  SessionMetadataWriter,
  SessionRecordServiceDeps,
  SessionRootCreationCapability,
} from './lifecycle/record-service.js';
export type { SessionFailureReason } from './errors.js';
