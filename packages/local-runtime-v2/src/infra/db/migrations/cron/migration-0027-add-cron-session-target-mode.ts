import type { MigrationDatabase, MigrationEntry } from '../../migrate.js';
import { migration as canvasMigration } from '../canvas/migration-0024-create-canvas.js';

const CRON_TABLE = 'local_runtime_v2_cron_definitions';

/** Preserve an unbound fixed-session target until the first actual execution. */
/**
 * Published Agents-train entry retained for m0035 convergence. It is not in
 * the canonical registry because preview_train owns version 27.
 */
export const publishedCronSessionTargetModeMigration: MigrationEntry = {
  version: 27,
  name: 'add_cron_session_target_mode',
  up(database) {
    // The Agents phase-2 train previously used version 24 for this Cron
    // migration. Repair the final preview_train Canvas contract when that
    // marker came from the train instead of the published Canvas migration.
    if (!canvasSchemaExists(database)) runMigration(database, canvasMigration);
    const columns = readColumns(database);
    if (columns.size === 0) return;
    if (!columns.has('session_target_mode')) {
      database.exec(`
        ALTER TABLE ${CRON_TABLE}
          ADD COLUMN session_target_mode TEXT NOT NULL DEFAULT 'new'
          CHECK (session_target_mode IN ('new', 'sessionId'));
      `);
    }
    database.exec(`
      UPDATE ${CRON_TABLE}
      SET session_target_mode = 'sessionId'
      WHERE target_session_id IS NOT NULL;
    `);
  },
};

function canvasSchemaExists(database: MigrationDatabase): boolean {
  const names = new Set(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'local_runtime_canvas_%'",
      )
      .all()
      .flatMap((row) =>
        typeof row === 'object' && row !== null && 'name' in row && typeof row.name === 'string'
          ? [row.name]
          : [],
      ),
  );
  return names.size > 0;
}

function runMigration(database: MigrationDatabase, entry: MigrationEntry): void {
  if (typeof entry.up === 'string') database.exec(entry.up);
  else entry.up(database);
}

function readColumns(database: MigrationDatabase): Set<string> {
  return new Set(
    database
      .prepare(`PRAGMA table_info(${CRON_TABLE})`)
      .all()
      .flatMap((row) => {
        if (typeof row !== 'object' || row === null || !('name' in row)) return [];
        return typeof row.name === 'string' ? [row.name] : [];
      }),
  );
}
