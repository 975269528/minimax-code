import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentMessage } from '@mavis/agent-core/protocol/agent-message';

import type { LocalRuntimeMessageStore } from '../../persistence/ports.js';
import type { LocalSessionRecord } from '../controller.js';
import type { LocalSessionLedgerStore, LocalSessionLedgerWatermark } from '../ledger/index.js';
import type { LocalSessionProjectionStore } from '../projection/index.js';
import type { LocalSessionSnapshotStore } from '../snapshot/index.js';
import { logger } from '../../common/logger.js';

export interface LiveSessionWriterOptions {
  ledgerStore?: LocalSessionLedgerStore;
  messageStore?: LocalRuntimeMessageStore;
  projectionStore?: LocalSessionProjectionStore;
  snapshotStore?: LocalSessionSnapshotStore;
}

export class LiveSessionWriter {
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(private readonly options: LiveSessionWriterOptions = {}) {}

  async withSessionWriteLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.writeChains.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(
      () => current,
      () => current,
    );
    this.writeChains.set(sessionId, chain);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.writeChains.get(sessionId) === chain) this.writeChains.delete(sessionId);
    }
  }

  async recordSessionCreated(
    record: LocalSessionRecord,
  ): Promise<LocalSessionLedgerWatermark | undefined> {
    const result = await this.options.ledgerStore?.append(record.sessionId, [
      {
        kind: 'session.created',
        sessionId: record.sessionId,
        record,
      },
    ]);
    return result?.watermark;
  }

  async recordSessionMetadataUpdated(
    record: LocalSessionRecord,
  ): Promise<LocalSessionLedgerWatermark | undefined> {
    const result = await this.options.ledgerStore?.append(record.sessionId, [
      {
        kind: 'session.metadata_updated',
        sessionId: record.sessionId,
        record,
      },
    ]);
    return result?.watermark;
  }

  async recordSessionDeleted(sessionId: string): Promise<LocalSessionLedgerWatermark | undefined> {
    const result = await this.options.ledgerStore?.append(sessionId, [
      {
        kind: 'session.deleted',
        sessionId,
      },
    ]);
    return result?.watermark;
  }

  async recordFileApiUploaded(
    sessionId: string,
    upload: {
      contentHash: string;
      endpointHash: string;
      callerIdentityHash: string;
      ttlSec: number;
      fileId: string;
      expiresAtMs: number;
      turnId?: string;
    },
  ): Promise<LocalSessionLedgerWatermark | undefined> {
    return this.withSessionWriteLock(sessionId, async () => {
      const result = await this.options.ledgerStore?.append(sessionId, [
        {
          kind: 'media.file_api_uploaded',
          sessionId,
          ...(upload.turnId ? { turnId: upload.turnId } : {}),
          contentHash: upload.contentHash,
          endpointHash: upload.endpointHash,
          callerIdentityHash: upload.callerIdentityHash,
          ttlSec: upload.ttlSec,
          fileId: upload.fileId,
          expiresAtMs: upload.expiresAtMs,
        },
      ]);
      await this.markProjectionWatermark(result?.watermark);
      return result?.watermark;
    });
  }

  async markProjectionWatermark(
    watermark: LocalSessionLedgerWatermark | undefined,
    options: { updateSnapshot?: boolean } = {},
  ): Promise<void> {
    if (!watermark) return;
    await this.options.projectionStore?.markWatermark(watermark);
    if (options.updateSnapshot === false) return;
    await this.refreshSnapshot(watermark);
  }

  async upsertDisplayMessage(
    sessionId: string,
    message: AgentMessage,
    fallbackProjectionWrite?: () => Promise<void>,
  ): Promise<void> {
    return this.withSessionWriteLock(sessionId, () =>
      this.upsertDisplayMessageUnlocked(sessionId, message, fallbackProjectionWrite),
    );
  }

  private async upsertDisplayMessageUnlocked(
    sessionId: string,
    message: AgentMessage,
    fallbackProjectionWrite?: () => Promise<void>,
  ): Promise<void> {
    const result = await this.options.ledgerStore?.append(sessionId, [
      {
        kind: 'message.display_upserted',
        sessionId,
        turnId: readTurnId(message),
        message,
      },
    ]);
    if (this.options.messageStore) {
      await this.options.messageStore.upsertDisplayMessage(sessionId, message);
    } else {
      await fallbackProjectionWrite?.();
    }
    await this.markProjectionWatermark(result?.watermark);
  }

  async importDisplayMessages(
    sessionId: string,
    messages: AgentMessage[],
    fallbackProjectionWrite?: () => Promise<void>,
  ): Promise<void> {
    return this.withSessionWriteLock(sessionId, () =>
      this.importDisplayMessagesUnlocked(sessionId, messages, fallbackProjectionWrite),
    );
  }

  /**
   * Streaming variant of {@link importDisplayMessages} for large legacy
   * migrations. Instead of receiving the whole display array at once, it pulls
   * batches from `batches` and writes each batch (ledger append + message-store
   * upsert) before requesting the next, so peak memory scales with the batch
   * size rather than the full session history. The FIRST non-empty batch (or an
   * empty stream) clears the session's existing rows via `replaceExisting`, so
   * the end state is identical to a single `importDisplayMessages` call.
   *
   * Callers that also need to import pi-history must keep using
   * {@link importDisplayMessages}, because pi-history conversion needs the full
   * display array in memory anyway (streaming would not lower the peak).
   */
  async importDisplayMessagesStreamed(
    sessionId: string,
    batches: AsyncIterable<AgentMessage[]>,
    fallbackProjectionWrite?: () => Promise<void>,
  ): Promise<void> {
    return this.withSessionWriteLock(sessionId, async () => {
      const messageStore = this.options.messageStore;
      // Without a batched message-store sink there is no memory win to be had
      // (the fallback projection write needs the full array); refuse rather
      // than silently buffer everything, so callers pick the array path.
      if (!messageStore?.appendDisplayMessages) {
        throw new Error(
          'importDisplayMessagesStreamed requires a message store with appendDisplayMessages',
        );
      }
      let firstBatch = true;
      let sawAny = false;
      let lastWatermark: LocalSessionLedgerWatermark | undefined;
      for await (const batch of batches) {
        if (batch.length === 0) continue;
        sawAny = true;
        const result = await this.options.ledgerStore?.append(
          sessionId,
          batch.map((message) => ({
            kind: 'message.display_upserted' as const,
            sessionId,
            turnId: readTurnId(message),
            message,
          })),
        );
        if (result?.watermark) lastWatermark = result.watermark;
        await messageStore.appendDisplayMessages(sessionId, batch, {
          replaceExisting: firstBatch,
        });
        firstBatch = false;
      }
      // Empty stream mirrors the array path's `messages.length === 0`
      // early-return: it is a no-op (no clear, no watermark advance). The
      // migrator only streams when there is legacy display content to import,
      // so this branch is a defensive parity guard rather than a live path.
      if (!sawAny) return;
      await this.markProjectionWatermark(lastWatermark);
    });
  }

  private async importDisplayMessagesUnlocked(
    sessionId: string,
    messages: AgentMessage[],
    fallbackProjectionWrite?: () => Promise<void>,
  ): Promise<void> {
    if (messages.length === 0) return;
    const result = await this.options.ledgerStore?.append(
      sessionId,
      messages.map((message) => ({
        kind: 'message.display_upserted',
        sessionId,
        turnId: readTurnId(message),
        message,
      })),
    );
    if (this.options.messageStore) {
      await this.options.messageStore.setDisplayMessages(sessionId, messages);
    } else {
      await fallbackProjectionWrite?.();
    }
    await this.markProjectionWatermark(result?.watermark);
  }

  async appendPiHistory(
    sessionId: string,
    messages: PiAgentMessage[],
    fallbackProjectionWrite?: () => Promise<void>,
  ): Promise<void> {
    return this.withSessionWriteLock(sessionId, () =>
      this.appendPiHistoryUnlocked(sessionId, messages, fallbackProjectionWrite),
    );
  }

  private async appendPiHistoryUnlocked(
    sessionId: string,
    messages: PiAgentMessage[],
    fallbackProjectionWrite?: () => Promise<void>,
  ): Promise<void> {
    if (messages.length === 0) return;
    const messageStore = this.options.messageStore;
    const result = await this.options.ledgerStore?.append(sessionId, [
      {
        kind: 'message.pi_history_appended',
        sessionId,
        messages,
      },
    ]);
    await this.projectPiHistoryAfterCommit(
      sessionId,
      'append',
      result?.watermark,
      messageStore
        ? () => messageStore.appendPiHistory(sessionId, messages)
        : fallbackProjectionWrite,
    );
  }

  async importPiHistory(
    sessionId: string,
    messages: PiAgentMessage[],
    fallbackProjectionWrite?: () => Promise<void>,
  ): Promise<void> {
    return this.withSessionWriteLock(sessionId, () =>
      this.importPiHistoryUnlocked(sessionId, messages, fallbackProjectionWrite),
    );
  }

  private async importPiHistoryUnlocked(
    sessionId: string,
    messages: PiAgentMessage[],
    fallbackProjectionWrite?: () => Promise<void>,
  ): Promise<void> {
    if (messages.length === 0) return;
    await this.replacePiHistoryRows(sessionId, messages, fallbackProjectionWrite);
  }

  /**
   * Replace pi history with a snapshot, allowing an empty snapshot (full clear).
   * Used by output-review rewind to drop a leaked failed draft before retrying;
   * unlike {@link importPiHistory}, it must still write the replace event when
   * the pre-turn snapshot is empty (first turn), otherwise the leaked draft
   * would survive in the ledger.
   */
  async rewindPiHistory(
    sessionId: string,
    messages: PiAgentMessage[],
    fallbackProjectionWrite?: () => Promise<void>,
  ): Promise<void> {
    return this.withSessionWriteLock(sessionId, () =>
      this.replacePiHistoryRows(sessionId, messages, fallbackProjectionWrite),
    );
  }

  private async replacePiHistoryRows(
    sessionId: string,
    messages: PiAgentMessage[],
    fallbackProjectionWrite?: () => Promise<void>,
  ): Promise<void> {
    const messageStore = this.options.messageStore;
    const result = await this.options.ledgerStore?.append(sessionId, [
      {
        kind: 'message.pi_history_replaced',
        sessionId,
        messages,
      },
    ]);
    await this.projectPiHistoryAfterCommit(
      sessionId,
      'replace',
      result?.watermark,
      messageStore ? () => messageStore.setPiHistory(sessionId, messages) : fallbackProjectionWrite,
    );
  }

  async initMessageState(
    sessionId: string,
    fallbackProjectionWrite?: () => Promise<void>,
  ): Promise<void> {
    if (this.options.messageStore) {
      await this.options.messageStore.initSession(sessionId);
      return;
    }
    await fallbackProjectionWrite?.();
  }

  async deleteMessageState(
    sessionId: string,
    fallbackProjectionWrite?: () => Promise<void>,
  ): Promise<void> {
    return this.withSessionWriteLock(sessionId, () =>
      this.deleteMessageStateUnlocked(sessionId, fallbackProjectionWrite),
    );
  }

  private async deleteMessageStateUnlocked(
    sessionId: string,
    fallbackProjectionWrite?: () => Promise<void>,
  ): Promise<void> {
    const result = await this.options.ledgerStore?.append(sessionId, [
      {
        kind: 'message.state_deleted',
        sessionId,
      },
    ]);
    if (this.options.messageStore) {
      await this.options.messageStore.deleteSession(sessionId);
    } else {
      await fallbackProjectionWrite?.();
    }
    await this.markProjectionWatermark(result?.watermark);
    await this.options.ledgerStore?.deleteSession(sessionId);
    await this.options.projectionStore?.deleteSession(sessionId);
    await this.options.snapshotStore?.deleteSession(sessionId);
  }

  /**
   * Retract a whole turn after output review exhausted its regenerations:
   * append a `message.turn_retracted` ledger event, drop the listed display
   * rows (the user-query bubble), and restore pi history to its pre-turn
   * snapshot. The leaked failed drafts are discarded.
   */
  async retractTurn(
    sessionId: string,
    turnId: string,
    removedDisplayMsgIds: string[],
    preTurnPiHistory: PiAgentMessage[],
    fallbackProjectionWrite?: () => Promise<void>,
  ): Promise<void> {
    return this.withSessionWriteLock(sessionId, () =>
      this.retractTurnUnlocked(
        sessionId,
        turnId,
        removedDisplayMsgIds,
        preTurnPiHistory,
        fallbackProjectionWrite,
      ),
    );
  }

  private async retractTurnUnlocked(
    sessionId: string,
    turnId: string,
    removedDisplayMsgIds: string[],
    preTurnPiHistory: PiAgentMessage[],
    fallbackProjectionWrite?: () => Promise<void>,
  ): Promise<void> {
    const result = await this.options.ledgerStore?.append(sessionId, [
      {
        kind: 'message.turn_retracted',
        sessionId,
        ...(turnId ? { turnId } : {}),
        removedDisplayMsgIds,
        messages: preTurnPiHistory,
      },
    ]);
    if (this.options.messageStore) {
      if (removedDisplayMsgIds.length > 0) {
        await this.options.messageStore.deleteDisplayMessagesByIds?.(
          sessionId,
          removedDisplayMsgIds,
        );
      }
      await this.options.messageStore.setPiHistory(sessionId, preTurnPiHistory);
    } else {
      await fallbackProjectionWrite?.();
    }
    await this.markProjectionWatermark(result?.watermark);
  }

  private async refreshSnapshot(watermark: LocalSessionLedgerWatermark): Promise<void> {
    if (!this.options.ledgerStore || !this.options.snapshotStore) return;
    const snapshot = await this.options.snapshotStore.writeSnapshotFromLedger(
      watermark.sessionId,
      this.options.ledgerStore,
      watermark,
    );
    if (!snapshot) return;
    const result = await this.options.ledgerStore.append(watermark.sessionId, [
      {
        kind: 'session.snapshot_created',
        sessionId: watermark.sessionId,
        snapshotId: snapshot.snapshotId,
        snapshotWatermark: snapshot.watermark,
      },
    ]);
    if (result.watermark.lastSeq !== watermark.lastSeq + 1) return;
    await this.markProjectionWatermark(result.watermark, { updateSnapshot: false });
  }

  private async projectPiHistoryAfterCommit(
    sessionId: string,
    operation: 'append' | 'replace',
    watermark: LocalSessionLedgerWatermark | undefined,
    writeProjection: (() => Promise<void>) | undefined,
  ): Promise<void> {
    try {
      await writeProjection?.();
    } catch (error) {
      if (!this.options.ledgerStore) throw error;
      this.logPiDerivedFailure(sessionId, operation, 'projection', error);
      return;
    }
    try {
      await this.markProjectionWatermark(watermark);
    } catch (error) {
      if (!this.options.ledgerStore) throw error;
      this.logPiDerivedFailure(sessionId, operation, 'watermark_or_snapshot', error);
    }
  }

  private logPiDerivedFailure(
    sessionId: string,
    operation: 'append' | 'replace',
    stage: 'projection' | 'watermark_or_snapshot',
    error: unknown,
  ): void {
    logger.warn(
      {
        session_id: sessionId,
        operation,
        stage,
        error_type: error instanceof Error ? error.name : typeof error,
      },
      '[live-session-writer] Pi history derived write failed after canonical ledger commit',
    );
  }
}

function readTurnId(message: AgentMessage): string | undefined {
  const record = message as AgentMessage & { turnId?: unknown; meta?: { turnId?: unknown } };
  return typeof record.turnId === 'string'
    ? record.turnId
    : typeof record.meta?.turnId === 'string'
      ? record.meta.turnId
      : undefined;
}
