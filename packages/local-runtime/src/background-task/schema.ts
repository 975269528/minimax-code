import type { Migration } from '../persistence/db.js';

export const BACKGROUND_TASK_MIGRATIONS: Migration[] = [
  {
    version: 19,
    sql: `
      CREATE TABLE IF NOT EXISTS local_runtime_background_tasks (
        task_id TEXT PRIMARY KEY,
        owner_session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_runtime_background_tasks_owner
        ON local_runtime_background_tasks(owner_session_id, created_at_ms, task_id);
      CREATE INDEX IF NOT EXISTS idx_local_runtime_background_tasks_status
        ON local_runtime_background_tasks(status, updated_at_ms, task_id);

      CREATE TABLE IF NOT EXISTS local_runtime_background_task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        owner_session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        sequence INTEGER,
        payload_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_local_runtime_background_task_events_task
        ON local_runtime_background_task_events(task_id, id);
      CREATE INDEX IF NOT EXISTS idx_local_runtime_background_task_events_owner
        ON local_runtime_background_task_events(owner_session_id, timestamp_ms, id);
    `,
  },
  {
    version: 20,
    sql: `
      ALTER TABLE local_runtime_background_tasks ADD COLUMN delivered_at_ms INTEGER;
      CREATE INDEX IF NOT EXISTS idx_local_runtime_background_tasks_owner_status_delivery
        ON local_runtime_background_tasks(owner_session_id, status, delivered_at_ms, ended_at_ms, task_id);
    `,
  },
];
