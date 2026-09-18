import type { SessionRepository } from '../../sessions/repo/contract.js';
import { MessageDataCorruptionError } from '../repo/contract.js';
import type { DisplayMessageRecord, MessageRepository } from '../repo/contract.js';
import type { MessageDisplayReadiness } from '../repo/readiness.js';

const DEFAULT_MESSAGE_PAGE_SIZE = 80;

export interface MessageQueryInput {
  readonly sessionId: string;
  readonly limit?: number;
  readonly before?: string;
}

export interface MessageQueryPage {
  readonly messages: readonly DisplayMessageRecord[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

export type MessageQueryFailureReason = 'session-not-found' | 'data-corrupt';

export class MessageQueryServiceError extends Error {
  constructor(
    readonly reason: MessageQueryFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'MessageQueryServiceError';
  }
}

export interface MessageQueryServiceOptions {
  readonly messages: Pick<MessageRepository, 'list'>;
  readonly sessions: Pick<SessionRepository, 'get'>;
  readonly readiness?: MessageDisplayReadiness;
  readonly defaultPageSize?: number;
}

export class MessageQueryService {
  private readonly defaultPageSize: number;

  constructor(private readonly options: MessageQueryServiceOptions) {
    this.defaultPageSize = normalizeDefaultPageSize(options.defaultPageSize);
  }

  async list(input: MessageQueryInput): Promise<MessageQueryPage> {
    return this.read(input, normalizeRequestedLimit(input.limit, this.defaultPageSize));
  }

  async listExact(input: MessageQueryInput): Promise<MessageQueryPage> {
    return this.read(input, input.limit);
  }

  private async read(
    input: MessageQueryInput,
    limit: number | undefined,
  ): Promise<MessageQueryPage> {
    await this.options.readiness?.ensureDisplayReady(input.sessionId);
    if (!(await this.options.sessions.get(input.sessionId))) {
      throw new MessageQueryServiceError(
        'session-not-found',
        `Session not found: ${input.sessionId}`,
      );
    }
    try {
      const page = await this.options.messages.list(input.sessionId, {
        ...(limit !== undefined ? { limit } : {}),
        ...(input.before ? { before: input.before } : {}),
      });
      return {
        messages: page.messages,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        hasMore: page.hasMore,
      };
    } catch (error) {
      if (error instanceof MessageDataCorruptionError) {
        throw new MessageQueryServiceError('data-corrupt', error.message);
      }
      throw error;
    }
  }
}

function normalizeDefaultPageSize(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MESSAGE_PAGE_SIZE;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeRequestedLimit(value: number | undefined, defaultPageSize: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : defaultPageSize;
}
