import type { MigrationEntry } from '../../migrate.js';

/** Existing Desktop data may already carry version 19 without this Task table. */
export const migration: MigrationEntry = {
  version: 20,
  name: 'create_task_session_bindings',
  up: `
    CREATE TABLE IF NOT EXISTS local_runtime_task_session_bindings (
      session_id TEXT PRIMARY KEY
        REFERENCES local_runtime_sessions(session_id) ON DELETE CASCADE,
      definition_json TEXT NOT NULL
        CHECK (length(trim(definition_json)) > 0)
    );
  `,
};
