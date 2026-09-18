import type { MigrationDatabase, MigrationEntry } from '../../migrate.js';

/**
 * Some published profiles recorded version 29 for the Queue-pause repair
 * before Agent legacy-history notice claimed it. Reapply the frozen Agent
 * snapshot only when that collision left the physical column absent.
 */
/**
 * Published Agents-train entry retained for m0035 convergence. It is not in
 * the canonical registry because preview_train owns version 32.
 */
export const publishedAgentLegacyHistoryNoticeRepairMigration: MigrationEntry = {
  version: 32,
  name: 'repair_agent_legacy_history_notice_version_collision',
  up: (database) => {
    if (hasLegacyHistorySessionId(database)) return;

    database.exec(`
      ALTER TABLE agents ADD COLUMN legacy_history_session_id TEXT;

      UPDATE agents AS agent
      SET legacy_history_session_id = agent.main_session_id
      WHERE agent.legacy_history_session_id IS NULL
        AND agent.main_session_id IS NOT NULL
        AND trim(agent.main_session_id) <> '';

      CREATE TABLE local_runtime_v2_agent_legacy_history_notice_repair (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        cutoff_at_ms INTEGER NOT NULL
      );
    `);
    database
      .prepare(
        `INSERT INTO local_runtime_v2_agent_legacy_history_notice_repair (singleton, cutoff_at_ms)
         VALUES (?, ?)`,
      )
      .run(1, Date.now());
  },
};

function hasLegacyHistorySessionId(database: MigrationDatabase): boolean {
  return database
    .prepare('PRAGMA table_info(agents)')
    .all()
    .some((column) => columnName(column) === 'legacy_history_session_id');
}

function columnName(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('name' in value)) return undefined;
  const name = value.name;
  return typeof name === 'string' ? name : undefined;
}
