import type { MigrationEntry } from '../../migrate.js';

export const migration: MigrationEntry = {
  version: 1,
  name: 'runtime_v2_baseline',
  up: `
    CREATE TABLE local_runtime_v2_scheduler_jobs (
      scheduler_id TEXT PRIMARY KEY,
      handler_key TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      run_count INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      next_run_at_ms INTEGER NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      schedule_generation INTEGER NOT NULL DEFAULT 0,
      CONSTRAINT local_runtime_v2_scheduler_job_identity CHECK (
        length(trim(scheduler_id)) > 0
        AND length(trim(handler_key)) > 0
        AND json_valid(schedule_json)
      ),
      CONSTRAINT local_runtime_v2_scheduler_job_state CHECK (
        state IN ('active', 'completed', 'expired', 'cancelled')
      ),
      CONSTRAINT local_runtime_v2_scheduler_job_count CHECK (run_count >= 0),
      CONSTRAINT local_runtime_v2_scheduler_job_generation CHECK (schedule_generation >= 0),
      CONSTRAINT local_runtime_v2_scheduler_job_next_run CHECK (
        (state = 'active' AND next_run_at_ms IS NOT NULL)
        OR (state IN ('completed', 'expired', 'cancelled') AND next_run_at_ms IS NULL)
      ),
      CONSTRAINT local_runtime_v2_scheduler_job_timestamps CHECK (
        created_at_ms >= 0 AND updated_at_ms >= 0
      )
    );

    CREATE TABLE local_runtime_v2_cron_definitions (
      cron_id TEXT PRIMARY KEY,
      scheduler_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      target_session_id TEXT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      deleted_at_ms INTEGER NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      CONSTRAINT local_runtime_v2_cron_definition_identity CHECK (
        length(trim(cron_id)) > 0 AND length(trim(scheduler_id)) > 0
      ),
      CONSTRAINT local_runtime_v2_cron_definition_text CHECK (
        length(trim(agent_name)) > 0
        AND length(trim(name)) > 0
        AND length(trim(prompt)) > 0
      ),
      CONSTRAINT local_runtime_v2_cron_definition_target CHECK (
        target_session_id IS NULL OR length(trim(target_session_id)) > 0
      ),
      CONSTRAINT local_runtime_v2_cron_definition_revision CHECK (revision >= 0)
    );
    CREATE UNIQUE INDEX idx_v2_cron_definitions_scheduler
      ON local_runtime_v2_cron_definitions(scheduler_id);
    CREATE UNIQUE INDEX idx_v2_cron_definitions_active_name
      ON local_runtime_v2_cron_definitions(agent_name, name)
      WHERE deleted_at_ms IS NULL;
    CREATE INDEX idx_v2_cron_definitions_page
      ON local_runtime_v2_cron_definitions(agent_name, created_at_ms DESC, cron_id DESC);

    CREATE TABLE local_runtime_v2_cron_runs (
      run_id TEXT PRIMARY KEY,
      cron_id TEXT NOT NULL,
      scheduler_trigger_id TEXT NULL,
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
    CREATE UNIQUE INDEX idx_v2_cron_runs_scheduler_trigger
      ON local_runtime_v2_cron_runs(scheduler_trigger_id)
      WHERE scheduler_trigger_id IS NOT NULL;
    CREATE INDEX idx_v2_cron_runs_page
      ON local_runtime_v2_cron_runs(cron_id, created_at_ms DESC, run_id DESC);
  `,
};
