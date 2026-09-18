import type { MigrationEntry } from '../../migrate.js';

/**
 * Some published profiles recorded version 21 for an unrelated Agent definition
 * migration. Re-assert the Session history location column under a new version so
 * those profiles converge without rewriting migration history or existing rows.
 */
export const migration: MigrationEntry = {
  version: 28,
  name: 'repair_session_history_relative_dir_version_collision',
  up: (database) => {
    const existing = database
      .prepare("SELECT name FROM pragma_table_info('local_runtime_sessions') WHERE name = ?")
      .all('history_relative_dir');
    if (existing.length > 0) return;
    database.exec(`
      ALTER TABLE local_runtime_sessions
        ADD COLUMN history_relative_dir TEXT;
    `);
  },
};
