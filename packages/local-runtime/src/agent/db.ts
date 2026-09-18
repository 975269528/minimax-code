import fs from 'node:fs';
import path from 'node:path';

import { loadBetterSqlite3Module } from '../persistence/better-sqlite3-loader.js';
import type { DatabaseConstructor, DatabaseLike } from '../persistence/db.js';

const dbCache = new Map<string, DatabaseLike>();

export function resolveAgentDbPath(dataDir: string): string {
  return path.join(dataDir, 'sqlite.db');
}

export function openAgentDb(dataDir: string): DatabaseLike {
  const dbPath = resolveAgentDbPath(dataDir);
  const cached = dbCache.get(dbPath);
  if (cached) return cached;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const Database = loadBetterSqlite3Module<DatabaseConstructor>();
  const db = new Database(dbPath);
  configureAgentDb(db);
  ensureAgentSchema(db);
  dbCache.set(dbPath, db);
  return db;
}

export function closeAgentDb(dataDir: string): void {
  const dbPath = resolveAgentDbPath(dataDir);
  const db = dbCache.get(dbPath);
  if (!db) return;
  dbCache.delete(dbPath);
  db.close();
}

export function ensureAgentSchema(db: DatabaseLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_name           TEXT PRIMARY KEY,
      agent_role           INTEGER NOT NULL,
      framework_type       TEXT NOT NULL,
      pid                  INTEGER,
      port                 INTEGER,
      process_alive        INTEGER DEFAULT 0,
      last_active_at       INTEGER,
      config_synced_hash   TEXT,
      main_session_id      TEXT,
      source_project       TEXT,
      harness_source_type  TEXT NOT NULL DEFAULT '',
      creation_source      TEXT NOT NULL DEFAULT 'manual',
      enc_display_name     TEXT,
      enc_description      TEXT,
      enc_avatar           TEXT,
      greeting_sent        INTEGER NOT NULL DEFAULT 0,
      star_timestamp       INTEGER,
      pinned               INTEGER DEFAULT 0,
      pinned_at            INTEGER,
      spawned_by_data_dir  TEXT,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    );
  `);

  const hadGreetingSent = hasColumn(db, 'agents', 'greeting_sent');

  addColumnIfMissing(db, 'agents', 'agent_role', `INTEGER NOT NULL DEFAULT 0`);
  addColumnIfMissing(db, 'agents', 'framework_type', "TEXT NOT NULL DEFAULT 'pi-agent'");
  addColumnIfMissing(db, 'agents', 'pid', 'INTEGER');
  addColumnIfMissing(db, 'agents', 'port', 'INTEGER');
  addColumnIfMissing(db, 'agents', 'process_alive', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'agents', 'last_active_at', 'INTEGER');
  addColumnIfMissing(db, 'agents', 'config_synced_hash', 'TEXT');
  addColumnIfMissing(db, 'agents', 'main_session_id', 'TEXT');
  addColumnIfMissing(db, 'agents', 'source_project', 'TEXT');
  addColumnIfMissing(db, 'agents', 'harness_source_type', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'agents', 'creation_source', "TEXT NOT NULL DEFAULT 'manual'");
  addColumnIfMissing(db, 'agents', 'enc_display_name', 'TEXT');
  addColumnIfMissing(db, 'agents', 'enc_description', 'TEXT');
  addColumnIfMissing(db, 'agents', 'enc_avatar', 'TEXT');
  addColumnIfMissing(db, 'agents', 'greeting_sent', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'agents', 'star_timestamp', 'INTEGER');
  addColumnIfMissing(db, 'agents', 'pinned', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'agents', 'pinned_at', 'INTEGER');
  addColumnIfMissing(db, 'agents', 'opencode_config_hash', 'TEXT');
  addColumnIfMissing(db, 'agents', 'spawned_by_data_dir', 'TEXT');
  addColumnIfMissing(db, 'agents', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'agents', 'updated_at', 'INTEGER NOT NULL DEFAULT 0');
  if (!hadGreetingSent) {
    // Match preview migration semantics: existing agents were already greeted
    // before the flag existed.
    db.exec('UPDATE agents SET greeting_sent = 1');
  }
  backfillAgentSchemaDefaults(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agents_source_project
      ON agents(source_project);

    CREATE INDEX IF NOT EXISTS idx_agents_process_state
      ON agents(framework_type, process_alive);
  `);
}

function configureAgentDb(db: DatabaseLike): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
  `);
}

function addColumnIfMissing(
  db: DatabaseLike,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function hasColumn(db: DatabaseLike, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return rows.some((row) => row.name === column);
}

function backfillAgentSchemaDefaults(db: DatabaseLike): void {
  db.prepare(
    `
    UPDATE agents
    SET
      agent_role = COALESCE(agent_role, ?),
      framework_type = COALESCE(framework_type, 'pi-agent'),
      process_alive = COALESCE(process_alive, 0),
      harness_source_type = COALESCE(harness_source_type, ''),
      creation_source = COALESCE(creation_source, 'manual'),
      greeting_sent = COALESCE(greeting_sent, 0),
      created_at = COALESCE(created_at, 0),
      updated_at = COALESCE(updated_at, 0)
  `,
  ).run(0);
}
