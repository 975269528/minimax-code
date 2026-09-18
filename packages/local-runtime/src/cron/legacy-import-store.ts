import { type DataDirInput, type DatabaseLike, withLocalRuntimeDb } from '../persistence/db.js';

/**
 * Durable record of legacy `.md` crons already imported into SQLite, keyed by
 * `(agentName, cronName)`. This — not the presence of the source file — is the
 * migration's idempotency source of truth: a recorded pair is never re-imported
 * even if the user later deletes the cron, so a delete cannot be resurrected on
 * the next launch.
 */
export interface CronLegacyImportStore {
  has(agentName: string, cronName: string): Promise<boolean>;
  record(agentName: string, cronName: string): Promise<void>;
}

export class SqliteCronLegacyImportStore implements CronLegacyImportStore {
  constructor(
    private readonly dataDir: DataDirInput,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async has(agentName: string, cronName: string): Promise<boolean> {
    return this.withDb((db) => {
      const row = db
        .prepare(
          `SELECT 1 FROM local_runtime_cron_legacy_imports
           WHERE agent_name = ? AND cron_name = ?`,
        )
        .get(agentName, cronName);
      return row !== undefined;
    });
  }

  async record(agentName: string, cronName: string): Promise<void> {
    this.withDb((db) => {
      db.prepare(
        `INSERT OR IGNORE INTO local_runtime_cron_legacy_imports
           (agent_name, cron_name, imported_at_ms)
         VALUES (?, ?, ?)`,
      ).run(agentName, cronName, this.nowMs());
    });
  }

  private withDb<T>(fn: (db: DatabaseLike) => T): T {
    return withLocalRuntimeDb(this.dataDir, fn);
  }
}
