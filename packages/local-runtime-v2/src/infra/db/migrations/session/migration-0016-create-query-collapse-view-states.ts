import type { MigrationDatabase, MigrationEntry } from '../../migrate.js';

const TABLE = 'local_runtime_query_view_states';
const FINAL_COLUMNS = [
  'session_id',
  'query_key',
  'current_turn_id',
  'force_expanded',
  'processing_started_at_ms',
  'processing_finished_at_ms',
  'updated_at_ms',
] as const;
/** Complete V2 Session-scoped query collapse disclosure schema. */
export const migration: MigrationEntry = {
  version: 16,
  name: 'create_query_collapse_view_states',
  up(database) {
    if (!tableExists(database, TABLE)) {
      createQueryCollapseTable(database);
    } else if (!sameColumns(readColumns(database, TABLE), FINAL_COLUMNS)) {
      throw new Error('Cannot create query collapse state: incompatible existing table');
    }

    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_local_runtime_query_view_states_session
        ON ${TABLE}(session_id, updated_at_ms, query_key);

      CREATE INDEX IF NOT EXISTS idx_local_runtime_query_view_states_current_turn
        ON ${TABLE}(session_id, current_turn_id, updated_at_ms DESC, query_key DESC);
    `);
  },
};

function createQueryCollapseTable(database: MigrationDatabase): void {
  database.exec(`
    CREATE TABLE ${TABLE} (
      session_id TEXT NOT NULL,
      query_key TEXT NOT NULL,
      current_turn_id TEXT NOT NULL,
      force_expanded INTEGER NOT NULL DEFAULT 0,
      processing_started_at_ms INTEGER NOT NULL,
      processing_finished_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(session_id, query_key)
    );
  `);
}

function tableExists(database: MigrationDatabase, table: string): boolean {
  return database.prepare(`PRAGMA table_info(${table})`).all().length > 0;
}

function readColumns(database: MigrationDatabase, table: string): string[] {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .flatMap((row) => {
      if (typeof row !== 'object' || row === null || !('name' in row)) return [];
      const name = row.name;
      return typeof name === 'string' ? [name] : [];
    });
}

function sameColumns(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((column, index) => column === expected[index])
  );
}
