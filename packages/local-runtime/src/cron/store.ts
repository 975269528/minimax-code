import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  CronConfigSchema,
  type CronConfig,
  type CronConfigUpdate,
  type CronLoadResult,
  type CronSessionRecord,
  type CronStorePort,
} from '@mavis/cron';

import { type DataDirInput, type DatabaseLike, withLocalRuntimeDb } from '../persistence/db.js';

interface CronDbRow {
  agent_name?: string;
  cron_name?: string;
  config_json?: string;
  cron_id?: string | null;
}

interface CronHistoryDbRow {
  session_id?: string;
  created_at_ms?: number;
}

export class SqliteLocalCronStore implements CronStorePort {
  constructor(
    private readonly dataDir: DataDirInput,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async configPath(agentName: string, cronName: string): Promise<string> {
    return path.join(this.resolveDataDir(), 'local-crons', agentName, `${cronName}.json`);
  }

  async get(agentName: string, cronName: string): Promise<CronConfig | undefined> {
    return this.withDb((db) => {
      const row = db
        .prepare(
          `
          SELECT agent_name, cron_name, config_json, cron_id FROM local_runtime_crons
          WHERE agent_name = ? AND cron_name = ?
        `,
        )
        .get(agentName, cronName) as CronDbRow | undefined;
      if (!row) return undefined;
      // Lazy back-fill so any row read through the store always has a cron_id
      // persisted, even if it escaped the migration sweep.
      this.ensureRowCronId(db, row);
      return parseCronConfig(row.config_json);
    });
  }

  async listByAgent(agentName: string): Promise<CronLoadResult[]> {
    return this.withDb((db) => {
      const rows = db
        .prepare(
          `
          SELECT agent_name, cron_name, config_json, cron_id FROM local_runtime_crons
          WHERE agent_name = ?
          ORDER BY cron_name ASC
        `,
        )
        .all(agentName) as CronDbRow[];
      return rows.flatMap((row) => this.rowToLoadResult(db, row));
    });
  }

  async listAll(): Promise<CronLoadResult[]> {
    return this.withDb((db) => {
      const rows = db
        .prepare(
          `
          SELECT agent_name, cron_name, config_json, cron_id FROM local_runtime_crons
          ORDER BY agent_name ASC, cron_name ASC
        `,
        )
        .all() as CronDbRow[];
      return rows.flatMap((row) => this.rowToLoadResult(db, row));
    });
  }

  async getByCronId(cronId: string): Promise<CronLoadResult | undefined> {
    return this.withDb((db) => {
      const row = db
        .prepare(
          `
          SELECT agent_name, cron_name, config_json, cron_id FROM local_runtime_crons
          WHERE cron_id = ?
        `,
        )
        .get(cronId) as CronDbRow | undefined;
      if (!row) return undefined;
      return this.rowToLoadResult(db, row)[0];
    });
  }

  async resolveKeyByCronId(
    cronId: string,
  ): Promise<{ agentName: string; cronName: string } | undefined> {
    return this.withDb((db) => {
      const row = db
        .prepare(
          `
          SELECT agent_name, cron_name FROM local_runtime_crons
          WHERE cron_id = ?
        `,
        )
        .get(cronId) as CronDbRow | undefined;
      if (!row?.agent_name || !row?.cron_name) return undefined;
      return { agentName: row.agent_name, cronName: row.cron_name };
    });
  }

  async create(agentName: string, cronName: string, config: CronConfig): Promise<CronConfig> {
    const parsed = normalizeCronConfig(config);
    this.withDb((db) => {
      const existing = db
        .prepare(
          `
          SELECT 1 FROM local_runtime_crons
          WHERE agent_name = ? AND cron_name = ?
        `,
        )
        .get(agentName, cronName);
      if (existing) {
        throw new Error(`Cron task already exists: ${agentName}/${cronName}`);
      }
      db.prepare(
        `
        INSERT INTO local_runtime_crons (agent_name, cron_name, config_json, updated_at_ms, cron_id)
        VALUES (?, ?, ?, ?, ?)
      `,
      ).run(agentName, cronName, JSON.stringify(parsed), this.nowMs(), randomUUID());
    });
    return parsed;
  }

  async update(agentName: string, cronName: string, fields: CronConfigUpdate): Promise<CronConfig> {
    const current = await this.get(agentName, cronName);
    if (!current) throw new Error(`Cron task not found: ${agentName}/${cronName}`);
    const updated = normalizeCronConfig(applyCronConfigUpdate(current, fields));
    this.withDb((db) => {
      db.prepare(
        `
        UPDATE local_runtime_crons
        SET config_json = ?, updated_at_ms = ?
        WHERE agent_name = ? AND cron_name = ?
      `,
      ).run(JSON.stringify(updated), this.nowMs(), agentName, cronName);
    });
    return updated;
  }

  async delete(agentName: string, cronName: string): Promise<void> {
    this.withDb((db) => {
      runInTransaction(db, () => {
        db.prepare(
          `
          DELETE FROM local_runtime_crons
          WHERE agent_name = ? AND cron_name = ?
        `,
        ).run(agentName, cronName);
        db.prepare(
          `
          DELETE FROM local_runtime_cron_session_history
          WHERE agent_name = ? AND cron_name = ?
        `,
        ).run(agentName, cronName);
      });
    });
  }

  async appendSessionRun(
    agentName: string,
    cronName: string,
    record: CronSessionRecord,
  ): Promise<void> {
    this.withDb((db) => {
      db.prepare(
        `
        INSERT INTO local_runtime_cron_session_history (
          agent_name, cron_name, session_id, created_at_ms
        ) VALUES (?, ?, ?, ?)
      `,
      ).run(agentName, cronName, record.sessionId, record.createdAt);
    });
  }

  async getSessionHistory(agentName: string, cronName: string): Promise<CronSessionRecord[]> {
    return this.withDb((db) => {
      const rows = db
        .prepare(
          `
          SELECT session_id, created_at_ms
          FROM local_runtime_cron_session_history
          WHERE agent_name = ? AND cron_name = ?
          ORDER BY created_at_ms ASC, id ASC
        `,
        )
        .all(agentName, cronName) as CronHistoryDbRow[];
      return rows.flatMap((row) => {
        if (!row.session_id || typeof row.created_at_ms !== 'number') return [];
        return [{ sessionId: row.session_id, createdAt: row.created_at_ms }];
      });
    });
  }

  async replaceSessionHistory(
    agentName: string,
    cronName: string,
    records: CronSessionRecord[],
  ): Promise<void> {
    this.withDb((db) => {
      runInTransaction(db, () => {
        db.prepare(
          `
          DELETE FROM local_runtime_cron_session_history
          WHERE agent_name = ? AND cron_name = ?
        `,
        ).run(agentName, cronName);
        const insert = db.prepare(
          `
          INSERT INTO local_runtime_cron_session_history (
            agent_name, cron_name, session_id, created_at_ms
          ) VALUES (?, ?, ?, ?)
        `,
        );
        for (const record of records) {
          insert.run(agentName, cronName, record.sessionId, record.createdAt);
        }
      });
    });
  }

  async deleteSessionHistory(agentName: string, cronName: string): Promise<void> {
    this.withDb((db) => {
      db.prepare(
        `
        DELETE FROM local_runtime_cron_session_history
        WHERE agent_name = ? AND cron_name = ?
      `,
      ).run(agentName, cronName);
    });
  }

  private rowToLoadResult(db: DatabaseLike, row: CronDbRow): CronLoadResult[] {
    if (!row.agent_name || !row.cron_name) return [];
    const config = parseCronConfig(row.config_json);
    if (!config) return [];
    const cronId = this.ensureRowCronId(db, row);
    return [
      {
        agentName: row.agent_name,
        cronName: row.cron_name,
        config,
        cronId,
        configPath: path.join(
          this.resolveDataDir(),
          'local-crons',
          row.agent_name,
          `${row.cron_name}.json`,
        ),
      },
    ];
  }

  /**
   * Guarantee the row carries a persisted cron_id. Migration back-fill should
   * already cover every row, but a row read with `cron_id IS NULL` (e.g. one
   * written by an older path) is repaired in place here so callers always see
   * a stable id. Mutates `row.cron_id` and returns the resolved value.
   */
  private ensureRowCronId(db: DatabaseLike, row: CronDbRow): string {
    if (typeof row.cron_id === 'string' && row.cron_id.length > 0) return row.cron_id;
    if (!row.agent_name || !row.cron_name) return '';
    const minted = randomUUID();
    db.prepare(
      `
      UPDATE local_runtime_crons
      SET cron_id = ?
      WHERE agent_name = ? AND cron_name = ? AND cron_id IS NULL
    `,
    ).run(minted, row.agent_name, row.cron_name);
    // Re-read so a concurrent writer that won the back-fill race wins here too.
    const persisted = db
      .prepare('SELECT cron_id FROM local_runtime_crons WHERE agent_name = ? AND cron_name = ?')
      .get(row.agent_name, row.cron_name) as { cron_id?: string | null } | undefined;
    const resolved =
      typeof persisted?.cron_id === 'string' && persisted.cron_id.length > 0
        ? persisted.cron_id
        : minted;
    row.cron_id = resolved;
    return resolved;
  }

  private resolveDataDir(): string {
    return typeof this.dataDir === 'function' ? this.dataDir() : this.dataDir;
  }

  private withDb<T>(fn: (db: DatabaseLike) => T): T {
    return withLocalRuntimeDb(this.dataDir, fn);
  }
}

function normalizeCronConfig(config: CronConfig): CronConfig {
  return CronConfigSchema.parse(config);
}

function parseCronConfig(raw: string | undefined): CronConfig | undefined {
  if (!raw) return undefined;
  try {
    return normalizeCronConfig(JSON.parse(raw) as CronConfig);
  } catch {
    return undefined;
  }
}

function applyCronConfigUpdate(config: CronConfig, fields: CronConfigUpdate): CronConfig {
  return {
    ...config,
    ...(fields.disabled !== undefined ? { disabled: fields.disabled } : {}),
    ...(fields.schedule !== undefined ? { schedule: fields.schedule } : {}),
    ...(fields.prompt !== undefined ? { prompt: fields.prompt } : {}),
    ...(fields.session !== undefined ? { session: fields.session } : {}),
    ...(fields.timezone !== undefined
      ? fields.timezone === null
        ? { timezone: undefined }
        : { timezone: fields.timezone }
      : {}),
    ...(fields.activeHours !== undefined
      ? fields.activeHours === null
        ? { activeHours: undefined }
        : { activeHours: fields.activeHours }
      : {}),
    ...(fields.delivery !== undefined
      ? fields.delivery === null
        ? { delivery: undefined }
        : { delivery: fields.delivery }
      : {}),
    ...(fields.report_to_root !== undefined
      ? fields.report_to_root === null
        ? { report_to_root: undefined }
        : { report_to_root: fields.report_to_root }
      : {}),
    ...(fields.report_to_main !== undefined
      ? fields.report_to_main === null
        ? { report_to_main: undefined }
        : { report_to_main: fields.report_to_main }
      : {}),
  };
}

function runInTransaction(db: DatabaseLike, fn: () => void): void {
  if (db.transaction) {
    db.transaction(fn)();
    return;
  }
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
