import type { MigrationEntry } from '../../migrate.js';

/** Keeps v2-native rows inert while historical v1 runtimes scan the shared Session table. */
export const migration: MigrationEntry = {
  version: 13,
  name: 'backfill_v1_session_record_json',
  up: `
    UPDATE local_runtime_sessions
    SET record_json = json_object(
      'sessionId', session_id,
      'agentName', '__local_runtime_v2__',
      'workspaceDir', workspace_dir,
      'runtime', runtime,
      'sessionType', CASE WHEN session_type = 'task' THEN 'branch' ELSE session_type END,
      'archived', json('true'),
      'visibility', 'hidden',
      'status', 'idle',
      'createdAtMs', coalesce(created_at_ms, updated_at_ms),
      'updatedAtMs', updated_at_ms
    )
    WHERE columnar_version = 3
      AND trim(record_json) = '{}';
  `,
};
