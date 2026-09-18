import {
  type CronSessionCreationPort,
  type CronSessionCreationRequest,
  type CronSessionCreationResult,
} from '../contracts.js';

/**
 * Session-side port used by Cron to create or validate target sessions. Composition binds it to the
 * real agent runtime host; tests use an in-memory substitute. Keeping the port here makes agent
 * ownership validation deterministic.
 */
interface CronAgentDescriptor {
  readonly agentName: string;
  readonly defaultWorkspaceDir?: string;
}

interface CronSessionDescriptor {
  readonly sessionId: string;
  readonly agentName: string;
}

interface CronTargetSessionDescriptor extends CronSessionDescriptor {
  readonly archived: boolean;
}

export interface CronSessionHostPort {
  /** Resolve normalized write ownership only for a new session created for this run. */
  resolveAgentWriteTarget(agentName: string): Promise<string>;
  /** Resolve an agent by name; return undefined if it does not exist. */
  getAgent(agentName: string): Promise<CronAgentDescriptor | undefined>;
  /** Resolve a session by id; return undefined if it does not exist. */
  getSession(sessionId: string): Promise<CronTargetSessionDescriptor | undefined>;
  /** Create a fresh session for a run and return its concrete id. */
  createSession(request: CronCreateSessionRequest): Promise<CronSessionDescriptor>;
  /** Update the user-visible title of a fixed session. */
  renameSession(sessionId: string, title: string): Promise<void>;
  discardSession(sessionId: string): Promise<void>;
  detachCronSessions?(cronId: string, targetSessionId?: string): Promise<void>;
  /** Resolve a fallback workspace when the agent has no default workspace. */
  resolveDefaultWorkspaceDir(): string;
}

interface CronCreateSessionRequest {
  readonly agentName: string;
  readonly cronId: string;
  readonly cronName: string;
  readonly runCreatedAtMs: number;
  readonly workspaceDir: string;
  /** A task-selected workspace is a Project, not the runtime's fallback Project. */
  readonly isDefaultWorkspace: boolean;
  readonly model?: string | null;
}

type CronSessionCreationErrorCode =
  | 'CRON_SESSION_INVALID_ARGUMENT'
  | 'CRON_SESSION_AGENT_NOT_FOUND'
  | 'CRON_SESSION_TARGET_NOT_FOUND'
  | 'CRON_SESSION_TARGET_ARCHIVED'
  | 'CRON_SESSION_TARGET_AGENT_MISMATCH'
  | 'CRON_SESSION_WORKSPACE_FAILED'
  | 'CRON_SESSION_CREATE_FAILED'
  | 'CRON_SESSION_INVALID_RESULT';

class CronSessionCreationError extends Error {
  override readonly name = 'CronSessionCreationError';

  constructor(
    readonly code: CronSessionCreationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Host-backed {@link CronSessionCreationPort}. Validate the owning agent first; reuse the target
 * session if it belongs to that agent, otherwise create a new session for this run.
 */
export function createHostCronSessionCreation(host: CronSessionHostPort): CronSessionCreationPort {
  const detachCronSessions = host.detachCronSessions;
  return {
    create: (request) => createSession(host, request),
    rename: (sessionId, title) =>
      host.renameSession(requireIdentifier(sessionId), requireIdentifier(title)),
    discard: (sessionId) => host.discardSession(requireIdentifier(sessionId)),
    ...(detachCronSessions
      ? {
          detach: (cronId: string, targetSessionId?: string) =>
            detachCronSessions(
              requireIdentifier(cronId),
              targetSessionId ? requireIdentifier(targetSessionId) : undefined,
            ),
        }
      : {}),
  };
}

async function createSession(
  host: CronSessionHostPort,
  request: CronSessionCreationRequest,
): Promise<CronSessionCreationResult> {
  const requestedAgentName = requireIdentifier(request.agentName);
  const cronId = requireIdentifier(request.cronId);
  const cronName = requireIdentifier(request.cronName);
  requireIdentifier(request.runId);
  const runCreatedAtMs = requireUnixMs(request.runCreatedAtMs);

  if (request.sessionTarget.mode === 'sessionId' && request.sessionTarget.sessionId !== undefined) {
    await requireAgent(host, requestedAgentName);
    return resolveTargetSession(host, requestedAgentName, request.sessionTarget.sessionId);
  }

  const agentName = requireIdentifier(await host.resolveAgentWriteTarget(requestedAgentName));
  const agent = await requireAgent(host, agentName);

  const workspaceDir =
    request.project?.trim() || agent.defaultWorkspaceDir || resolveWorkspace(host);
  let created: CronSessionDescriptor;
  try {
    created = await host.createSession({
      agentName,
      cronId,
      cronName,
      runCreatedAtMs,
      workspaceDir,
      isDefaultWorkspace: !request.project?.trim(),
      ...(request.model === undefined ? {} : { model: request.model }),
    });
  } catch {
    throw new CronSessionCreationError(
      'CRON_SESSION_CREATE_FAILED',
      'Cron session creation failed',
    );
  }
  return { sessionId: requireResultSessionId(created, agentName) };
}

async function requireAgent(
  host: CronSessionHostPort,
  agentName: string,
): Promise<CronAgentDescriptor> {
  const agent = await host.getAgent(agentName);
  if (agent) return agent;
  throw new CronSessionCreationError(
    'CRON_SESSION_AGENT_NOT_FOUND',
    'Cron session agent was not found',
  );
}

async function resolveTargetSession(
  host: CronSessionHostPort,
  agentName: string,
  rawSessionId: string,
): Promise<CronSessionCreationResult> {
  const sessionId = requireIdentifier(rawSessionId);
  const session = await host.getSession(sessionId);
  if (!session) {
    throw new CronSessionCreationError(
      'CRON_SESSION_TARGET_NOT_FOUND',
      'Cron target session was not found',
    );
  }
  if (session.agentName !== agentName) {
    const [resolvedSessionAgentName, resolvedDefinitionAgentName] = await Promise.all([
      host.resolveAgentWriteTarget(session.agentName),
      host.resolveAgentWriteTarget(agentName),
    ]);
    if (
      requireIdentifier(resolvedSessionAgentName) !== requireIdentifier(resolvedDefinitionAgentName)
    ) {
      throw new CronSessionCreationError(
        'CRON_SESSION_TARGET_AGENT_MISMATCH',
        'Cron target session belongs to a different agent',
      );
    }
  }
  if (session.archived) {
    throw new CronSessionCreationError(
      'CRON_SESSION_TARGET_ARCHIVED',
      'Cron target session is archived',
    );
  }
  return { sessionId };
}

function resolveWorkspace(host: CronSessionHostPort): string {
  try {
    return host.resolveDefaultWorkspaceDir();
  } catch {
    throw new CronSessionCreationError(
      'CRON_SESSION_WORKSPACE_FAILED',
      'Cron session workspace resolution failed',
    );
  }
}

function requireResultSessionId(session: CronSessionDescriptor, agentName: string): string {
  const sessionId = typeof session.sessionId === 'string' ? session.sessionId.trim() : '';
  if (
    sessionId.length === 0 ||
    sessionId !== session.sessionId ||
    session.agentName !== agentName
  ) {
    throw new CronSessionCreationError(
      'CRON_SESSION_INVALID_RESULT',
      'Cron session creation returned an invalid result',
    );
  }
  return sessionId;
}

function requireIdentifier(value: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length > 0) return normalized;
  throw new CronSessionCreationError(
    'CRON_SESSION_INVALID_ARGUMENT',
    'Cron session creation requires non-empty identifiers',
  );
}

function requireUnixMs(value: number): number {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  throw new CronSessionCreationError(
    'CRON_SESSION_INVALID_ARGUMENT',
    'Cron session creation requires a valid run timestamp',
  );
}
