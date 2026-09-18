import type { MigrationEntry } from '../../migrate.js';

const PROJECT_AGGREGATE_ASSIGNMENTS = `latest_activity_at_ms = COALESCE((
      SELECT MAX(s.updated_at_ms)
      FROM local_runtime_sessions s
      WHERE s.project_id = local_runtime_projects.project_id
        AND s.columnar_version = 3
        AND s.archived = 0
        AND s.visibility <> 'hidden'
        AND s.session_kind NOT IN ('peek', 'cron')
    ), 0),
    session_count = (
      SELECT COUNT(*)
      FROM local_runtime_sessions s
      WHERE s.project_id = local_runtime_projects.project_id
        AND s.columnar_version = 3
        AND s.archived = 0
        AND s.visibility <> 'hidden'
        AND s.session_kind NOT IN ('peek', 'cron')
        AND s.parent_session_id IS NULL
    )`;

const INSERT_PROJECT_FOR_NEW_SESSION = `
  INSERT INTO local_runtime_projects(
    project_kind, workspace_dir, latest_activity_at_ms, created_at_ms, updated_at_ms
  )
  SELECT
    CASE WHEN NEW.is_default_workspace = 1 THEN 'default' ELSE 'workspace' END,
    CASE WHEN NEW.is_default_workspace = 1 THEN NULL ELSE NEW.project_workspace_dir END,
    CASE
      WHEN NEW.columnar_version = 3 AND NEW.archived = 0 AND NEW.visibility <> 'hidden'
        AND NEW.session_kind NOT IN ('peek', 'cron')
      THEN NEW.updated_at_ms ELSE 0
    END,
    COALESCE(NEW.created_at_ms, NEW.updated_at_ms, 0),
    COALESCE(NEW.created_at_ms, NEW.updated_at_ms, 0)
  WHERE NEW.columnar_version = 3
    AND (
      NEW.is_default_workspace = 1
      OR (NEW.project_workspace_dir IS NOT NULL AND trim(NEW.project_workspace_dir) <> '')
    )
  ON CONFLICT DO NOTHING;

  UPDATE local_runtime_sessions
  SET project_id = COALESCE((
    SELECT p.project_id
    FROM local_runtime_projects p
    WHERE NEW.columnar_version = 3
      AND (
        NEW.is_default_workspace = 1
        OR (NEW.project_workspace_dir IS NOT NULL AND trim(NEW.project_workspace_dir) <> '')
      )
      AND (
        (p.project_kind = 'default' AND NEW.is_default_workspace = 1)
        OR (
          p.project_kind = 'workspace' AND NOT (NEW.is_default_workspace = 1)
          AND p.workspace_dir = NEW.project_workspace_dir
        )
      )
  ), 0)
  WHERE session_id = NEW.session_id;
`;

const PROJECT_V5_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS trg_local_runtime_project_session_insert_v5
  AFTER INSERT ON local_runtime_sessions
  WHEN NEW.columnar_version = 3
  BEGIN
    ${INSERT_PROJECT_FOR_NEW_SESSION}
    UPDATE local_runtime_projects
    SET ${PROJECT_AGGREGATE_ASSIGNMENTS}
    WHERE project_id = (
      SELECT project_id FROM local_runtime_sessions WHERE session_id = NEW.session_id
    );
  END;

  CREATE TRIGGER IF NOT EXISTS trg_local_runtime_project_session_assignment_v5
  AFTER UPDATE OF columnar_version, project_workspace_dir, is_default_workspace
  ON local_runtime_sessions
  WHEN NEW.columnar_version = 3
    AND (
      OLD.columnar_version IS NOT NEW.columnar_version
      OR OLD.project_workspace_dir IS NOT NEW.project_workspace_dir
      OR OLD.is_default_workspace IS NOT NEW.is_default_workspace
    )
  BEGIN
    ${INSERT_PROJECT_FOR_NEW_SESSION}
    UPDATE local_runtime_projects
    SET ${PROJECT_AGGREGATE_ASSIGNMENTS}
    WHERE project_id IN (
      COALESCE(OLD.project_id, 0),
      COALESCE((
        SELECT project_id FROM local_runtime_sessions WHERE session_id = NEW.session_id
      ), 0)
    );
  END;

  CREATE TRIGGER IF NOT EXISTS trg_local_runtime_project_session_activity_v5
  AFTER UPDATE OF
    updated_at_ms, created_at_ms, archived, parent_session_id, session_type,
    visibility, session_kind
  ON local_runtime_sessions
  WHEN OLD.columnar_version IS NEW.columnar_version
    AND OLD.project_workspace_dir IS NEW.project_workspace_dir
    AND OLD.is_default_workspace IS NEW.is_default_workspace
  BEGIN
    UPDATE local_runtime_projects
    SET ${PROJECT_AGGREGATE_ASSIGNMENTS}
    WHERE project_id IN (COALESCE(OLD.project_id, 0), COALESCE(NEW.project_id, 0));
  END;

  CREATE TRIGGER IF NOT EXISTS trg_local_runtime_project_session_delete_v5
  AFTER DELETE ON local_runtime_sessions
  WHEN OLD.project_id > 0
  BEGIN
    UPDATE local_runtime_projects
    SET ${PROJECT_AGGREGATE_ASSIGNMENTS}
    WHERE project_id = OLD.project_id;
  END;
`;

/**
 * Published Agents-train entry retained for m0033 compatibility. It is not in
 * the canonical registry because preview_train owns version 28.
 */
export const publishedChannelSessionsMigration: MigrationEntry = {
  version: 28,
  name: 'surface_channel_sessions',
  up(database) {
    database.exec(`
      DROP INDEX IF EXISTS idx_local_runtime_sessions_project_activity_v4;
      DROP INDEX IF EXISTS idx_local_runtime_sessions_project_root_recency_v4;
      DROP INDEX IF EXISTS idx_local_runtime_sessions_project_agent_root_recency_v4;
      DROP TRIGGER IF EXISTS trg_local_runtime_project_session_insert_v5;
      DROP TRIGGER IF EXISTS trg_local_runtime_project_session_assignment_v5;
      DROP TRIGGER IF EXISTS trg_local_runtime_project_session_activity_v5;
      DROP TRIGGER IF EXISTS trg_local_runtime_project_session_delete_v5;

      UPDATE local_runtime_sessions
      SET session_kind = 'channel', visibility = 'visible'
      WHERE columnar_version = 3
        AND visibility = 'hidden'
        AND (
          session_kind = 'channel'
          OR (
            session_kind IN ('conversation', 'unknown')
            AND (
              substr(trim(COALESCE(purpose, '')), 1, 8) = 'channel:'
              OR substr(trim(COALESCE(purpose, '')), 1, 3) = 'im:'
            )
          )
        );

      CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_project_activity_v4
        ON local_runtime_sessions(project_id, updated_at_ms DESC)
        WHERE columnar_version = 3 AND archived = 0 AND visibility <> 'hidden'
          AND session_kind NOT IN ('peek', 'cron');
      CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_project_root_recency_v4
        ON local_runtime_sessions(
          project_id, archived, updated_at_ms DESC, created_at_ms DESC, session_id ASC
        )
        WHERE columnar_version = 3 AND parent_session_id IS NULL AND visibility <> 'hidden'
          AND session_kind NOT IN ('peek', 'cron');
      CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_project_agent_root_recency_v4
        ON local_runtime_sessions(
          project_id, agent_name, archived, updated_at_ms DESC, created_at_ms DESC, session_id ASC
        )
        WHERE columnar_version = 3 AND parent_session_id IS NULL AND visibility <> 'hidden'
          AND session_kind NOT IN ('peek', 'cron');

      ${PROJECT_V5_TRIGGERS_SQL}

      UPDATE local_runtime_projects
      SET ${PROJECT_AGGREGATE_ASSIGNMENTS};
    `);
  },
};
