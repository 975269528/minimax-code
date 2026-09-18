import type { MigrationEntry } from '../../migrate.js';

/** Frozen Session-scoped source identity and per-message usage schema. */
export const migration: MigrationEntry = {
  version: 25,
  name: 'create_session_resources',
  up: `
    CREATE TABLE IF NOT EXISTS session_resources (
      session_id TEXT NOT NULL,
      resource_index INTEGER NOT NULL,
      resource_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      resource_data_json TEXT NOT NULL,
      resource_data_version INTEGER NOT NULL DEFAULT 1,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_id, resource_index),
      CONSTRAINT session_resources_index_check CHECK (resource_index > 0),
      CONSTRAINT session_resources_type_check
        CHECK (resource_type IN ('web', 'mcp', 'app', 'file')),
      CONSTRAINT session_resources_source_id_check
        CHECK (source_id = resource_type || ':' || CAST(resource_index AS TEXT)),
      CONSTRAINT session_resources_data_json_check CHECK (json_valid(resource_data_json)),
      CONSTRAINT session_resources_data_version_check CHECK (resource_data_version > 0),
      CONSTRAINT session_resources_created_at_check CHECK (created_at_ms >= 0),
      CONSTRAINT session_resources_updated_at_check CHECK (updated_at_ms >= 0),
      FOREIGN KEY (session_id)
        REFERENCES local_runtime_sessions(session_id)
        ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_resources_source_id
      ON session_resources(session_id, source_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_resources_identity
      ON session_resources(session_id, resource_type, resource_key);

    CREATE TABLE IF NOT EXISTS session_turn_resources (
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      resource_index INTEGER NOT NULL,
      resource_ordinal INTEGER NOT NULL,
      tool_call_id TEXT,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_id, msg_id, resource_ordinal),
      CONSTRAINT session_turn_resources_ordinal_check CHECK (resource_ordinal >= 0),
      CONSTRAINT session_turn_resources_created_at_check CHECK (created_at_ms >= 0),
      FOREIGN KEY (session_id, resource_index)
        REFERENCES session_resources(session_id, resource_index)
        ON DELETE CASCADE,
      FOREIGN KEY (session_id, msg_id)
        REFERENCES local_runtime_message_rows(session_id, msg_id)
        ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_turn_resources_tool_call
      ON session_turn_resources(session_id, msg_id, tool_call_id)
      WHERE tool_call_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_session_turn_resources_turn
      ON session_turn_resources(session_id, turn_id, resource_ordinal);
    CREATE INDEX IF NOT EXISTS idx_session_turn_resources_resource
      ON session_turn_resources(session_id, resource_index, msg_id, resource_ordinal);
  `,
};
