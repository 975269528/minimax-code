import { type DataDirInput, type DatabaseLike, withLocalRuntimeDb } from '../../persistence/db.js';
import {
  SqliteLocalMessageStore,
  SqliteLocalSessionStore,
} from '../../persistence/sqlite-persistence.js';
import type {
  LocalSessionLedgerEvent,
  LocalSessionLedgerStore,
  LocalSessionLedgerWatermark,
} from '../ledger/index.js';
import {
  replayLocalSessionLedger,
  type ReplayedLocalSessionProjection,
} from './session-projection-replay.js';

export interface LocalSessionProjectionStore {
  getWatermark(sessionId: string): Promise<LocalSessionLedgerWatermark | undefined>;
  markWatermark(watermark: LocalSessionLedgerWatermark): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface RepairLocalSessionProjectionResult {
  projection: ReplayedLocalSessionProjection;
  repaired: boolean;
}

export class SqliteLocalSessionProjectionStore implements LocalSessionProjectionStore {
  private readonly sessionStore: SqliteLocalSessionStore;
  private readonly messageStore: SqliteLocalMessageStore;

  constructor(private readonly dataDir: DataDirInput) {
    this.sessionStore = new SqliteLocalSessionStore(dataDir);
    this.messageStore = new SqliteLocalMessageStore(dataDir);
  }

  async getWatermark(sessionId: string): Promise<LocalSessionLedgerWatermark | undefined> {
    return withLocalRuntimeDb(this.dataDir, (db) => readProjectionWatermark(db, sessionId));
  }

  async markWatermark(watermark: LocalSessionLedgerWatermark): Promise<void> {
    withLocalRuntimeDb(this.dataDir, (db) => upsertProjectionWatermark(db, watermark));
  }

  async deleteSession(sessionId: string): Promise<void> {
    withLocalRuntimeDb(this.dataDir, (db) => {
      db.prepare(
        'DELETE FROM local_runtime_session_projection_watermarks WHERE session_id = ?',
      ).run(sessionId);
    });
  }

  async isSessionProjectionStale(
    sessionId: string,
    ledgerStore: LocalSessionLedgerStore,
  ): Promise<boolean> {
    const ledgerWatermark = await ledgerStore.getWatermark(sessionId);
    const projectionWatermark = await this.getWatermark(sessionId);
    if (!ledgerWatermark) return Boolean(projectionWatermark);
    return (
      !projectionWatermark ||
      projectionWatermark.lastSeq < ledgerWatermark.lastSeq ||
      projectionWatermark.lastEventId !== ledgerWatermark.lastEventId
    );
  }

  async repairSessionFromLedger(
    sessionId: string,
    ledgerStore: LocalSessionLedgerStore,
  ): Promise<RepairLocalSessionProjectionResult> {
    const events: LocalSessionLedgerEvent[] = [];
    for await (const event of ledgerStore.readEvents(sessionId)) events.push(event);
    const projection = replayLocalSessionLedger(sessionId, events);

    if (!projection.watermark) {
      await this.sessionStore.delete(sessionId);
      await this.messageStore.deleteSession(sessionId);
      await this.deleteSession(sessionId);
      return { projection, repaired: true };
    }

    if (projection.deleted) {
      await this.sessionStore.delete(sessionId);
    } else if (projection.record) {
      await this.sessionStore.upsert(projection.record);
    }
    await this.messageStore.setDisplayMessages(sessionId, projection.displayMessages);
    await this.messageStore.setPiHistory(sessionId, projection.piHistory);
    await this.markWatermark(projection.watermark);
    return { projection, repaired: true };
  }
}

function readProjectionWatermark(
  db: DatabaseLike,
  sessionId: string,
): LocalSessionLedgerWatermark | undefined {
  const row = db
    .prepare(
      `
      SELECT last_seq, last_event_id, updated_at_ms
      FROM local_runtime_session_projection_watermarks
      WHERE session_id = ?
    `,
    )
    .get(sessionId) as
    | { last_seq?: unknown; last_event_id?: unknown; updated_at_ms?: unknown }
    | undefined;
  if (!row) return undefined;
  return {
    sessionId,
    lastSeq: Number(row.last_seq),
    lastEventId: String(row.last_event_id ?? ''),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function upsertProjectionWatermark(db: DatabaseLike, watermark: LocalSessionLedgerWatermark): void {
  db.prepare(
    `
    INSERT INTO local_runtime_session_projection_watermarks (
      session_id,
      last_seq,
      last_event_id,
      updated_at_ms
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      last_seq = excluded.last_seq,
      last_event_id = excluded.last_event_id,
      updated_at_ms = excluded.updated_at_ms
  `,
  ).run(watermark.sessionId, watermark.lastSeq, watermark.lastEventId, watermark.updatedAtMs);
}
