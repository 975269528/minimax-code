import type { MigrationDatabase, MigrationEntry } from '../../migrate.js';

/** Restore the manual-run idempotency index omitted by a published schema variant. */
export const migration: MigrationEntry = {
  version: 36,
  name: 'repair_cron_manual_request_index',
  up: repairCronManualRequestIndex,
};

function repairCronManualRequestIndex(database: MigrationDatabase): void {
  const hasManualRequestId =
    database
      .prepare(
        `SELECT 1
         FROM pragma_table_info('local_runtime_v2_cron_runs')
         WHERE name = 'manual_request_id'`,
      )
      .all().length > 0;
  if (!hasManualRequestId) return;

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_cron_runs_manual_request
      ON local_runtime_v2_cron_runs(manual_request_id)
      WHERE manual_request_id IS NOT NULL;
  `);
}
