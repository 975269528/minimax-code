import type { MigrationDatabase, MigrationEntry } from '../../migrate.js';
import { migration as queuePauseMigration } from './migration-0022-create-queue-pauses.js';

const SESSION_AGENT_DEFINITION_SQL = `
  CREATE TABLE IF NOT EXISTS local_runtime_session_agent_definitions (
    session_id TEXT PRIMARY KEY
      REFERENCES local_runtime_sessions(session_id) ON DELETE CASCADE,
    definition_json TEXT NOT NULL
      CHECK (length(trim(definition_json)) > 0)
  );

  INSERT OR IGNORE INTO local_runtime_session_agent_definitions (session_id, definition_json)
    SELECT session_id, definition_json
    FROM local_runtime_task_session_bindings;
`;

/**
 * Generalizes the V1 Task-only snapshot store without deleting it: the old
 * table remains a downlevel rollback mirror for Task Sessions.
 */
/**
 * Published Agents-train entry retained for m0035 convergence. It is not in
 * the canonical registry because preview_train owns version 25.
 */
export const publishedSessionAgentDefinitionsMigration: MigrationEntry = {
  version: 25,
  name: 'create_session_agent_definitions',
  up(database) {
    // The Agents phase-2 train previously occupied version 22 with the
    // definition table. Repair those profiles before publishing the final
    // version-25 marker; preview_train profiles already have this table.
    if (!tableExists(database, 'local_runtime_queue_pauses')) {
      runMigration(database, queuePauseMigration);
    }
    database.exec(SESSION_AGENT_DEFINITION_SQL);
  },
};

function tableExists(database: MigrationDatabase, tableName: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").all(tableName)
      .length > 0
  );
}

function runMigration(database: MigrationDatabase, entry: MigrationEntry): void {
  if (typeof entry.up === 'string') database.exec(entry.up);
  else entry.up(database);
}
