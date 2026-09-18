import { setTimeout as delay } from 'node:timers/promises';

import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';

import type { LocalSessionRecord } from '../sessions/controller.js';
import {
  LocalSessionLedgerCommitUncertainError,
  type LocalSessionLedgerStore,
} from '../sessions/ledger/index.js';
import type { LocalSessionSnapshotStore } from '../sessions/snapshot/index.js';
import type { LiveSessionWriter } from '../sessions/writer/index.js';
import type { LocalRuntimeMessageStore, LocalTokenUsageStore } from '../persistence/ports.js';
import type { LegacyOpencodeMigrator } from '../legacy-opencode/legacy-opencode-migrator.js';
import { recordLocalTokenUsageFromPiMessages } from '../usage/api.js';
import { logger } from '../common/logger.js';
import { isTerminalAssistantPiError } from './terminal-assistant-error.js';

const MAX_CANONICAL_WRITE_ATTEMPTS = 3;
const CANONICAL_RETRY_DELAYS_MS = [25, 50] as const;
export const LOCAL_PI_HISTORY_PERSISTENCE_FAILED = 'LOCAL_PI_HISTORY_PERSISTENCE_FAILED';

export class LocalPiHistoryPersistenceError extends Error {
  override readonly cause: unknown;

  constructor(operation: 'append' | 'replace' | 'seed', cause: unknown) {
    super(`${LOCAL_PI_HISTORY_PERSISTENCE_FAILED}: ${operation}`);
    this.name = 'LocalPiHistoryPersistenceError';
    this.cause = cause;
  }
}

/**
 * Dependencies the Pi-history store needs from its host. Kept as a plain object
 * so `LocalRuntimeApiHost` can construct the store from its own fields without a
 * circular import back to the host class.
 */
export interface LocalPiHistoryStoreDeps {
  readonly ledgerStore: LocalSessionLedgerStore | undefined;
  readonly snapshotStore: LocalSessionSnapshotStore | undefined;
  readonly messageStore: LocalRuntimeMessageStore | undefined;
  readonly sessionWriter: LiveSessionWriter;
  readonly tokenUsageStore: LocalTokenUsageStore;
  readonly legacyMigrator: LegacyOpencodeMigrator | undefined;
  readonly nowMs: () => number;
  /** In-memory fallback history map, owned by the host (shared by reference). */
  readonly piHistory: Map<string, PiAgentMessage[]>;
}

/**
 * Pi-agent conversation history persistence, extracted from
 * `LocalRuntimeApiHost` to keep that file under the 2000-line source budget.
 * Pure behavioural move — the host retains thin public delegators with the same
 * signatures, so callers are unaffected.
 */
export class LocalPiHistoryStore {
  constructor(private readonly deps: LocalPiHistoryStoreDeps) {}

  async getPiHistory(sessionId: string): Promise<PiAgentMessage[]> {
    await this.ensureLegacyMessagesMigrated(sessionId);
    const { ledgerStore, snapshotStore, messageStore, piHistory } = this.deps;
    if (ledgerStore && snapshotStore) {
      const resume = await snapshotStore.readResumeProjection(sessionId, ledgerStore);
      if (resume.piHistoryFacts || resume.projection.piHistory.length > 0) {
        return resume.projection.piHistory;
      }
      const projectedHistory = messageStore
        ? await messageStore.getPiHistory(sessionId)
        : undefined;
      if (projectedHistory && projectedHistory.length > 0) return projectedHistory;
      if (resume.source !== 'empty' || resume.projection.watermark)
        return resume.projection.piHistory;
    }
    return messageStore
      ? messageStore.getPiHistory(sessionId)
      : [...(piHistory.get(sessionId) ?? [])];
  }

  async ensureLegacyMessagesMigrated(sessionId: string): Promise<void> {
    await this.deps.legacyMigrator?.ensureMessagesMigrated(sessionId);
  }

  async appendPiHistory(
    sessionId: string,
    messages: PiAgentMessage[],
    usage?: {
      session: LocalSessionRecord;
      turnId: string;
      model?: string | null;
    },
  ): Promise<void> {
    const persistedMessages = messages.filter((message) => !isTerminalAssistantPiError(message));
    if (persistedMessages.length === 0) return;
    await this.ensurePiHistoryLedgerSeeded(sessionId);
    await this.persistCanonical(sessionId, 'append', () =>
      this.deps.sessionWriter.appendPiHistory(sessionId, persistedMessages, async () => {
        const history = this.deps.piHistory.get(sessionId) ?? [];
        history.push(...persistedMessages);
        this.deps.piHistory.set(sessionId, history);
      }),
    );
    if (usage) {
      try {
        await recordLocalTokenUsageFromPiMessages({
          usageStore: this.deps.tokenUsageStore,
          session: usage.session,
          turnId: usage.turnId,
          model: usage.model,
          nowMs: this.deps.nowMs,
          messages: persistedMessages,
        });
      } catch (error) {
        logger.warn(
          {
            session_id: sessionId,
            turn_id: usage.turnId,
            error_type: error instanceof Error ? error.name : typeof error,
          },
          '[local-pi-history] token usage projection failed after canonical history commit',
        );
      }
    }
  }

  async replacePiHistory(sessionId: string, messages: PiAgentMessage[]): Promise<void> {
    await this.ensurePiHistoryLedgerSeeded(sessionId);
    await this.persistCanonical(sessionId, 'replace', () =>
      this.deps.sessionWriter.rewindPiHistory(sessionId, messages, async () => {
        this.deps.piHistory.set(sessionId, [...messages]);
      }),
    );
  }

  async ensurePiHistoryLedgerSeeded(sessionId: string): Promise<void> {
    const { ledgerStore, snapshotStore, messageStore, sessionWriter } = this.deps;
    if (!ledgerStore || !snapshotStore || !messageStore) return;
    await this.persistCanonical(sessionId, 'seed', async () => {
      const resume = await snapshotStore.readResumeProjection(sessionId, ledgerStore);
      if (resume.piHistoryFacts) return;
      const projectedHistory = await messageStore.getPiHistory(sessionId);
      if (projectedHistory.length === 0) return;
      await sessionWriter.importPiHistory(sessionId, projectedHistory);
    });
  }

  private async persistCanonical(
    sessionId: string,
    operation: 'append' | 'replace' | 'seed',
    write: () => Promise<void>,
    attempt = 1,
  ): Promise<void> {
    try {
      await write();
    } catch (error) {
      const retry =
        Boolean(this.deps.ledgerStore) &&
        !(error instanceof LocalSessionLedgerCommitUncertainError) &&
        attempt < MAX_CANONICAL_WRITE_ATTEMPTS;
      const fields = {
        session_id: sessionId,
        operation,
        attempt,
        max_attempts: this.deps.ledgerStore ? MAX_CANONICAL_WRITE_ATTEMPTS : 1,
        error_type: error instanceof Error ? error.name : typeof error,
      };
      if (!retry) {
        logger.error(fields, '[local-pi-history] canonical history persistence failed');
        throw new LocalPiHistoryPersistenceError(operation, error);
      }
      logger.warn(fields, '[local-pi-history] retrying canonical history persistence');
      await delay(CANONICAL_RETRY_DELAYS_MS[attempt - 1] ?? 0);
      await this.persistCanonical(sessionId, operation, write, attempt + 1);
    }
  }
}
