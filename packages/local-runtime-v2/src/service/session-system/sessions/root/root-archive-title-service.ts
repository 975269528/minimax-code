import type { PromptSnapshotSource } from '@mavis/agent-runtime';

import { readPromptWithBuiltinFallback } from '../../../agent/index.js';
import type { SessionRecord, SessionRepository } from '../repo/contract.js';
import {
  archiveTitleSystemPrompt,
  archivedRootPrefix,
  ARCHIVE_TITLE_MAX_TOKENS,
  ARCHIVE_TITLE_PER_MESSAGE_CHAR_CAP,
  ARCHIVE_TITLE_RECENT_MESSAGE_LIMIT,
  ARCHIVE_TITLE_TIMEOUT_MS,
  ARCHIVE_TITLE_SYSTEM_PROMPT_EN_KEY,
  ARCHIVE_TITLE_SYSTEM_PROMPT_ZH_KEY,
  buildArchiveTitlePrompts,
  isArchiveTitleFallback,
} from './archived-root-title.js';
import {
  RootArchiveTitleModelError,
  type RootArchiveTitleModel,
} from './root-archive-title-model.js';

export interface ArchiveTitleMessage {
  readonly role: string;
  readonly content: unknown;
}

export interface ArchiveTitleMessageReader {
  listRecent(
    sessionId: string,
    options: { readonly limit: number },
  ): Promise<readonly ArchiveTitleMessage[]>;
}

export interface RootArchiveTitleCommittedFact {
  readonly sessionId: string;
  readonly agentName: string;
  readonly title: string;
}

export interface RootArchiveTitleFactObserver {
  observe(fact: RootArchiveTitleCommittedFact): void | Promise<void>;
}

export interface RootArchiveTitleServiceOptions {
  readonly sessions: Pick<SessionRepository, 'get' | 'update'>;
  readonly messages: ArchiveTitleMessageReader;
  readonly model: RootArchiveTitleModel;
  readonly promptSnapshots?: PromptSnapshotSource;
  readonly facts?: RootArchiveTitleFactObserver;
  readonly locale?: () => string;
  readonly onFailure?: (input: {
    readonly stage: 'read' | 'model' | 'review' | 'write' | 'fact-observer';
    readonly sessionId: string;
    readonly error: unknown;
  }) => void;
}

export class RootArchiveTitleService {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly options: RootArchiveTitleServiceOptions) {}

  generate(
    sessionId: string,
    input: { readonly agentName: string; readonly fallbackName: string },
  ): void {
    if (this.pending.has(sessionId)) return;
    this.pending.set(sessionId, this.runGeneration(sessionId, input));
  }

  private async runGeneration(
    sessionId: string,
    input: { readonly agentName: string; readonly fallbackName: string },
  ): Promise<void> {
    try {
      await this.generateArchiveTitle(sessionId, input);
    } catch (error) {
      this.report('model', sessionId, error);
    } finally {
      this.pending.delete(sessionId);
    }
  }

  async generateArchiveTitle(
    sessionId: string,
    input: { readonly agentName: string; readonly fallbackName: string },
  ): Promise<void> {
    const locale = this.options.locale?.() ?? 'en';
    const session = await this.readEligibleSession(sessionId, input.fallbackName, locale);
    if (!session) return;
    const transcript = await this.readTranscript(sessionId);
    if (!transcript) return;
    const summary = await this.summarize(sessionId, session, locale, transcript);
    if (!summary) return;
    const finalTitle = `${archivedRootPrefix(locale)}${summary}`;
    if (!(await this.commitTitle(sessionId, input.fallbackName, locale, finalTitle))) return;
    await this.observeFact(sessionId, input.agentName, finalTitle);
  }

  private async readEligibleSession(
    sessionId: string,
    fallbackName: string,
    locale: string,
  ): Promise<SessionRecord | undefined> {
    try {
      const session = await this.options.sessions.get(sessionId);
      return isEligibleArchiveSession(session, fallbackName, locale) ? session : undefined;
    } catch (error) {
      this.report('read', sessionId, error);
      return undefined;
    }
  }

  private async readTranscript(sessionId: string): Promise<string | undefined> {
    try {
      const recent = await this.options.messages.listRecent(sessionId, {
        limit: ARCHIVE_TITLE_RECENT_MESSAGE_LIMIT,
      });
      const transcript = buildTranscript(recent);
      return transcript && recent.some(({ role }) => role === 'user') ? transcript : undefined;
    } catch (error) {
      this.report('read', sessionId, error);
      return undefined;
    }
  }

  private async summarize(
    sessionId: string,
    session: SessionRecord,
    locale: string,
    transcript: string,
  ): Promise<string | null> {
    try {
      const systemPrompt = await readPromptWithBuiltinFallback({
        source: this.options.promptSnapshots,
        key:
          locale.split('-')[0]?.toLowerCase() === 'zh'
            ? ARCHIVE_TITLE_SYSTEM_PROMPT_ZH_KEY
            : ARCHIVE_TITLE_SYSTEM_PROMPT_EN_KEY,
        builtin: archiveTitleSystemPrompt(locale),
      });
      return await this.options.model.summarize({
        session,
        ...buildArchiveTitlePrompts(locale, transcript, systemPrompt),
        maxTokens: ARCHIVE_TITLE_MAX_TOKENS,
        timeoutMs: ARCHIVE_TITLE_TIMEOUT_MS,
      });
    } catch (error) {
      this.report(
        error instanceof RootArchiveTitleModelError ? error.stage : 'model',
        sessionId,
        error,
      );
      return null;
    }
  }

  private async commitTitle(
    sessionId: string,
    fallbackName: string,
    locale: string,
    title: string,
  ): Promise<boolean> {
    try {
      const fresh = await this.options.sessions.get(sessionId);
      if (!isEligibleArchiveSession(fresh, fallbackName, locale)) return false;
      await this.options.sessions.update(sessionId, { title });
      return true;
    } catch (error) {
      this.report('write', sessionId, error);
      return false;
    }
  }

  private async observeFact(sessionId: string, agentName: string, title: string): Promise<void> {
    try {
      await this.options.facts?.observe({ sessionId, agentName, title });
    } catch (error) {
      this.report('fact-observer', sessionId, error);
    }
  }

  private report(
    stage: Parameters<NonNullable<RootArchiveTitleServiceOptions['onFailure']>>[0]['stage'],
    sessionId: string,
    error: unknown,
  ): void {
    try {
      this.options.onFailure?.({ stage, sessionId, error });
    } catch {
      // Observability remains best effort.
    }
  }
}

function isEligibleArchiveSession(
  session: SessionRecord | undefined,
  fallbackName: string,
  locale: string,
): session is SessionRecord {
  return Boolean(
    session &&
    session.sessionType === 'branch' &&
    session.archived &&
    isArchiveTitleFallback({ title: session.title, fallbackName, locale }),
  );
}

function buildTranscript(messages: readonly ArchiveTitleMessage[]): string {
  return messages
    .filter(({ role }) => role === 'user' || role === 'assistant')
    .map(({ role, content }) => {
      const body =
        typeof content === 'string'
          ? content.trim().slice(0, ARCHIVE_TITLE_PER_MESSAGE_CHAR_CAP)
          : '';
      return body ? `${role === 'user' ? 'User' : 'Assistant'}: ${body}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}
