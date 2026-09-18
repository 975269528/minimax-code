/**
 * Session asset index — transaction-level primitives.
 *
 * These functions run INSIDE the message-store SQLite transactions so asset
 * occurrence rows stay atomically consistent with
 * `local_runtime_message_rows`. They index message deliverables ("session
 * files" on the DesktopService facade); they are NOT drive nodes — the drive
 * mapping happens at the query adapter.
 *
 * Rows are per-occurrence (one message × one asset), deduped at query time by
 * `asset_key` (latest occurrence wins) so message deletion lets earlier
 * occurrences resurface.
 */
import { collectMessageAssetItems, type DeliverAssetItem } from '@mavis/shared/asset-markup';

import type { DatabaseLike } from '../persistence/db.js';

export const SESSION_ASSET_INDEX_VERSION = 1;

export interface DisplayMessageAssetInput {
  msgId: string;
  role: string | null;
  createdAtMs: number;
  msgContent: string;
}

/**
 * Dedupe key for one asset. Local deliverables always carry a path (the
 * parser fills it even for drive-backed items), so the normalized path is the
 * effective key — matching the Workspace UI's path-keyed dedupe — with
 * drive/artifact ids as defensive fallbacks. The synthetic DriveNode id also
 * derives from this key, which keeps local paths recoverable client-side.
 */
export function computeSessionAssetKey(item: DeliverAssetItem): string {
  return item.path.trim() || item.driveNodeId?.trim() || item.artifactId?.trim() || '';
}

interface AssetOccurrence {
  item: DeliverAssetItem;
  sourceTag: 'deliver-assets' | 'media';
}

/**
 * Parse one complete assistant message body into asset occurrences. The
 * indexer always collects standalone `<media />` (the runtime owns that rule;
 * the UI's Electron-only gate no longer applies here) and never treats bare
 * sources as cloud drive paths (local runtime is not the cloud web path).
 */
export function parseMessageAssetOccurrences(msgContent: string): AssetOccurrence[] {
  const items = collectMessageAssetItems(msgContent);
  if (items.length === 0) return [];
  const wrapperKeys = new Set(
    collectMessageAssetItems(msgContent, { includeStandaloneMedia: false }).map((item) =>
      computeSessionAssetKey(item),
    ),
  );
  return items.map((item) => ({
    item,
    sourceTag: wrapperKeys.has(computeSessionAssetKey(item)) ? 'deliver-assets' : 'media',
  }));
}

/** Replace the asset occurrence rows of one message (assistant-only). */
export function indexDisplayMessageAssetsInTransaction(
  db: DatabaseLike,
  sessionId: string,
  message: DisplayMessageAssetInput,
): void {
  db.prepare('DELETE FROM local_runtime_session_assets WHERE session_id = ? AND msg_id = ?').run(
    sessionId,
    message.msgId,
  );

  if (message.role !== 'assistant' || !message.msgContent) return;

  const occurrences = parseMessageAssetOccurrences(message.msgContent);
  if (occurrences.length === 0) return;

  const now = Date.now();
  const insert = db.prepare(
    `
    INSERT INTO local_runtime_session_assets (
      session_id, msg_id, role, message_created_at_ms,
      asset_index, asset_key, source_tag,
      path, name, asset_type, artifact_id, drive_node_id,
      data_json, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, msg_id, asset_key) DO UPDATE SET
      role = excluded.role,
      message_created_at_ms = excluded.message_created_at_ms,
      asset_index = excluded.asset_index,
      source_tag = excluded.source_tag,
      path = excluded.path,
      name = excluded.name,
      asset_type = excluded.asset_type,
      artifact_id = excluded.artifact_id,
      drive_node_id = excluded.drive_node_id,
      data_json = excluded.data_json,
      updated_at_ms = excluded.updated_at_ms
  `,
  );
  occurrences.forEach(({ item, sourceTag }, index) => {
    const assetKey = computeSessionAssetKey(item);
    if (!assetKey) return;
    insert.run(
      sessionId,
      message.msgId,
      message.role,
      message.createdAtMs,
      index,
      assetKey,
      sourceTag,
      item.path,
      item.name ?? null,
      item.type ?? null,
      item.artifactId ?? null,
      item.driveNodeId ?? null,
      JSON.stringify(item),
      now,
      now,
    );
  });
}

/** Clear derived occurrences while preserving the session's index state row. */
export function clearSessionAssetRowsInTransaction(db: DatabaseLike, sessionId: string): void {
  db.prepare('DELETE FROM local_runtime_session_assets WHERE session_id = ?').run(sessionId);
}

export function deleteSessionAssetRowsForMessagesInTransaction(
  db: DatabaseLike,
  sessionId: string,
  msgIds: string[],
): void {
  const stmt = db.prepare(
    'DELETE FROM local_runtime_session_assets WHERE session_id = ? AND msg_id = ?',
  );
  for (const msgId of msgIds) {
    stmt.run(sessionId, msgId);
  }
}

export function deleteSessionAssetDataInTransaction(db: DatabaseLike, sessionId: string): void {
  clearSessionAssetRowsInTransaction(db, sessionId);
  db.prepare('DELETE FROM local_runtime_session_asset_index_state WHERE session_id = ?').run(
    sessionId,
  );
}

/** Seed a ready/empty index state for a brand-new session. */
export function initSessionAssetIndexStateInTransaction(db: DatabaseLike, sessionId: string): void {
  db.prepare(
    `
    INSERT OR IGNORE INTO local_runtime_session_asset_index_state (
      session_id, index_version, indexed_through_message_row_id, indexed_at_ms, status
    ) VALUES (?, ?, 0, ?, 'ready')
  `,
  ).run(sessionId, SESSION_ASSET_INDEX_VERSION, Date.now());
}

function maxMessageRowId(db: DatabaseLike, sessionId: string): number {
  const row = db
    .prepare('SELECT MAX(id) AS id FROM local_runtime_message_rows WHERE session_id = ?')
    .get(sessionId) as { id?: number | null } | undefined;
  return typeof row?.id === 'number' && Number.isFinite(row.id) ? row.id : 0;
}

/**
 * Advance an up-to-date, ready index state to the current MAX(row id) after
 * a hooked write. Sessions without a state row (pre-feature history) are
 * intentionally left alone — they get a full lazy scan on first query, and
 * the occurrence rows written by the hooks are idempotently replaced then.
 */
export function advanceSessionAssetIndexStateInTransaction(
  db: DatabaseLike,
  sessionId: string,
): void {
  db.prepare(
    `
    UPDATE local_runtime_session_asset_index_state
    SET indexed_through_message_row_id = ?, indexed_at_ms = ?
    WHERE session_id = ? AND index_version = ? AND status = 'ready'
  `,
  ).run(maxMessageRowId(db, sessionId), Date.now(), sessionId, SESSION_ASSET_INDEX_VERSION);
}

/** Mark the whole session as indexed through the current MAX(row id). */
export function markSessionAssetIndexReadyInTransaction(db: DatabaseLike, sessionId: string): void {
  db.prepare(
    `
    INSERT INTO local_runtime_session_asset_index_state (
      session_id, index_version, indexed_through_message_row_id, indexed_at_ms, status, error_json
    ) VALUES (?, ?, ?, ?, 'ready', NULL)
    ON CONFLICT(session_id) DO UPDATE SET
      index_version = excluded.index_version,
      indexed_through_message_row_id = excluded.indexed_through_message_row_id,
      indexed_at_ms = excluded.indexed_at_ms,
      status = 'ready',
      error_json = NULL
  `,
  ).run(sessionId, SESSION_ASSET_INDEX_VERSION, maxMessageRowId(db, sessionId), Date.now());
}

interface IndexableMessageRow {
  id: number;
  msg_id: string;
  role: string | null;
  created_at_ms: number;
  data_json: string;
}

function toDisplayMessageAssetInput(row: IndexableMessageRow): DisplayMessageAssetInput {
  let msgContent = '';
  let role = row.role;
  try {
    const parsed = JSON.parse(row.data_json) as { msg_content?: unknown; role?: unknown };
    if (typeof parsed.msg_content === 'string') msgContent = parsed.msg_content;
    if (!role && typeof parsed.role === 'string') role = parsed.role;
  } catch {
    // Unreadable row payloads contribute no assets.
  }
  return { msgId: row.msg_id, role, createdAtMs: row.created_at_ms, msgContent };
}

/**
 * Scan message rows with `id > afterRowId` and (re)index their assets.
 * Callers wrap this in a transaction together with the state update.
 */
export function indexMessageRowsInTransaction(
  db: DatabaseLike,
  sessionId: string,
  afterRowId: number,
): void {
  const rows = db
    .prepare(
      `
      SELECT id, msg_id, role, created_at_ms, data_json
      FROM local_runtime_message_rows
      WHERE session_id = ? AND id > ?
      ORDER BY id ASC
    `,
    )
    .all(sessionId, afterRowId) as IndexableMessageRow[];
  for (const row of rows) {
    indexDisplayMessageAssetsInTransaction(db, sessionId, toDisplayMessageAssetInput(row));
  }
}

/** Full rebuild: drop all occurrence rows and rescan every message row. */
export function rebuildSessionAssetsInTransaction(db: DatabaseLike, sessionId: string): void {
  clearSessionAssetRowsInTransaction(db, sessionId);
  indexMessageRowsInTransaction(db, sessionId, 0);
  markSessionAssetIndexReadyInTransaction(db, sessionId);
}
