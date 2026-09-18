import type { MigrationEntry } from '../../migrate.js';

/**
 * Some published profiles already recorded version 20 for an unrelated repair.
 * Re-assert the Task binding table under a new version so those profiles converge
 * without rewriting migration history or deleting existing data.
 */
export const migration: MigrationEntry = {
  version: 27,
  name: 'repair_task_session_bindings_version_collision',
  up: `
    CREATE TABLE IF NOT EXISTS local_runtime_task_session_bindings (
      session_id TEXT PRIMARY KEY
        REFERENCES local_runtime_sessions(session_id) ON DELETE CASCADE,
      definition_json TEXT NOT NULL
        CHECK (length(trim(definition_json)) > 0)
    );
  `,
};
