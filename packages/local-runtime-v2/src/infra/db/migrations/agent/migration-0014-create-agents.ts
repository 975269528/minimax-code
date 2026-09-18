import type { MigrationEntry } from '../../migrate.js';

/** Global migration only creates the physical Agent table and its indexes. */
export const migration: MigrationEntry = {
  version: 14,
  name: 'create_agents',
  up: `
    CREATE TABLE agents (
      agent_name           TEXT PRIMARY KEY,
      agent_role           INTEGER NOT NULL,
      framework_type       TEXT NOT NULL,
      pid                  INTEGER,
      port                 INTEGER,
      process_alive        INTEGER DEFAULT 0,
      last_active_at       INTEGER,
      config_synced_hash   TEXT,
      opencode_config_hash TEXT,
      main_session_id      TEXT,
      source_project       TEXT,
      harness_source_type  TEXT NOT NULL DEFAULT '',
      creation_source      TEXT NOT NULL DEFAULT 'manual',
      enc_display_name     TEXT,
      enc_description      TEXT,
      enc_avatar           TEXT,
      greeting_sent        INTEGER NOT NULL DEFAULT 0,
      star_timestamp       INTEGER,
      pinned               INTEGER DEFAULT 0,
      pinned_at            INTEGER,
      spawned_by_data_dir  TEXT,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    );

    CREATE INDEX idx_agents_source_project ON agents(source_project);
    CREATE INDEX idx_agents_process_state ON agents(framework_type, process_alive);
  `,
};
