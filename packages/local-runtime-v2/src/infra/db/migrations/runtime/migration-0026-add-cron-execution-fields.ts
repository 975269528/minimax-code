import type { MigrationDatabase, MigrationEntry } from '../../migrate.js';
import { migration as queryCollapseMigration } from '../session/migration-0016-create-query-collapse-view-states.js';
import { migration as miniAppMigration } from '../miniapp/migration-0023-create-miniapp-state.js';

const CRON_RUN_COLUMNS = [
  'run_id',
  'cron_id',
  'scheduler_trigger_id',
  'trigger_source',
  'session_id',
  'status',
  'created_at_ms',
  'execution_claimed_at_ms',
  'delivered_at_ms',
  'failed_at_ms',
  'error_code',
  'error',
] as const;

/** Definition owns execution input; Run keeps trigger idempotency and lifecycle state. */
/**
 * Published Agents-train entry retained for m0035 convergence. It is not in
 * the canonical registry because preview_train owns version 26.
 */
export const publishedCronExecutionFieldsMigration: MigrationEntry = {
  version: 26,
  name: 'cron_execution_fields',
  up: (database) => {
    // The Agents phase-2 train previously used version 23 for this Cron
    // migration. A train profile therefore needs the final preview_train
    // Mini App contract repaired even though marker 23 already exists.
    runMigration(database, miniAppMigration);
    ensureCronDefinitionExecutionColumns(database);
    const runColumns = readColumns(database, 'local_runtime_v2_cron_runs');
    if (
      hasColumns(database, 'local_runtime_v2_cron_runs', CRON_RUN_COLUMNS) &&
      !runColumns.has('manual_request_id')
    ) {
      rebuildCronRuns(database);
    }
  },
};

function ensureCronDefinitionExecutionColumns(database: MigrationDatabase): void {
  const columns = readColumns(database, 'local_runtime_v2_cron_definitions');
  if (columns.size === 0) return;
  if (!columns.has('project')) {
    database.exec('ALTER TABLE local_runtime_v2_cron_definitions ADD COLUMN project TEXT;');
  }
  if (!columns.has('model')) {
    database.exec('ALTER TABLE local_runtime_v2_cron_definitions ADD COLUMN model TEXT;');
  }
  // A previous feature branch assigned the Cron fields to version 16. Repair
  // the Session-owned schema that the published version 16 must represent.
  if (readColumns(database, 'local_runtime_query_view_states').size === 0) {
    runMigration(database, queryCollapseMigration);
  }
}

function runMigration(database: MigrationDatabase, entry: MigrationEntry): void {
  if (typeof entry.up === 'string') database.exec(entry.up);
  else entry.up(database);
}

function rebuildCronRuns(database: MigrationDatabase): void {
  database.exec(`
    CREATE TABLE local_runtime_v2_cron_runs_next (
      run_id TEXT PRIMARY KEY,
      cron_id TEXT NOT NULL,
      scheduler_trigger_id TEXT NULL,
      manual_request_id TEXT NULL,
      trigger_source TEXT NOT NULL,
      session_id TEXT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      execution_claimed_at_ms INTEGER NULL,
      delivered_at_ms INTEGER NULL,
      failed_at_ms INTEGER NULL,
      error_code TEXT NULL,
      error TEXT NULL,
      CONSTRAINT local_runtime_v2_cron_run_trigger CHECK (
        (trigger_source = 'manual' AND scheduler_trigger_id IS NULL)
        OR (trigger_source = 'scheduled' AND scheduler_trigger_id IS NOT NULL AND length(trim(scheduler_trigger_id)) > 0)
      ),
      CONSTRAINT local_runtime_v2_cron_run_request CHECK (
        manual_request_id IS NULL
        OR (trigger_source = 'manual' AND length(trim(manual_request_id)) > 0)
      ),
      CONSTRAINT local_runtime_v2_cron_run_status CHECK (
        status IN ('pending', 'delivered', 'failed')
      ),
      CONSTRAINT local_runtime_v2_cron_run_session CHECK (
        session_id IS NULL OR length(trim(session_id)) > 0
      ),
      CONSTRAINT local_runtime_v2_cron_run_claim CHECK (
        (execution_claimed_at_ms IS NULL AND status = 'pending' AND session_id IS NULL)
        OR (execution_claimed_at_ms IS NOT NULL AND execution_claimed_at_ms >= 0)
      ),
      CONSTRAINT local_runtime_v2_cron_run_terminal CHECK (
        (status = 'pending' AND delivered_at_ms IS NULL AND failed_at_ms IS NULL AND error_code IS NULL AND error IS NULL)
        OR (status = 'delivered' AND session_id IS NOT NULL AND delivered_at_ms IS NOT NULL AND failed_at_ms IS NULL AND error_code IS NULL AND error IS NULL)
        OR (status = 'failed' AND delivered_at_ms IS NULL AND failed_at_ms IS NOT NULL AND error_code IS NOT NULL AND length(trim(error_code)) > 0)
      ),
      FOREIGN KEY (cron_id)
        REFERENCES local_runtime_v2_cron_definitions(cron_id) ON DELETE RESTRICT
    );
    INSERT INTO local_runtime_v2_cron_runs_next (
      run_id, cron_id, scheduler_trigger_id, manual_request_id, trigger_source,
      session_id, status, created_at_ms,
      execution_claimed_at_ms, delivered_at_ms, failed_at_ms,
      error_code, error
    )
    SELECT
      r.run_id,
      r.cron_id,
      r.scheduler_trigger_id,
      NULL,
      r.trigger_source,
      r.session_id,
      r.status,
      r.created_at_ms,
      r.execution_claimed_at_ms,
      r.delivered_at_ms,
      r.failed_at_ms,
      r.error_code,
      r.error
    FROM local_runtime_v2_cron_runs r;
    DROP TABLE local_runtime_v2_cron_runs;
    ALTER TABLE local_runtime_v2_cron_runs_next RENAME TO local_runtime_v2_cron_runs;
    CREATE UNIQUE INDEX idx_v2_cron_runs_scheduler_trigger
      ON local_runtime_v2_cron_runs(scheduler_trigger_id)
      WHERE scheduler_trigger_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_v2_cron_runs_manual_request
      ON local_runtime_v2_cron_runs(manual_request_id)
      WHERE manual_request_id IS NOT NULL;
    CREATE INDEX idx_v2_cron_runs_page
      ON local_runtime_v2_cron_runs(cron_id, created_at_ms DESC, run_id DESC);
  `);
}

function hasColumns(
  database: MigrationDatabase,
  tableName: string,
  expected: readonly string[],
): boolean {
  const columns = readColumns(database, tableName);
  return expected.every((column) => columns.has(column));
}

function readColumns(database: MigrationDatabase, tableName: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${tableName})`).all();
  return new Set(
    rows.flatMap((row) =>
      typeof row === 'object' && row !== null && 'name' in row && typeof row.name === 'string'
        ? [row.name]
        : [],
    ),
  );
}
