import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export type AppDb = BetterSQLite3Database;

interface BetterSqlite3Statement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): BetterSqlite3RunResult;
}

interface BetterSqlite3RunResult {
  readonly changes: number;
}

interface BetterSqlite3BackupProgress {
  readonly totalPages: number;
  readonly remainingPages: number;
}

interface BetterSqlite3OpenOptions {
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
  readonly timeout?: number;
}

export interface BetterSqlite3Instance {
  exec(sql: string): void;
  prepare(sql: string): BetterSqlite3Statement;
  backup(filename: string): Promise<BetterSqlite3BackupProgress>;
  transaction<T>(fn: () => T): BetterSqlite3Transaction<T>;
  close(): void;
}

interface BetterSqlite3Transaction<T> {
  (): T;
  immediate(): T;
}

export type BetterSqlite3Constructor = new (
  filename: string,
  options?: BetterSqlite3OpenOptions,
) => BetterSqlite3Instance;

const DB_FILE = 'runtime-state.sqlite';
const DB_RELATIVE_PATH = join('v2', 'sqlite', DB_FILE);

export interface DatabaseClientOptions {
  readonly dataDir: string;
  /** Override the better-sqlite3 load path for Electron native rebuilds. */
  readonly sqlite3ModulePath?: string;
}

export class DatabaseClient {
  private rawDb_: BetterSqlite3Instance | null = null;
  private drizzleDb: AppDb | null = null;
  private readonly dbPath: string;
  private readonly options: DatabaseClientOptions;

  constructor(options: DatabaseClientOptions) {
    this.options = options;
    this.dbPath = join(options.dataDir, DB_RELATIVE_PATH);
  }

  get db(): AppDb {
    if (!this.drizzleDb) this.open();
    if (!this.drizzleDb) throw new Error('Database connection was not initialized');
    return this.drizzleDb;
  }

  /** Get the underlying better-sqlite3 handle for raw SQL / migrations. */
  get rawDb(): BetterSqlite3Instance {
    if (!this.rawDb_) this.open();
    const rawDb = this.rawDb_;
    if (!rawDb) throw new Error('Database connection was not initialized');
    return rawDb;
  }

  /** Save the current connection to the specified file using SQLite's online backup API. */
  async backup(destinationPath: string): Promise<void> {
    await this.rawDb.backup(destinationPath);
  }

  /** Validate the backup through an independent read-only connection; only a single `ok` row passes. */
  hasValidIntegrity(databasePath: string): boolean {
    const Database = loadSqlite3Constructor(this.options.sqlite3ModulePath);
    const verificationDb = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const rows = verificationDb.prepare('PRAGMA integrity_check').all();
      return rows.length === 1 && isIntegrityOkRow(rows[0]);
    } finally {
      verificationDb.close();
    }
  }

  /** Close the connection and release resources. */
  close(): void {
    if (this.rawDb_) {
      this.rawDb_.close();
      this.rawDb_ = null;
      this.drizzleDb = null;
    }
  }

  private open(): BetterSqlite3Instance {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const Database = loadSqlite3Constructor(this.options.sqlite3ModulePath);
    const sqlite = new Database(this.dbPath);
    try {
      // v1 and v2 temporarily access the same database through separate connections; keep PRAGMAs aligned.
      sqlite.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
      `);
      const drizzleDb = drizzle({ client: sqlite as never });
      this.rawDb_ = sqlite;
      this.drizzleDb = drizzleDb;
      return sqlite;
    } catch (error) {
      try {
        sqlite.close();
      } catch {
        // Preserve the connection initialization error.
      }
      throw error;
    }
  }
}

/** Resolve the native SQLite constructor for target and read-only source connections. */
export function loadSqlite3Constructor(overrideModulePath?: string): BetterSqlite3Constructor {
  const overridePath = overrideModulePath?.trim() || process.env.MAVIS_SQLITE3_MODULE_PATH?.trim();
  const require = createRequire(import.meta.url);
  if (overridePath) {
    const loaded: unknown = createRequire(join(overridePath, 'package.json'))('better-sqlite3');
    return resolveSqliteConstructor(loaded);
  }
  const loaded: unknown = require('better-sqlite3');
  return resolveSqliteConstructor(loaded);
}

function resolveSqliteConstructor(loaded: unknown): BetterSqlite3Constructor {
  if (typeof loaded === 'function') return loaded as BetterSqlite3Constructor;
  if (isObject(loaded) && typeof loaded.default === 'function') {
    return loaded.default as BetterSqlite3Constructor;
  }
  throw new TypeError('better-sqlite3 module does not export a database constructor');
}

function isIntegrityOkRow(row: unknown): boolean {
  return isObject(row) && row.integrity_check === 'ok';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
