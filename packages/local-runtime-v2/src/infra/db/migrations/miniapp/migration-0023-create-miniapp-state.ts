import type { MigrationEntry } from '../../migrate.js';

type Database = Parameters<Exclude<MigrationEntry['up'], string>>[0];

const TABLE_NAME = 'local_runtime_liveboard_state';

const MINIAPP_STATE_SQL = `
  CREATE TABLE IF NOT EXISTS local_runtime_liveboard_state (
    plugin_id              TEXT PRIMARY KEY NOT NULL,
    accepted_source_digest TEXT NOT NULL,
    client_digest          TEXT NOT NULL,
    node_digest            TEXT NOT NULL,
    preferred_port         INTEGER,
    last_error_json        TEXT,
    updated_at_ms          INTEGER NOT NULL,
    CONSTRAINT local_runtime_liveboard_state_identity CHECK (
      length(trim(plugin_id)) > 0
      AND length(trim(accepted_source_digest)) > 0
      AND length(trim(client_digest)) > 0
      AND length(trim(node_digest)) > 0
    ),
    CONSTRAINT local_runtime_liveboard_state_port CHECK (
      preferred_port IS NULL
      OR (node_digest IS NOT NULL AND preferred_port BETWEEN 1024 AND 65535)
    ),
    CONSTRAINT local_runtime_liveboard_state_updated_at CHECK (
      updated_at_ms >= 0
    ),
    CONSTRAINT local_runtime_liveboard_state_error CHECK (
      last_error_json IS NULL OR json_valid(last_error_json)
    )
  );
`;

type ColumnContract = readonly [
  name: string,
  type: 'INTEGER' | 'TEXT',
  notNull: boolean,
  primaryKeyOrdinal?: number,
];

const COLUMN_CONTRACTS: readonly ColumnContract[] = [
  ['plugin_id', 'TEXT', true, 1],
  ['accepted_source_digest', 'TEXT', true],
  ['client_digest', 'TEXT', true],
  ['node_digest', 'TEXT', true],
  ['preferred_port', 'INTEGER', false],
  ['last_error_json', 'TEXT', false],
  ['updated_at_ms', 'INTEGER', true],
];

const CHECK_CONTRACTS = [
  `length(trim(plugin_id)) > 0
    AND length(trim(accepted_source_digest)) > 0
    AND length(trim(client_digest)) > 0
    AND length(trim(node_digest)) > 0`,
  `preferred_port IS NULL
    OR (node_digest IS NOT NULL AND preferred_port BETWEEN 1024 AND 65535)`,
  'updated_at_ms >= 0',
  'last_error_json IS NULL OR json_valid(last_error_json)',
] as const;

const PRIMARY_KEY_INDEX = {
  name: `sqlite_autoindex_${TABLE_NAME}_1`,
  columns: [{ name: 'plugin_id', descending: false, collation: 'BINARY' }],
} as const;

/**
 * Creates the only MiniApp schema at m0023. CREATE IF NOT EXISTS preserves
 * compatible tables found beside a foreign m0019 marker; exact validation then
 * fails closed for tables that cannot be proven to satisfy the durable contract.
 */
export const migration: MigrationEntry = {
  version: 23,
  name: 'create_liveboard_state',
  up: createMiniAppState,
};

function createMiniAppState(database: Database): void {
  database.exec(MINIAPP_STATE_SQL);
  assertMiniAppStateContract(database);
}

function assertMiniAppStateContract(database: Database): void {
  const rows = database.prepare(`PRAGMA table_xinfo("${TABLE_NAME}")`).all();
  if (rows.length !== COLUMN_CONTRACTS.length) failContract();

  for (const [index, expected] of COLUMN_CONTRACTS.entries()) {
    const row = rows[index];
    if (!columnMatches(row, expected)) failContract(expected[0]);
  }

  const createSql = readString(
    database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .all(TABLE_NAME)[0],
    'sql',
  );
  const actualChecks = extractCheckContracts(createSql).map(normalizeSql).sort();
  const expectedChecks = CHECK_CONTRACTS.map(normalizeSql).sort();
  if (JSON.stringify(actualChecks) !== JSON.stringify(expectedChecks)) failContract();
  if (database.prepare(`PRAGMA foreign_key_list("${TABLE_NAME}")`).all().length !== 0) {
    failContract();
  }
  assertIndexContract(database);
}

function assertIndexContract(database: Database): void {
  const indexes = database.prepare(`PRAGMA index_list("${TABLE_NAME}")`).all();
  if (indexes.length !== 1) failContract();
  const index = indexes[0];
  if (
    readString(index, 'name') !== PRIMARY_KEY_INDEX.name ||
    readNumber(index, 'unique') !== 1 ||
    readString(index, 'origin') !== 'pk' ||
    readNumber(index, 'partial') !== 0
  ) {
    failContract();
  }
  const columns = database
    .prepare(`PRAGMA index_xinfo("${PRIMARY_KEY_INDEX.name}")`)
    .all()
    .filter((row) => readNumber(row, 'key') === 1)
    .sort((left, right) => readNumber(left, 'seqno') - readNumber(right, 'seqno'))
    .map((row) => ({
      name: readString(row, 'name'),
      descending: readNumber(row, 'desc') === 1,
      collation: readString(row, 'coll').toUpperCase(),
    }));
  if (JSON.stringify(columns) !== JSON.stringify(PRIMARY_KEY_INDEX.columns)) failContract();
}

function columnMatches(row: unknown, expected: ColumnContract): boolean {
  return [
    readString(row, 'name') === expected[0],
    readString(row, 'type').toUpperCase() === expected[1],
    readNumber(row, 'notnull') === Number(expected[2]),
    readNullableString(row, 'dflt_value') === null,
    readNumber(row, 'pk') === (expected[3] ?? 0),
    readNumber(row, 'hidden') === 0,
  ].every(Boolean);
}

function extractCheckContracts(sql: string): string[] {
  const contracts: string[] = [];
  const pattern = /\bCHECK\s*\(/giu;
  for (const match of sql.matchAll(pattern)) {
    const opening = (match.index ?? 0) + match[0].lastIndexOf('(');
    const closing = findClosingParenthesis(sql, opening);
    if (closing >= 0) contracts.push(sql.slice(opening + 1, closing));
  }
  return contracts;
}

function findClosingParenthesis(sql: string, opening: number): number {
  let depth = 0;
  for (let index = opening; index < sql.length; index += 1) {
    const character = sql[index];
    const quotedEnd = findQuotedEnd(sql, index);
    if (quotedEnd !== index) {
      index = quotedEnd;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

const QUOTE_CLOSINGS: Readonly<Record<string, string>> = {
  "'": "'",
  '"': '"',
  '`': '`',
  '[': ']',
};

function findQuotedEnd(sql: string, opening: number): number {
  const closing = QUOTE_CLOSINGS[sql[opening] ?? ''];
  if (!closing) return opening;
  for (let index = opening + 1; index < sql.length; index += 1) {
    if (sql[index] !== closing) continue;
    if (closing !== ']' && sql[index + 1] === closing) {
      index += 1;
      continue;
    }
    return index;
  }
  return sql.length - 1;
}

function normalizeSql(value: string): string {
  return value.replaceAll('"', '').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function readString(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null || !(key in value)) failContract();
  const result = (value as Record<string, unknown>)[key];
  if (typeof result !== 'string') failContract();
  return result;
}

function readNumber(value: unknown, key: string): number {
  if (typeof value !== 'object' || value === null || !(key in value)) failContract();
  const result = (value as Record<string, unknown>)[key];
  if (typeof result !== 'number') failContract();
  return result;
}

function readNullableString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || !(key in value)) failContract();
  const result = (value as Record<string, unknown>)[key];
  if (result !== null && typeof result !== 'string') failContract();
  return result;
}

function failContract(column?: string): never {
  throw new Error(
    `Mini App state migration 23 contract mismatch: ${TABLE_NAME}${column ? `.${column}` : ''}`,
  );
}
