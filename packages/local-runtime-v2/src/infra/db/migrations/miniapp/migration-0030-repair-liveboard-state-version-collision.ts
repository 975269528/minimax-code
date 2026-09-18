import type { MigrationEntry } from '../../migrate.js';

type Database = Parameters<Exclude<MigrationEntry['up'], string>>[0];

const TABLE_NAME = 'local_runtime_liveboard_state';

const LIVEBOARD_STATE_SQL = `
  CREATE TABLE local_runtime_liveboard_state (
    plugin_id TEXT PRIMARY KEY NOT NULL,
    accepted_source_digest TEXT NOT NULL,
    client_digest TEXT NOT NULL,
    node_digest TEXT NOT NULL,
    preferred_port INTEGER,
    last_error_json TEXT,
    updated_at_ms INTEGER NOT NULL,
    CONSTRAINT local_runtime_liveboard_state_identity CHECK (
      length(trim(plugin_id)) > 0 AND length(trim(accepted_source_digest)) > 0
      AND length(trim(client_digest)) > 0 AND length(trim(node_digest)) > 0
    ),
    CONSTRAINT local_runtime_liveboard_state_port CHECK (
      preferred_port IS NULL OR (node_digest IS NOT NULL AND preferred_port BETWEEN 1024 AND 65535)
    ),
    CONSTRAINT local_runtime_liveboard_state_updated_at CHECK (updated_at_ms >= 0),
    CONSTRAINT local_runtime_liveboard_state_error CHECK (last_error_json IS NULL OR json_valid(last_error_json))
  );
`;

const COLUMN_CONTRACT = [
  ['plugin_id', 'TEXT', 1, 1],
  ['accepted_source_digest', 'TEXT', 1, 0],
  ['client_digest', 'TEXT', 1, 0],
  ['node_digest', 'TEXT', 1, 0],
  ['preferred_port', 'INTEGER', 0, 0],
  ['last_error_json', 'TEXT', 0, 0],
  ['updated_at_ms', 'INTEGER', 1, 0],
] as const;

const REQUIRED_CHECKS = [
  'length(trim(plugin_id)) > 0',
  'preferred_port is null or (node_digest is not null and preferred_port between 1024 and 65535)',
  'updated_at_ms >= 0',
  'last_error_json is null or json_valid(last_error_json)',
] as const;

export const migration: MigrationEntry = {
  version: 30,
  name: 'repair_liveboard_state_version_collision',
  up: (database: Database) => {
    const exists = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .all(TABLE_NAME)[0];
    if (!exists) database.exec(LIVEBOARD_STATE_SQL);
    assertLiveBoardStateContract(database);
  },
};

function assertLiveBoardStateContract(database: Database): void {
  assertColumnContract(database);
  assertNoForeignKeys(database);
  assertCheckContract(database);
}

function assertColumnContract(database: Database): void {
  const columns = database.prepare(`PRAGMA table_info("${TABLE_NAME}")`).all();
  if (columns.length !== COLUMN_CONTRACT.length) failContract();
  for (const [index, expected] of COLUMN_CONTRACT.entries()) {
    const row = readRow(columns[index]);
    assertContractValue(row.name, expected[0]);
    assertContractValue(row.type.toUpperCase(), expected[1]);
    assertContractValue(row.notnull, expected[2]);
    assertContractValue(row.pk, expected[3]);
    assertContractValue(row.defaultValue, null);
  }
}

function assertNoForeignKeys(database: Database): void {
  const foreignKeys = database.prepare(`PRAGMA foreign_key_list("${TABLE_NAME}")`).all();
  if (foreignKeys.length !== 0) failContract();
}

function assertCheckContract(database: Database): void {
  const result = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .all(TABLE_NAME)[0];
  const normalized = readTableSql(result).replace(/\s+/gu, ' ').toLowerCase();
  if (!REQUIRED_CHECKS.every((check) => normalized.includes(check))) failContract();
}

function readTableSql(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('sql' in value)) failContract();
  const sql = value.sql;
  if (typeof sql !== 'string') failContract();
  return sql;
}

function assertContractValue(actual: unknown, expected: unknown): void {
  if (actual !== expected) failContract();
}

function readRow(value: unknown): {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  defaultValue: string | null;
} {
  if (typeof value !== 'object' || value === null) failContract();
  const row = value as Record<string, unknown>;
  if (
    typeof row.name !== 'string' ||
    typeof row.type !== 'string' ||
    typeof row.notnull !== 'number' ||
    typeof row.pk !== 'number' ||
    (row.dflt_value !== null && typeof row.dflt_value !== 'string')
  )
    failContract();
  return {
    name: row.name,
    type: row.type,
    notnull: row.notnull,
    pk: row.pk,
    defaultValue: row.dflt_value as string | null,
  };
}

function failContract(): never {
  throw new Error(`LiveBoard state migration 30 contract mismatch: ${TABLE_NAME}`);
}
