import type { AgentMessage } from '@mavis/agent-core/protocol/agent-message';
import type { CloudSessionReader, LocalMavisSessionAdapter } from '@mavis/agent-tools/desktop';
import {
  ConversationTurnRejectedError,
  isRuntimeConversationShutdownError,
  isRuntimeConversationUnavailableError,
  type RuntimeConversation,
} from '@mavis/conversation-contract';
import { logger } from '../common/logger.js';
import type { LocalSessionListOptions, LocalSessionRecord } from '../sessions/controller.js';

export { buildMavisCronAdapter } from './mavis-cron-adapter.js';

interface HostMavisSessionDeps {
  cloudReader?: Pick<CloudSessionReader, 'getSession' | 'getMessages'>;
  conversation: {
    readonly query: Pick<RuntimeConversation['query'], 'getSession'>;
    readonly ingress: Pick<RuntimeConversation['ingress'], 'submit' | 'abort'>;
  };
  listAllSessions(
    agentName?: string,
    options?: LocalSessionListOptions,
  ): Promise<LocalSessionRecord[]>;
  getSessionById(sessionId: string): Promise<LocalSessionRecord | undefined>;
  serializeSessions(sessions: LocalSessionRecord[]): Promise<Array<Record<string, unknown>>>;
  serializeSession(session: LocalSessionRecord): Promise<Record<string, unknown>>;
  updateSession(
    sessionId: string,
    fields: Partial<Pick<LocalSessionRecord, 'archived' | 'title'>>,
  ): Promise<LocalSessionRecord | undefined>;
  deleteSession(sessionId: string): Promise<void>;
  deleteMessageState(sessionId: string): Promise<void>;
  deleteQueuedMessages(sessionId: string): Promise<void>;
  markMigratedLegacySessionDeleted(sessionId: string): Promise<boolean>;
  clearRootSessionIf(sessionId: string): void;
  listDisplayMessages(
    sessionId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<{ messages: AgentMessage[]; nextCursor?: string; hasMore?: boolean }>;
  resolveAgentReadScope?: (requestedName: string) => Promise<{
    compatibleNames: readonly string[];
  }>;
}

export function buildMavisSessionAdapter(deps: HostMavisSessionDeps): LocalMavisSessionAdapter {
  return {
    listSessions: async (req) => {
      const archived =
        req.archiveFilter === 'Archived'
          ? true
          : req.archiveFilter === 'Unarchived'
            ? false
            : undefined;
      const scope =
        req.agentName && deps.resolveAgentReadScope
          ? await deps.resolveAgentReadScope(req.agentName)
          : undefined;
      const sessions = (
        await deps.listAllSessions(scope ? undefined : req.agentName, {
          archived,
          ...(scope ? { agentNames: scope.compatibleNames } : {}),
        })
      ).filter(
        (session) =>
          req.parentSessionId === undefined || session.parentSessionId === req.parentSessionId,
      );
      const page = pageBySessionCursor(sessions, req.cursor, req.limit);
      return {
        sessions: await deps.serializeSessions(page.items),
        hasMore: page.hasMore,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
    getSession: async (req, signal) => {
      if (req.source === 'cloud') {
        if (!deps.cloudReader) throw new Error('Cloud session reading is unavailable on this host');
        return deps.cloudReader.getSession(req.sessionId, signal);
      }
      const session = await deps.getSessionById(req.sessionId);
      return { ...(session ? { session: await deps.serializeSession(session) } : {}) };
    },
    updateSession: async (req) => {
      const current = await deps.getSessionById(req.sessionId);
      if (!current) {
        throw Object.assign(new Error(`Session not found: ${req.sessionId}`), {
          status: 404,
          code: 'SESSION_NOT_FOUND',
        });
      }
      const updated = await deps.updateSession(req.sessionId, {
        ...(Object.hasOwn(req, 'title') ? { title: req.title } : {}),
        ...(Object.hasOwn(req, 'archived') ? { archived: req.archived } : {}),
      });
      return { session: await deps.serializeSession(updated ?? current), success: true };
    },
    deleteSession: async (req) => {
      const session = await deps.getSessionById(req.sessionId);
      if (!session) {
        throw Object.assign(new Error(`Session not found: ${req.sessionId}`), {
          status: 404,
          code: 'SESSION_NOT_FOUND',
        });
      }
      await deps.deleteSession(req.sessionId);
      await deps.deleteMessageState(req.sessionId);
      await deps.deleteQueuedMessages(req.sessionId);
      await deps.markMigratedLegacySessionDeleted(req.sessionId);
      deps.clearRootSessionIf(req.sessionId);
      return { success: true };
    },
    listMessages: async (req, signal) => {
      if (req.source === 'cloud') {
        if (!deps.cloudReader) throw new Error('Cloud session reading is unavailable on this host');
        return deps.cloudReader.getMessages(req.sessionId, req, signal);
      }
      const page = await deps.listDisplayMessages(req.sessionId, {
        ...(req.limit !== undefined ? { limit: req.limit } : {}),
        ...(req.before ? { before: req.before } : {}),
      });
      return {
        messages: page.messages,
        hasMore: page.hasMore,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
    sendSession: (req, signal) => sendToLocalSession(deps.conversation, req, signal),
  };
}

/**
 * SessionSend admits one synchronous Turn in any reachable, unarchived local
 * Session. Reachability is the whole access model: the caller identity comes
 * from the runtime context, the target must be resolvable through the canonical
 * Session query, and everything after that is TurnSystem admission. There is no
 * topology check — a task child, a sibling, a root Session and the caller's own
 * Session all take the same path, and a self-send simply finds its own Turn
 * active and comes back as `SESSION_BUSY`.
 */
async function sendToLocalSession(
  conversation: HostMavisSessionDeps['conversation'],
  req: { callerSessionId: string; sessionId: string; content: string },
  signal?: AbortSignal,
): ReturnType<LocalMavisSessionAdapter['sendSession']> {
  // Logged once per call so every later line — admission, rejection, terminal
  // — can be correlated back to the caller that asked for it. The caller id
  // never comes from the model, so this pair is also the audit record of who
  // reached which Session.
  logger.info(
    { callerSessionId: req.callerSessionId, sessionId: req.sessionId },
    'Session send requested',
  );
  try {
    throwIfSessionSendAborted(signal, req.sessionId, 'aborted-before-target-query');

    const target = await conversation.query.getSession(req.sessionId);
    if (!target) {
      throw sessionSendError(`Session not found: ${req.sessionId}`, {
        status: 404,
        code: 'SESSION_NOT_FOUND',
        sessionId: req.sessionId,
        reason: 'target-unresolvable',
      });
    }
    if (target.archived) {
      throw sessionSendError(`Session is archived: ${req.sessionId}`, {
        status: 409,
        code: 'SESSION_ARCHIVED',
        sessionId: req.sessionId,
        reason: 'target-archived',
      });
    }
    throwIfSessionSendAborted(signal, req.sessionId, 'aborted-before-admission');

    const accepted = await conversation.ingress.submit({
      sessionId: req.sessionId,
      source: 'communication',
      allowQueue: false,
      message: { content: req.content, attachments: [] },
    });
    logger.info(
      {
        callerSessionId: req.callerSessionId,
        sessionId: req.sessionId,
        turnId: accepted.turnId,
      },
      'Session send admitted a Turn',
    );
    let abortRequested = false;
    const abortAcceptedTurn = () => {
      if (abortRequested) return;
      abortRequested = true;
      logger.info(
        { sessionId: req.sessionId, turnId: accepted.turnId, reason: 'caller-abort' },
        'Session send is aborting the Turn it admitted',
      );
      // Best-effort: the completion below is the authoritative outcome, so a
      // failed abort must not replace it. It still gets logged rather than
      // swallowed, because a Turn that refuses to abort is the interesting case.
      void conversation.ingress.abort(req.sessionId, 'lifecycle').catch((error: unknown) => {
        logger.warn(
          {
            sessionId: req.sessionId,
            turnId: accepted.turnId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Session send could not abort the Turn it admitted',
        );
      });
    };
    signal?.addEventListener('abort', abortAcceptedTurn, { once: true });
    if (signal?.aborted) abortAcceptedTurn();

    try {
      let result: Awaited<typeof accepted.completion>;
      try {
        result = await accepted.completion;
      } catch (error) {
        if (
          isRuntimeConversationUnavailableError(error) ||
          isRuntimeConversationShutdownError(error)
        ) {
          throw error;
        }
        throw sessionSendError(
          error instanceof Error ? error.message : 'Session Turn completion failed',
          {
            status: 500,
            code: 'SESSION_TURN_FAILED',
            sessionId: req.sessionId,
            turnId: accepted.turnId,
            reason: 'completion-rejected',
          },
        );
      }
      if (result.status === 'aborted') {
        throw sessionSendError(result.error ?? 'Session Turn was aborted', {
          status: 409,
          code: 'SESSION_TURN_ABORTED',
          sessionId: req.sessionId,
          turnId: accepted.turnId,
          reason: 'terminal-aborted',
        });
      }
      if (result.status === 'failed') {
        throw sessionSendError(result.error ?? 'Session Turn failed', {
          status: 500,
          code: 'SESSION_TURN_FAILED',
          sessionId: req.sessionId,
          turnId: accepted.turnId,
          reason: 'terminal-failed',
        });
      }
      const content = result.messages
        .map((message) => (message.role === 'assistant' ? message.text : undefined))
        .filter((text): text is string => typeof text === 'string')
        .join('\n');
      logger.info(
        {
          callerSessionId: req.callerSessionId,
          sessionId: req.sessionId,
          turnId: accepted.turnId,
          contentLength: content.length,
        },
        'Session send completed',
      );
      return {
        sessionId: req.sessionId,
        turnId: accepted.turnId,
        status: 'completed',
        content,
      };
    } finally {
      signal?.removeEventListener('abort', abortAcceptedTurn);
    }
  } catch (error) {
    // Already-shaped rejections were logged where they were built; the two
    // remaining classes are translated here, and anything else is re-thrown
    // with a log so an unmapped failure never leaves the adapter unexplained.
    if (error instanceof SessionSendRuntimeError) throw error;
    if (error instanceof ConversationTurnRejectedError) {
      throw mapTurnRejection(error);
    }
    if (isRuntimeConversationUnavailableError(error) || isRuntimeConversationShutdownError(error)) {
      throw sessionSendError('Runtime Conversation is unavailable for session send', {
        status: 503,
        code: 'SESSION_SEND_UNAVAILABLE',
        sessionId: req.sessionId,
        reason: 'conversation-unavailable',
      });
    }
    logger.warn(
      {
        callerSessionId: req.callerSessionId,
        sessionId: req.sessionId,
        error: error instanceof Error ? error.message : String(error),
      },
      'Session send failed with an unmapped error',
    );
    throw error;
  }
}

function throwIfSessionSendAborted(
  signal: AbortSignal | undefined,
  sessionId: string,
  reason: string,
): void {
  if (!signal?.aborted) return;
  throw sessionSendError('Session send was aborted before Turn admission', {
    status: 409,
    code: 'SESSION_TURN_ABORTED',
    sessionId,
    reason,
  });
}

/**
 * Admission rejections carry the TurnSystem's own reason, which is strictly
 * more informative than the collapsed `SESSION_BUSY` the model sees. It is kept
 * in the log so a busy report can still be traced to compaction, deletion or a
 * priority fence — including the self-send case, where the reason is the
 * caller's own `active-turn`.
 */
function mapTurnRejection(error: ConversationTurnRejectedError): SessionSendRuntimeError {
  if (error.reason === 'invalid-session') {
    return sessionSendError(`Session not found: ${error.sessionId}`, {
      status: 404,
      code: 'SESSION_NOT_FOUND',
      sessionId: error.sessionId,
      reason: error.reason,
    });
  }
  if (
    error.reason === 'active-turn' ||
    error.reason === 'compaction-active' ||
    error.reason === 'session-deleting' ||
    error.reason === 'priority-blocked' ||
    error.reason === 'ingress-conflict'
  ) {
    return sessionSendError(`Session is busy: ${error.sessionId} (${error.reason})`, {
      status: 409,
      code: 'SESSION_BUSY',
      sessionId: error.sessionId,
      reason: error.reason,
    });
  }
  return sessionSendError(
    `Session Turn admission was rejected: ${error.sessionId} (${error.reason})`,
    {
      status: 409,
      code: 'SESSION_SEND_REJECTED',
      sessionId: error.sessionId,
      reason: error.reason,
    },
  );
}

class SessionSendRuntimeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly sessionId: string;
  readonly turnId?: string;

  constructor(
    message: string,
    details: { status: number; code: string; sessionId: string; turnId?: string },
  ) {
    super(message);
    this.name = 'SessionSendRuntimeError';
    this.status = details.status;
    this.code = details.code;
    this.sessionId = details.sessionId;
    if (details.turnId) this.turnId = details.turnId;
  }
}

/**
 * The single construction point for every SessionSend rejection, so the log and
 * the model-visible error can never drift apart. `code` is what an operator
 * greps for; `reason` names the branch that produced it, which matters most for
 * `SESSION_BUSY` (five distinct admission reasons) and `SESSION_TURN_ABORTED`
 * (aborted before the target query, before admission, or as a Turn terminal).
 */
function sessionSendError(
  message: string,
  details: {
    status: number;
    code: string;
    sessionId: string;
    turnId?: string;
    reason?: string;
  },
): SessionSendRuntimeError {
  logger.warn(
    {
      code: details.code,
      status: details.status,
      sessionId: details.sessionId,
      ...(details.turnId ? { turnId: details.turnId } : {}),
      ...(details.reason ? { reason: details.reason } : {}),
    },
    `Session send rejected: ${message}`,
  );
  return new SessionSendRuntimeError(message, details);
}

function pageBySessionCursor<T extends { sessionId?: string }>(
  items: T[],
  cursor: string | undefined,
  limit: number | undefined,
): { items: T[]; hasMore: boolean; nextCursor?: string } {
  const start =
    cursor === undefined
      ? 0
      : Math.max(0, items.findIndex((item) => item.sessionId === cursor) + 1);
  return pageItems(items.slice(start), limit, (item) => item.sessionId);
}

function pageItems<T>(
  items: T[],
  limit: number | undefined,
  cursorFor: (item: T) => string | undefined,
): { items: T[]; hasMore: boolean; nextCursor?: string } {
  if (limit === undefined || limit <= 0) return { items, hasMore: false };
  const page = items.slice(0, limit);
  const hasMore = items.length > limit;
  const lastItem = page.at(-1);
  const nextCursor = hasMore && lastItem ? cursorFor(lastItem) : undefined;
  return {
    items: page,
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
  };
}
