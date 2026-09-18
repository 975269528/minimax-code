import type { MigrationEntry } from '../../migrate.js';

export const migration: MigrationEntry = {
  version: 22,
  name: 'create_queue_pauses',
  up: (database) => {
    database.exec(`
      CREATE TABLE local_runtime_queue_pauses (
        session_id TEXT PRIMARY KEY,
        cause TEXT NOT NULL,
        trigger_turn_id TEXT NOT NULL,
        paused_at_ms INTEGER NOT NULL,
        CONSTRAINT local_runtime_queue_pauses_cause_check
          CHECK (cause IN ('user-stop', 'turn-final-failure'))
      );
    `);
  },
};
