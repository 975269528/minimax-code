/**
 * SQLite-backed session asset store.
 *
 * Query/lazy-index facade over the occurrence table maintained by the
 * message-store write hooks (see `session-asset-index.ts`). `ensureIndexed`
 * covers pre-feature sessions (no state row → full scan), parser upgrades
 * (version mismatch → rebuild), and hook gaps (lagging state → incremental
 * scan). Legacy blob → row backfill is triggered before scanning; legacy
 * opencode migration must be run by the caller (it lives at the host layer).
 */
import { withLocalRuntimeDb, type DataDirInput, type DatabaseLike } from '../persistence/db.js';
import type {
  ListSessionAssetsResult,
  SessionAssetRecord,
  SessionAssetStore,
} from '../persistence/ports.js';
import { backfillDisplayMessageRowsIfNeededInTransaction } from '../persistence/sqlite-persistence.js';
import {
  SESSION_ASSET_INDEX_VERSION,
  indexMessageRowsInTransaction,
  markSessionAssetIndexReadyInTransaction,
  rebuildSessionAssetsInTransaction,
} from './session-asset-index.js';

export const DEFAULT_SESSION_ASSET_PAGE_SIZE = 50;
export const MAX_SESSION_ASSET_PAGE_SIZE = 1000;

interface SessionAssetCursor {
  messageCreatedAtMs: number;
  id: number;
}

export function encodeSessionAssetCursor(cursor: SessionAssetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeSessionAssetCursor(raw: string | undefined): SessionAssetCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      messageCreatedAtMs?: unknown;
      id?: unknown;
    };
    if (typeof parsed.messageCreatedAtMs !== 'number' || typeof parsed.id !== 'number') {
      return null;
    }
    return { messageCreatedAtMs: parsed.messageCreatedAtMs, id: parsed.id };
  } catch {
    return null;
  }
}

interface IndexStateRow {
  index_version: number;
  indexed_through_message_row_id: number;
  status: string;
}

interface AssetRow {
  id: number;
  msg_id: string;
  role: string | null;
  message_created_at_ms: number;
  asset_key: string;
  source_tag: string;
  path: string;
  name: string | null;
  asset_type: string | null;
  artifact_id: string | null;
  drive_node_id: string | null;
}

function toRecord(row: AssetRow): SessionAssetRecord {
  return {
    rowId: row.id,
    msgId: row.msg_id,
    role: row.role ?? undefined,
    messageCreatedAtMs: row.message_created_at_ms,
    assetKey: row.asset_key,
    sourceTag: row.source_tag,
    path: row.path,
    name: row.name ?? undefined,
    assetType: row.asset_type ?? undefined,
    artifactId: row.artifact_id ?? undefined,
    driveNodeId: row.drive_node_id ?? undefined,
  };
}

export class SqliteSessionAssetStore implements SessionAssetStore {
  /** Per-session in-flight dedupe so concurrent queries index once. */
  private readonly ensureInFlight = new Map<string, Promise<void>>();

  constructor(private readonly dataDir: DataDirInput) {}

  async ensureIndexed(sessionId: string): Promise<void> {
    const inFlight = this.ensureInFlight.get(sessionId);
    if (inFlight) return inFlight;
    const run = Promise.resolve()
      .then(() => this.ensureIndexedSync(sessionId))
      .finally(() => {
        this.ensureInFlight.delete(sessionId);
      });
    this.ensureInFlight.set(sessionId, run);
    return run;
  }

  private ensureIndexedSync(sessionId: string): void {
    this.withDb((db) => {
      try {
        runInTransaction(db, () => {
          backfillDisplayMessageRowsIfNeededInTransaction(db, sessionId);

          const state = db
            .prepare(
              `
              SELECT index_version, indexed_through_message_row_id, status
              FROM local_runtime_session_asset_index_state
              WHERE session_id = ?
            `,
            )
            .get(sessionId) as IndexStateRow | undefined;
          const maxRow = db
            .prepare('SELECT MAX(id) AS id FROM local_runtime_message_rows WHERE session_id = ?')
            .get(sessionId) as { id?: number | null } | undefined;
          const maxId = typeof maxRow?.id === 'number' ? maxRow.id : 0;

          if (
            state &&
            state.status === 'ready' &&
            state.index_version === SESSION_ASSET_INDEX_VERSION &&
            state.indexed_through_message_row_id >= maxId
          ) {
            return;
          }

          if (
            !state ||
            state.index_version !== SESSION_ASSET_INDEX_VERSION ||
            state.status !== 'ready'
          ) {
            rebuildSessionAssetsInTransaction(db, sessionId);
            return;
          }

          indexMessageRowsInTransaction(db, sessionId, state.indexed_through_message_row_id);
          markSessionAssetIndexReadyInTransaction(db, sessionId);
        });
      } catch (error) {
        this.markFailed(db, sessionId, error);
        throw error;
      }
    });
  }

  private markFailed(db: DatabaseLike, sessionId: string, error: unknown): void {
    try {
      db.prepare(
        `
        INSERT INTO local_runtime_session_asset_index_state (
          session_id, index_version, indexed_through_message_row_id, indexed_at_ms, status, error_json
        ) VALUES (?, ?, 0, ?, 'failed', ?)
        ON CONFLICT(session_id) DO UPDATE SET
          status = 'failed',
          indexed_at_ms = excluded.indexed_at_ms,
          error_json = excluded.error_json
      `,
      ).run(
        sessionId,
        SESSION_ASSET_INDEX_VERSION,
        Date.now(),
        JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
      );
    } catch {
      // Failure bookkeeping is best-effort; the original error propagates.
    }
  }

  async listAssets(
    sessionId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<ListSessionAssetsResult> {
    const limit = normalizeLimit(opts?.limit);
    const cursor = decodeSessionAssetCursor(opts?.cursor);
    return this.withDb((db) => {
      const params: Array<string | number> = [sessionId];
      let cursorCondition = '';
      if (cursor) {
        cursorCondition = `
          AND (message_created_at_ms < ?
            OR (message_created_at_ms = ? AND id < ?))
        `;
        params.push(cursor.messageCreatedAtMs, cursor.messageCreatedAtMs, cursor.id);
      }
      const rows = db
        .prepare(
          `
          WITH ranked AS (
            SELECT *,
                   ROW_NUMBER() OVER (
                     PARTITION BY asset_key
                     ORDER BY message_created_at_ms DESC, id DESC
                   ) AS rn
            FROM local_runtime_session_assets
            WHERE session_id = ?
          )
          SELECT id, msg_id, role, message_created_at_ms, asset_key, source_tag,
                 path, name, asset_type, artifact_id, drive_node_id
          FROM ranked
          WHERE rn = 1
            ${cursorCondition}
          ORDER BY message_created_at_ms DESC, id DESC
          LIMIT ?
        `,
        )
        .all(...params, limit + 1) as AssetRow[];

      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      const assets = rows.map(toRecord);
      const last = rows.at(-1);
      return {
        assets,
        hasMore,
        ...(hasMore && last
          ? {
              nextCursor: encodeSessionAssetCursor({
                messageCreatedAtMs: last.message_created_at_ms,
                id: last.id,
              }),
            }
          : {}),
      };
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.withDb((db) => {
      db.prepare('DELETE FROM local_runtime_session_assets WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM local_runtime_session_asset_index_state WHERE session_id = ?').run(
        sessionId,
      );
    });
  }

  private withDb<T>(fn: (db: DatabaseLike) => T): T {
    return withLocalRuntimeDb(this.dataDir, fn);
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined || limit <= 0) {
    return DEFAULT_SESSION_ASSET_PAGE_SIZE;
  }
  return Math.min(Math.floor(limit), MAX_SESSION_ASSET_PAGE_SIZE);
}

function runInTransaction(db: DatabaseLike, fn: () => void): void {
  if (db.transaction) {
    db.transaction(fn as () => unknown)();
    return;
  }
  fn();
}
