import type { SessionRecord, SessionRepository } from '../../sessions/repo/contract.js';
import type { DisplayMessageRecord, MessageRepository } from '../repo/contract.js';
import type { MessageDisplayReadiness } from '../repo/readiness.js';

export interface PeekContextSessionReader {
  get(sessionId: string): Promise<SessionRecord | undefined>;
  listChildren(parentSessionId: string): Promise<SessionRecord[]>;
}

export interface PeekContextServiceOptions {
  readonly sessions: Pick<SessionRepository, 'get' | 'listChildren'>;
  readonly messages: Pick<MessageRepository, 'listRecent'>;
  readonly readiness?: MessageDisplayReadiness;
}

export class PeekContextServiceError extends Error {
  constructor(
    readonly reason: 'session-not-found',
    message: string,
  ) {
    super(message);
    this.name = 'PeekContextServiceError';
  }
}

export class PeekContextService {
  constructor(private readonly options: PeekContextServiceOptions) {}

  async getContext(sessionId: string): Promise<string> {
    await this.options.readiness?.ensureDisplayReady(sessionId);
    const session = await this.options.sessions.get(sessionId);
    if (!session) {
      throw new PeekContextServiceError('session-not-found', `Session not found: ${sessionId}`);
    }
    const related = await this.collectRelatedSessions(session);
    const sections = await Promise.all(
      related.map((item) => this.formatSession(item, item.sessionId === session.sessionId)),
    );
    return sections.join('\n\n');
  }

  private async collectRelatedSessions(session: SessionRecord): Promise<SessionRecord[]> {
    const byId = new Map<string, SessionRecord>();
    let current: SessionRecord | undefined = session;
    while (current && !byId.has(current.sessionId)) {
      byId.set(current.sessionId, current);
      current = current.parentSessionId
        ? await this.options.sessions.get(current.parentSessionId)
        : undefined;
    }
    const children = await this.options.sessions.listChildren(session.sessionId);
    children
      .filter((child) => !child.archived && child.visibility !== 'hidden')
      .forEach((child) => byId.set(child.sessionId, child));
    return [...byId.values()];
  }

  private async formatSession(session: SessionRecord, alreadyReady = false): Promise<string> {
    if (!alreadyReady) await this.options.readiness?.ensureDisplayReady(session.sessionId);
    const messages = await this.options.messages.listRecent(session.sessionId, { limit: 6 });
    const lines = messages
      .map(formatPeekMessage)
      .filter((line): line is string => line !== undefined);
    return [
      `## ${session.title || session.sessionId}`,
      `sessionId: ${session.sessionId}`,
      `role: ${session.parentSessionId ? 'child' : 'root'}`,
      ...(lines.length > 0 ? lines : ['(no recent messages)']),
    ].join('\n');
  }
}

function formatPeekMessage(message: DisplayMessageRecord): string | undefined {
  const content =
    typeof message.msg_content === 'string'
      ? message.msg_content
      : safeJsonStringify(message.msg_content);
  if (!content) return undefined;
  const role = peekMessageRole(message.role);
  return `${role}: ${content.slice(0, 2_000)}`;
}

function peekMessageRole(role: unknown): 'user' | 'assistant' | 'system' {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  return 'system';
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
