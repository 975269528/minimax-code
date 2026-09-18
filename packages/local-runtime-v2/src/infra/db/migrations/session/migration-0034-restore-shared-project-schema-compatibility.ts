import type { MigrationEntry } from '../../migrate.js';
import { migration as restoreProjectTriggersMigration } from './migration-0018-restore-project-v5-trigger-compatibility.js';

/**
 * Released desktop builds validate the exact v4 indexes and v5 trigger bodies.
 * Keep those contracts immutable when multiple builds share a data directory.
 * Channel-inclusive reads use separately named indexes and repository projections;
 * the old triggers remain the sole writers of the persisted project aggregates.
 */
export const migration: MigrationEntry = {
  version: 34,
  name: 'restore_shared_project_schema_compatibility',
  up(database) {
    database.exec(`
      DROP INDEX IF EXISTS idx_local_runtime_sessions_project_activity_v4;
      DROP INDEX IF EXISTS idx_local_runtime_sessions_project_root_recency_v4;
      DROP INDEX IF EXISTS idx_local_runtime_sessions_project_agent_root_recency_v4;

      CREATE INDEX idx_local_runtime_sessions_project_activity_v4
        ON local_runtime_sessions(project_id, updated_at_ms DESC)
        WHERE columnar_version = 3 AND archived = 0 AND visibility <> 'hidden'
          AND session_kind NOT IN ('peek', 'channel', 'cron');
      CREATE INDEX idx_local_runtime_sessions_project_root_recency_v4
        ON local_runtime_sessions(project_id, archived, updated_at_ms DESC, created_at_ms DESC, session_id ASC)
        WHERE columnar_version = 3 AND parent_session_id IS NULL AND visibility <> 'hidden'
          AND session_kind NOT IN ('peek', 'channel', 'cron');
      CREATE INDEX idx_local_runtime_sessions_project_agent_root_recency_v4
        ON local_runtime_sessions(project_id, agent_name, archived, updated_at_ms DESC, created_at_ms DESC, session_id ASC)
        WHERE columnar_version = 3 AND parent_session_id IS NULL AND visibility <> 'hidden'
          AND session_kind NOT IN ('peek', 'channel', 'cron');

      CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_project_activity_v6
        ON local_runtime_sessions(project_id, updated_at_ms DESC)
        WHERE columnar_version = 3 AND archived = 0 AND visibility <> 'hidden'
          AND session_kind NOT IN ('peek', 'cron');
      CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_project_root_recency_v6
        ON local_runtime_sessions(project_id, archived, updated_at_ms DESC, created_at_ms DESC, session_id ASC)
        WHERE columnar_version = 3 AND parent_session_id IS NULL AND visibility <> 'hidden'
          AND session_kind NOT IN ('peek', 'cron');
      CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_project_agent_root_recency_v6
        ON local_runtime_sessions(project_id, agent_name, archived, updated_at_ms DESC, created_at_ms DESC, session_id ASC)
        WHERE columnar_version = 3 AND parent_session_id IS NULL AND visibility <> 'hidden'
          AND session_kind NOT IN ('peek', 'cron');
    `);
    if (typeof restoreProjectTriggersMigration.up === 'string') {
      database.exec(restoreProjectTriggersMigration.up);
    } else {
      restoreProjectTriggersMigration.up(database);
    }
  },
};
