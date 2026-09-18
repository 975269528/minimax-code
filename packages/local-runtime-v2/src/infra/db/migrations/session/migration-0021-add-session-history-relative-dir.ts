import type { MigrationEntry } from '../../migrate.js';

export const migration: MigrationEntry = {
  version: 21,
  name: 'add_session_history_relative_dir',
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
