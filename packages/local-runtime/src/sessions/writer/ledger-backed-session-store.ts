import type { LocalSessionRecord, LocalSessionStore } from '../controller.js';
import type { LocalSessionLedgerWatermark } from '../ledger/index.js';
import type { LiveSessionWriter } from './live-session-writer.js';

export interface LedgerBackedLocalSessionStoreOptions {
  delegate: LocalSessionStore;
  writer: LiveSessionWriter;
}

export class LedgerBackedLocalSessionStore implements LocalSessionStore {
  private readonly delegate: LocalSessionStore;
  private readonly writer: LiveSessionWriter;

  constructor(options: LedgerBackedLocalSessionStoreOptions) {
    this.delegate = options.delegate;
    this.writer = options.writer;
  }

  get(sessionId: string): Promise<LocalSessionRecord | undefined> {
    return this.delegate.get(sessionId);
  }

  async upsert(record: LocalSessionRecord): Promise<void> {
    await this.writer.withSessionWriteLock(record.sessionId, async () => {
      const existing = await this.delegate.get(record.sessionId);
      let watermark: LocalSessionLedgerWatermark | undefined;
      if (!existing) {
        watermark = await this.writer.recordSessionCreated(record);
      } else if (JSON.stringify(existing) !== JSON.stringify(record)) {
        watermark = await this.writer.recordSessionMetadataUpdated(record);
      }
      await this.delegate.upsert(record);
      await this.writer.markProjectionWatermark(watermark);
    });
  }

  async delete(sessionId: string): Promise<void> {
    await this.writer.withSessionWriteLock(sessionId, async () => {
      const existing = await this.delegate.get(sessionId);
      const watermark = existing ? await this.writer.recordSessionDeleted(sessionId) : undefined;
      await this.delegate.delete(sessionId);
      await this.writer.markProjectionWatermark(watermark);
    });
  }

  list(options?: Parameters<LocalSessionStore['list']>[0]): Promise<LocalSessionRecord[]> {
    return this.delegate.list(options);
  }
}
