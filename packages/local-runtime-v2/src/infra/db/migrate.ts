export interface MigrationEntry {
  readonly version: number;
  readonly name: string;
  readonly up: string | ((database: MigrationDatabase) => void);
}

interface MigrationStatement {
  all(...params: readonly unknown[]): unknown[];
  run(...params: readonly unknown[]): unknown;
}

export interface MigrationDatabase {
  exec(sql: string): void;
  prepare(sql: string): MigrationStatement;
}

/**
 * Runtime migration runner.
 *
 * Design choice: No runtime drizzle-kit dependency; migration SQL is handwritten and declared in
 * code. drizzle-kit is used only during development to diff schemas and draft SQL.
 *
 * Why not drizzle-kit migrate():
 * 1. It reads the migration directory from fs at runtime, which is unfriendly to Electron asar.
 * 2. We must coexist with v1 data; some migrations backfill data rather than only applying DDL.
 * 3. Keep runtime dependencies minimal: only drizzle-orm + better-sqlite3.
 */
export function runMigrations(
  rawDb: MigrationDatabase,
  migrations: readonly MigrationEntry[],
): void {
  validateMigrationEntries(migrations);

  // Ensure the meta table exists.
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS local_runtime_v2_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    );
  `);

  const applied = new Set<number>();
  for (const row of rawDb.prepare('SELECT version FROM local_runtime_v2_schema_migrations').all()) {
    if (!isVersionRow(row)) throw new Error('Invalid v2 schema migration history row');
    applied.add(row.version);
  }

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    rawDb.exec('BEGIN IMMEDIATE');
    try {
      if (isMigrationApplied(rawDb, migration.version)) {
        rawDb.exec('COMMIT');
        applied.add(migration.version);
        continue;
      }
      if (typeof migration.up === 'string') {
        rawDb.exec(migration.up);
      } else {
        migration.up(rawDb);
      }
      rawDb
        .prepare(
          'INSERT INTO local_runtime_v2_schema_migrations (version, applied_at_ms) VALUES (?, ?)',
        )
        .run(migration.version, Date.now());
      rawDb.exec('COMMIT');
      applied.add(migration.version);
    } catch (err) {
      rawDb.exec('ROLLBACK');
      throw err;
    }
  }
}

function isMigrationApplied(rawDb: MigrationDatabase, version: number): boolean {
  const rows = rawDb
    .prepare('SELECT version FROM local_runtime_v2_schema_migrations WHERE version = ?')
    .all(version);
  if (rows.length === 0) return false;
  if (rows.length !== 1 || !isVersionRow(rows[0])) {
    throw new Error('Invalid v2 schema migration history row');
  }
  return true;
}

function validateMigrationEntries(migrations: readonly MigrationEntry[]): void {
  const versions = new Set<number>();
  const names = new Set<string>();
  let previousVersion = 0;

  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new Error(`Invalid migration version: ${migration.version}`);
    }
    if (migration.name.trim().length === 0) {
      throw new Error(`Migration ${migration.version} has an empty name`);
    }
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate migration version: ${migration.version}`);
    }
    if (names.has(migration.name)) {
      throw new Error(`Duplicate migration name: ${migration.name}`);
    }
    if (migration.version <= previousVersion) {
      throw new Error('Migration entries must be ordered by ascending version');
    }
    versions.add(migration.version);
    names.add(migration.name);
    previousVersion = migration.version;
  }
}

function isVersionRow(value: unknown): value is { version: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof value.version === 'number' &&
    Number.isSafeInteger(value.version)
  );
}
