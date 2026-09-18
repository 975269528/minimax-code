import type { SessionRepository } from '../../sessions/repo/contract.js';
import type { DisplayMessageRecord, MessageRepository } from '../repo/contract.js';
import type {
  SessionSourceProjectionRepository,
  SessionSourceRecord,
  SessionSourceTurnRecord,
} from '../repo/source-query-contract.js';
import type { MessageDisplayReadiness } from '../repo/readiness.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface SessionSourceHistoryPage {
  readonly sourcedTurnCount: number;
  readonly sourceCount: number;
  readonly recentSources: readonly SessionSourceRecord[];
  readonly turns: readonly Omit<SessionSourceTurnRecord, 'cursorRowId'>[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

export interface SessionSourceToolDetail {
  readonly messageId: string;
  readonly toolCall: Readonly<Record<string, unknown>>;
}

export class SessionSourceQueryService {
  constructor(
    private readonly options: {
      readonly enabled?: boolean;
      readonly sources: SessionSourceProjectionRepository;
      readonly messages: Pick<MessageRepository, 'get'>;
      readonly sessions: Pick<SessionRepository, 'get'>;
      readonly readiness?: MessageDisplayReadiness;
    },
  ) {}

  async list(input: {
    readonly sessionId: string;
    readonly limit?: number;
    readonly before?: string;
  }): Promise<SessionSourceHistoryPage> {
    if (this.options.enabled === false) {
      return { sourcedTurnCount: 0, sourceCount: 0, recentSources: [], turns: [], hasMore: false };
    }
    await this.assertReadable(input.sessionId);
    const limit = normalizeLimit(input.limit);
    const beforeRowId = input.before ? decodeCursor(input.sessionId, input.before) : undefined;
    const page = await this.options.sources.list({
      sessionId: input.sessionId,
      limit,
      ...(beforeRowId !== undefined ? { beforeRowId } : {}),
    });
    const last = page.turns.at(-1);
    return {
      sourcedTurnCount: page.sourcedTurnCount,
      sourceCount: page.sourceCount,
      recentSources: page.recentSources,
      turns: page.turns.map(({ cursorRowId: _, ...turn }) => turn),
      hasMore: page.hasMore,
      ...(page.hasMore && last
        ? { nextCursor: encodeCursor(input.sessionId, last.cursorRowId) }
        : {}),
    };
  }

  async getToolDetail(
    sessionId: string,
    messageId: string,
    toolCallId: string,
  ): Promise<SessionSourceToolDetail | undefined> {
    if (this.options.enabled === false) return undefined;
    await this.assertReadable(sessionId);
    if (!(await this.options.sources.hasOccurrence(sessionId, messageId, toolCallId))) {
      return undefined;
    }
    const message = await this.options.messages.get(sessionId, messageId);
    const toolCall = message ? findToolCall(message, toolCallId) : undefined;
    return toolCall ? { messageId, toolCall } : undefined;
  }

  private async assertReadable(sessionId: string): Promise<void> {
    await this.options.readiness?.ensureDisplayReady(sessionId);
    if (!(await this.options.sessions.get(sessionId))) {
      throw new SessionSourceQueryServiceError('session-not-found', sessionId);
    }
  }
}

export class SessionSourceQueryServiceError extends Error {
  constructor(
    readonly reason: 'session-not-found' | 'invalid-pagination',
    readonly sessionId: string,
  ) {
    super(
      reason === 'session-not-found'
        ? `Session not found: ${sessionId}`
        : `Invalid Session source history cursor: ${sessionId}`,
    );
    this.name = 'SessionSourceQueryServiceError';
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

function encodeCursor(sessionId: string, beforeRowId: number): string {
  return Buffer.from(JSON.stringify({ v: 1, sessionId, beforeRowId })).toString('base64url');
}

function decodeCursor(sessionId: string, cursor: string): number {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!isRecord(value)) throw new Error('invalid source cursor');
    if (value.v !== 1 || value.sessionId !== sessionId) throw new Error('invalid source cursor');
    if (!Number.isSafeInteger(value.beforeRowId) || Number(value.beforeRowId) <= 0) {
      throw new Error('invalid source cursor');
    }
    return Number(value.beforeRowId);
  } catch {
    throw new SessionSourceQueryServiceError('invalid-pagination', sessionId);
  }
}

function findToolCall(
  message: DisplayMessageRecord,
  toolCallId: string,
): Readonly<Record<string, unknown>> | undefined {
  let direct: unknown[] = [];
  if (Array.isArray(message.tool_calls)) direct = message.tool_calls;
  else if (Array.isArray(message.toolCalls)) direct = message.toolCalls;
  const parts = Array.isArray(message.parts)
    ? message.parts.flatMap((part) => {
        if (!isRecord(part) || part.type !== 'tool_call') return [];
        return [part.tool_call ?? part.toolCall].filter(isRecord);
      })
    : [];
  return [...direct, ...parts].find((value) => {
    if (!isRecord(value)) return false;
    return readString(value.id ?? value.tool_call_id ?? value.toolCallId) === toolCallId;
  }) as Readonly<Record<string, unknown>> | undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
