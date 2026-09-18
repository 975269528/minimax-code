import type { MigrationEntry } from '../../migrate.js';

/**
 * Some released Sources profiles recorded version 24 before Canvas claimed it.
 * Recreate the Canvas objects under a new marker without rewriting that history.
 */
export const migration: MigrationEntry = {
  version: 31,
  name: 'repair_canvas_version_collision',
  up: `
    CREATE TABLE IF NOT EXISTS local_runtime_canvas_documents (
      session_id TEXT PRIMARY KEY NOT NULL REFERENCES local_runtime_sessions(session_id) ON DELETE CASCADE,
      canvas_id TEXT NOT NULL UNIQUE, document_json TEXT NOT NULL,
      change_seq INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_runtime_canvas_operations (
      session_id TEXT NOT NULL REFERENCES local_runtime_sessions(session_id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      applied_change_seq INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(session_id, operation_id),
      CONSTRAINT local_runtime_canvas_operations_applied_change_seq CHECK(applied_change_seq >= 1)
    );
    CREATE TABLE IF NOT EXISTS local_runtime_canvas_asset_references (
      session_id TEXT NOT NULL REFERENCES local_runtime_sessions(session_id) ON DELETE CASCADE,
      node_id TEXT NOT NULL, asset_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(session_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_canvas_asset_references_asset
      ON local_runtime_canvas_asset_references(session_id, asset_id);
  `,
};
