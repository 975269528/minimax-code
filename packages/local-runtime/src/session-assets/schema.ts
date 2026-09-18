import type { Migration } from '../persistence/db.js';

export const SESSION_ASSET_MIGRATIONS: Migration[] = [
  {
    // 25 is taken by the core sessions updated_at index migration in db.ts.
    version: 26,
    sql: `
      CREATE TABLE IF NOT EXISTS local_runtime_session_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        role TEXT,
        message_created_at_ms INTEGER NOT NULL,
        asset_index INTEGER NOT NULL,
        asset_key TEXT NOT NULL,
        source_tag TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT,
        asset_type TEXT,
        artifact_id TEXT,
        drive_node_id TEXT,
        data_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(session_id, msg_id, asset_key)
      );

      CREATE INDEX IF NOT EXISTS idx_local_runtime_session_assets_session_time
        ON local_runtime_session_assets(session_id, message_created_at_ms DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_local_runtime_session_assets_session_message
        ON local_runtime_session_assets(session_id, msg_id);

      CREATE TABLE IF NOT EXISTS local_runtime_session_asset_index_state (
        session_id TEXT PRIMARY KEY,
        index_version INTEGER NOT NULL,
        indexed_through_message_row_id INTEGER NOT NULL,
        indexed_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_json TEXT
      );
    `,
  },
];
