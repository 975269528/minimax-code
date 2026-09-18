import type { MigrationEntry } from '../../migrate.js';

/**
 * Some published source-history profiles recorded version 22 before Queue pause
 * storage used that number. Re-assert the sidecar under a new version so those
 * profiles converge without rewriting migration history or existing rows.
 */
export const migration: MigrationEntry = {
  version: 29,
  name: 'repair_queue_pauses_version_collision',
  up: `
    CREATE TABLE IF NOT EXISTS local_runtime_queue_pauses (
      session_id TEXT PRIMARY KEY,
      cause TEXT NOT NULL,
      trigger_turn_id TEXT NOT NULL,
      paused_at_ms INTEGER NOT NULL,
      CONSTRAINT local_runtime_queue_pauses_cause_check
        CHECK (cause IN ('user-stop', 'turn-final-failure'))
    );
  `,
};
