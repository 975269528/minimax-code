import type { MigrationEntry } from '../../migrate.js';

/** Restores v1 primary Agent identity without touching v2-native mavis Sessions. */
export const migration: MigrationEntry = {
  version: 12,
  name: 'restore_legacy_primary_agent',
  up: `
    UPDATE local_runtime_sessions_fts
    SET agent_name_terms = 'c6d c61 c69 c6e'
    WHERE rowid IN (
      SELECT k.fts_rowid
      FROM local_runtime_session_fts_keys k
      INNER JOIN local_runtime_sessions s ON s.session_id = k.session_id
      WHERE s.columnar_version = 3
        AND s.agent_name = 'mavis'
        AND json_extract(
          CASE WHEN json_valid(s.record_json) THEN s.record_json ELSE '{}' END,
          '$.agentName'
        ) = 'main'
    );

    UPDATE local_runtime_sessions
    SET agent_name = 'main'
    WHERE columnar_version = 3
      AND agent_name = 'mavis'
      AND json_extract(
        CASE WHEN json_valid(record_json) THEN record_json ELSE '{}' END,
        '$.agentName'
      ) = 'main';
  `,
};
