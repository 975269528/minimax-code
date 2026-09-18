import type {
  AgentSessionStateWriteResult,
  AgentSessionTerminalOutcome,
  SessionRecord,
  SessionRepository,
  SessionStatus,
  SessionUpdateFields,
} from '../repo/contract.js';

export type SessionsService = Pick<
  SessionRepository,
  | 'get'
  | 'getMany'
  | 'has'
  | 'create'
  | 'update'
  | 'delete'
  | 'listPage'
  | 'searchPage'
  | 'listRootPage'
  | 'listProjectRootPage'
  | 'listChildrenMany'
  | 'count'
  | 'touch'
>;

export interface AgentSessionEventIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnSequence: number;
  readonly eventId: string;
  readonly runtimeSeq?: number;
}

export interface AgentSessionTerminalInput extends AgentSessionEventIdentity {
  readonly outcome: AgentSessionTerminalOutcome;
  readonly errorMessage?: string;
  readonly errorCode?: number;
  readonly errorSource?: string;
  readonly errorDetail?: string;
}

export interface SessionStateWriter {
  markStarted(input: AgentSessionEventIdentity): Promise<AgentSessionStateWriteResult>;
  markIdle(input: AgentSessionEventIdentity): Promise<AgentSessionStateWriteResult>;
  markTerminal(input: AgentSessionTerminalInput): Promise<AgentSessionStateWriteResult>;
}

export interface SessionAbortStateWriter {
  markAborted(input: {
    readonly sessionId: string;
    readonly errorMessage: string;
  }): Promise<boolean>;
}

export type SessionExecutionSnapshot = Readonly<SessionRecord>;

export interface SessionExecutionSource {
  getExecutionSnapshot(sessionId: string): Promise<SessionExecutionSnapshot | undefined>;
}

export interface SessionExecutionReadiness {
  ensureExecutionReady(sessionId: string): Promise<unknown>;
}

export function createSessionsService(repository: SessionRepository): SessionsService {
  return repository;
}

export function createSessionStateWriter(
  repository: Pick<SessionRepository, 'applyAgentState'>,
): SessionStateWriter {
  return {
    markStarted: (input) => repository.applyAgentState({ ...input, update: { status: 'started' } }),
    markIdle: (input) => repository.applyAgentState({ ...input, update: { status: 'idle' } }),
    markTerminal: (input) =>
      repository.applyAgentState({
        ...input,
        terminalOutcome: input.outcome,
        update: terminalStateUpdate(input),
      }),
  };
}

export function createSessionAbortWriter(
  repository: Pick<SessionRepository, 'update'>,
): SessionAbortStateWriter {
  return {
    markAborted: async ({ sessionId, errorMessage }) =>
      Boolean(await repository.update(sessionId, { status: 'aborted', errorMessage })),
  };
}

export function createSessionExecutionSource(
  repository: Pick<SessionRepository, 'get'>,
  readiness?: SessionExecutionReadiness,
): SessionExecutionSource {
  return {
    getExecutionSnapshot: async (sessionId) => {
      await readiness?.ensureExecutionReady(sessionId);
      const record = await repository.get(sessionId);
      return record ? freezeExecutionSnapshot(record) : undefined;
    },
  };
}

function terminalStateUpdate(input: AgentSessionTerminalInput): SessionUpdateFields & {
  readonly status: SessionStatus;
} {
  if (input.outcome === 'completed') return { status: 'idle' };
  if (input.outcome === 'aborted') return { status: 'aborted' };
  return {
    status: 'error',
    errorMessage: input.errorMessage ?? 'Agent turn failed',
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    ...(input.errorSource ? { errorSource: input.errorSource } : {}),
    ...(input.errorDetail ? { errorDetail: input.errorDetail } : {}),
  };
}

function freezeExecutionSnapshot(record: SessionRecord): SessionExecutionSnapshot {
  const runLocation = record.runLocation ? Object.freeze({ ...record.runLocation }) : undefined;
  return Object.freeze({ ...record, runLocation });
}
