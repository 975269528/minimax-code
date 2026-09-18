import type { MigrationEntry } from '../../migrate.js';
// prettier-ignore
import { canonicalizeSqlContract, canonicalizeSqlDefault, canonicalizeSqlDefinition, extractSqlCheckContracts } from './migration-0006-frozen-sql-contract-v1.js';
// prettier-ignore
import { COMPATIBILITY_TABLES_SQL, INDEXES_SQL, PROJECT_TRIGGERS_SQL, SESSIONS_TABLE_SQL, SESSION_FTS_COLUMNS, SESSION_FTS_SQL } from './migration-0006-session-storage-ddl.js';

type Database = Parameters<Exclude<MigrationEntry['up'], string>>[0];

export const migration: MigrationEntry = {
  version: 6,
  name: 'create_session_storage',
  up: createSessionStorage,
};

/**
 * Establish only the physical contract for centralized Session storage.
 *
 * Legacy-row backfills, projection rebuilding, and JSONL publication belong to later migrations.
 * This migration only applies reversible additive DDL and does not substitute legacy owner markers
 * for physical postconditions.
 */
function createSessionStorage(database: Database): void {
  const adoptsLegacyProjects = matchesLegacyProjectSource(database);
  database.exec(SESSIONS_TABLE_SQL);
  addMissingColumns(database, 'local_runtime_sessions', SESSION_ADOPTION_COLUMNS);

  database.exec(COMPATIBILITY_TABLES_SQL);
  addMissingColumns(database, 'local_runtime_message_rows', MESSAGE_ROW_ADOPTION_COLUMNS);
  addMissingColumns(database, 'local_runtime_turn_ingress', TURN_INGRESS_ADOPTION_COLUMNS);
  addMissingColumns(database, 'local_runtime_projects', PROJECT_ADOPTION_COLUMNS);
  addMissingColumns(database, 'local_runtime_legacy_migrations', LEGACY_MIGRATION_ADOPTION_COLUMNS);

  database.exec(SESSION_FTS_SQL);
  database.exec(INDEXES_SQL);
  database.exec(PROJECT_TRIGGERS_SQL);
  assertSessionStorageContract(database, adoptsLegacyProjects);
}

interface AdoptionColumn {
  readonly name: string;
  readonly definition: string;
}

function addMissingColumns(
  database: Database,
  table: string,
  columns: readonly AdoptionColumn[],
): void {
  assertIdentifier(table);
  const existing = new Set(
    database
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .flatMap((row) => {
        if (typeof row !== 'object' || row === null || !('name' in row)) return [];
        return typeof row.name === 'string' ? [row.name] : [];
      }),
  );
  for (const column of columns) {
    assertIdentifier(column.name);
    if (!existing.has(column.name)) {
      database.exec(`ALTER TABLE "${table}" ADD COLUMN "${column.name}" ${column.definition}`);
    }
  }
}

function assertIdentifier(value: string): void {
  if (!/^[a-z0-9_]+$/iu.test(value)) throw new Error(`Invalid SQLite identifier: ${value}`);
}

type ColumnContract = readonly [
  name: string,
  type: 'INTEGER' | 'REAL' | 'TEXT',
  notNull?: boolean,
  defaultValue?: string | null,
  primaryKeyOrdinal?: number,
];

interface ForeignKeyContract {
  readonly from: string;
  readonly table: string;
  readonly to: string;
  readonly onDelete: 'cascade';
  readonly onUpdate?: 'no action';
}

interface TableContract {
  readonly name: string;
  readonly columns: readonly ColumnContract[];
  readonly checks?: readonly string[];
  readonly foreignKeys?: readonly ForeignKeyContract[];
  readonly autoIncrementColumn?: string;
  readonly optional?: boolean;
  readonly requiredUniqueColumns?: readonly (readonly string[])[];
}

interface IndexContract {
  readonly name: string;
  readonly table: string;
  readonly unique: boolean;
  // prettier-ignore
  readonly columns: readonly { readonly name: string; readonly descending: boolean; readonly collation: 'BINARY' }[];
  readonly predicate: string | null;
}

function assertSessionStorageContract(database: Database, adoptsLegacyProjects: boolean): void {
  for (const table of TABLE_CONTRACTS) {
    if (
      table.name === 'local_runtime_projects' &&
      adoptsLegacyProjects &&
      matchesTransitionalProjectContract(database)
    ) {
      continue;
    }
    assertTableContract(database, table);
  }
  assertFtsContract(database);
  for (const index of parseIndexContracts(INDEXES_SQL)) assertIndexContract(database, index);
  for (const trigger of parseTriggerContracts(PROJECT_TRIGGERS_SQL)) {
    assertSqlObjectContract(database, 'trigger', trigger.name, trigger.sql);
  }
  assertConditionalPiIndex(database);
}

function matchesLegacyProjectSource(database: Database): boolean {
  const rows = database.prepare('PRAGMA table_info("local_runtime_projects")').all();
  return matchesColumnSequence(rows, LEGACY_PROJECT_COLUMNS);
}

function matchesTransitionalProjectContract(database: Database): boolean {
  const rows = database.prepare('PRAGMA table_info("local_runtime_projects")').all();
  if (!matchesColumnSequence(rows, TRANSITIONAL_PROJECT_COLUMNS)) return false;
  const createSql = normalizeSql(readObjectSql(database, 'table', 'local_runtime_projects'));
  if (!createSql.includes(normalizeSql('project_id INTEGER PRIMARY KEY AUTOINCREMENT'))) {
    return false;
  }
  if (extractSqlCheckContracts(readObjectSql(database, 'table', 'local_runtime_projects')).length)
    return false;
  return database.prepare('PRAGMA foreign_key_list("local_runtime_projects")').all().length === 0;
}

function matchesColumnSequence(
  rows: readonly unknown[],
  columns: readonly ColumnContract[],
): boolean {
  if (rows.length !== columns.length) return false;
  return rows.every((row, index) => {
    const expected = columns[index];
    if (!expected) return false;
    try {
      return readString(row, 'name') === expected[0] && columnMatches(row, expected);
    } catch {
      return false;
    }
  });
}

function assertTableContract(database: Database, contract: TableContract): void {
  const rows = database.prepare(`PRAGMA table_info("${contract.name}")`).all();
  if (rows.length === 0 && contract.optional) return;
  if (rows.length !== contract.columns.length) failContract(contract.name);

  const actualByName = new Map(rows.map((row) => [readString(row, 'name'), row]));
  for (const expected of contract.columns) {
    const actual = actualByName.get(expected[0]);
    if (!actual || !columnMatches(actual, expected)) failContract(contract.name);
  }

  const createSql = readObjectSql(database, 'table', contract.name);
  assertTableSqlContract(contract, createSql);
  assertForeignKeys(database, contract);
  assertRequiredUniqueColumns(database, contract);
}

function columnMatches(row: unknown, contract: ColumnContract): boolean {
  const [, type, notNull = false, defaultValue = null, primaryKeyOrdinal = 0] = contract;
  return (
    readString(row, 'type').toUpperCase() === type &&
    readNumber(row, 'notnull') === Number(notNull) &&
    canonicalizeSqlDefault(readNullableString(row, 'dflt_value')) ===
      canonicalizeSqlDefault(defaultValue) &&
    readNumber(row, 'pk') === primaryKeyOrdinal
  );
}

function assertTableSqlContract(contract: TableContract, sql: string): void {
  const normalized = normalizeSql(sql);
  const actualChecks = extractSqlCheckContracts(sql);
  const expectedChecks = (contract.checks ?? []).map(normalizeSql).sort();
  if (JSON.stringify(actualChecks) !== JSON.stringify(expectedChecks)) failContract(contract.name);
  const expectedAutoIncrement = contract.autoIncrementColumn
    ? normalizeSql(`${contract.autoIncrementColumn} INTEGER PRIMARY KEY AUTOINCREMENT`)
    : null;
  if (expectedAutoIncrement && !normalized.includes(expectedAutoIncrement)) {
    failContract(contract.name);
  }
  if (!expectedAutoIncrement && normalized.includes(normalizeSql('AUTOINCREMENT')))
    failContract(contract.name);
}

function assertForeignKeys(database: Database, contract: TableContract): void {
  // prettier-ignore
  const actual = database.prepare(`PRAGMA foreign_key_list("${contract.name}")`).all().map((row) => ({
    from: readString(row, 'from'), table: readString(row, 'table'), to: readString(row, 'to'),
    onDelete: readString(row, 'on_delete').toLowerCase(), onUpdate: readString(row, 'on_update').toLowerCase(),
  })).sort(compareForeignKeys);
  // prettier-ignore
  const expected = (contract.foreignKeys ?? [])
    .map(({ onUpdate = 'no action', ...foreignKey }) => ({ ...foreignKey, onUpdate }))
    .sort(compareForeignKeys);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) failContract(contract.name);
}

// prettier-ignore
function assertFtsContract(database: Database): void {
  const columns = database.prepare('PRAGMA table_info("local_runtime_sessions_fts")').all().map((row) => readString(row, 'name'));
  assertSqlObjectContract(database, 'table', 'local_runtime_sessions_fts', SESSION_FTS_SQL);
  if (JSON.stringify(columns) !== JSON.stringify(SESSION_FTS_COLUMNS)) failContract('local_runtime_sessions_fts');
}

function compareForeignKeys(
  left: { readonly from: string; readonly table: string; readonly to: string },
  right: { readonly from: string; readonly table: string; readonly to: string },
): number {
  return `${left.from}:${left.table}:${left.to}`.localeCompare(
    `${right.from}:${right.table}:${right.to}`,
  );
}

function assertRequiredUniqueColumns(database: Database, contract: TableContract): void {
  for (const expected of contract.requiredUniqueColumns ?? []) {
    const found = database
      .prepare(`PRAGMA index_list("${contract.name}")`)
      .all()
      .filter((row) => readNumber(row, 'unique') === 1 && readNumber(row, 'partial') === 0)
      .some((row) => {
        const columns = readIndexColumns(database, readString(row, 'name'));
        return (
          columns.every(({ collation }) => collation === 'BINARY') &&
          JSON.stringify(columns.map(({ name }) => name)) === JSON.stringify(expected)
        );
      });
    if (!found) failContract(contract.name);
  }
}

function assertSqlObjectContract(
  database: Database,
  type: 'table' | 'trigger',
  name: string,
  expectedSql: string,
): void {
  const actualSql = readObjectSql(database, type, name);
  if (normalizeDefinition(actualSql) !== normalizeDefinition(expectedSql)) failContract(name);
}

function assertIndexContract(database: Database, expected: IndexContract): void {
  assertIdentifier(expected.name);
  assertIdentifier(expected.table);
  const rows = database
    .prepare(
      `SELECT tbl_name, sql FROM sqlite_master
       WHERE type = 'index' AND name = '${expected.name}'`,
    )
    .all();
  if (rows.length !== 1) failContract(expected.name);
  const row = rows[0];
  if (!row || readString(row, 'tbl_name') !== expected.table) failContract(expected.name);

  const listRow = database
    .prepare(`PRAGMA index_list("${expected.table}")`)
    .all()
    .find((candidate) => readString(candidate, 'name') === expected.name);
  if (!listRow || readNumber(listRow, 'unique') !== Number(expected.unique)) {
    failContract(expected.name);
  }

  const actualColumns = readIndexColumns(database, expected.name);
  if (JSON.stringify(actualColumns) !== JSON.stringify(expected.columns))
    failContract(expected.name);
  const actualPredicate = readPredicate(readString(row, 'sql'));
  if (actualPredicate !== expected.predicate) failContract(expected.name);
}

function readIndexColumns(
  database: Database,
  name: string,
): Array<{ readonly name: string; readonly descending: boolean; readonly collation: string }> {
  return database
    .prepare(`PRAGMA index_xinfo("${name}")`)
    .all()
    .filter((row) => readNumber(row, 'key') === 1)
    .sort((left, right) => readNumber(left, 'seqno') - readNumber(right, 'seqno'))
    .map((row) => ({
      name: readString(row, 'name'),
      descending: readNumber(row, 'desc') === 1,
      collation: readString(row, 'coll').toUpperCase(),
    }));
}

function assertConditionalPiIndex(database: Database): void {
  if (database.prepare('PRAGMA table_info("local_runtime_pi_history_rows")').all().length === 0) {
    return;
  }
  assertIndexContract(database, {
    name: 'idx_local_runtime_pi_history_rows_session_id',
    table: 'local_runtime_pi_history_rows',
    unique: false,
    columns: [
      { name: 'session_id', descending: false, collation: 'BINARY' },
      { name: 'id', descending: false, collation: 'BINARY' },
    ],
    predicate: null,
  });
}

function parseIndexContracts(sql: string): IndexContract[] {
  return Array.from(
    sql.matchAll(
      /CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+([a-z0-9_]+)\s+ON\s+([a-z0-9_]+)\s*\(([^)]*)\)\s*(?:WHERE\s+([\s\S]*?))?;/giu,
    ),
    (match) => ({
      name: requiredMatch(match, 2),
      table: requiredMatch(match, 3),
      unique: Boolean(match[1]),
      columns: requiredMatch(match, 4).split(',').map(parseIndexColumn),
      predicate: match[5] ? normalizeSql(match[5]) : null,
    }),
  );
}

// prettier-ignore
function parseIndexColumn(value: string): { readonly name: string; readonly descending: boolean; readonly collation: 'BINARY' } {
  const match = /^\s*([a-z0-9_]+)(?:\s+(ASC|DESC))?\s*$/iu.exec(value);
  if (!match) throw new Error(`Invalid frozen Session index column: ${value}`);
  return {
    name: requiredMatch(match, 1),
    descending: match[2]?.toUpperCase() === 'DESC',
    collation: 'BINARY',
  };
}

function parseTriggerContracts(
  sql: string,
): Array<{ readonly name: string; readonly sql: string }> {
  return Array.from(
    sql.matchAll(/CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\s+([a-z0-9_]+)[\s\S]*?\bEND\s*;/giu),
    (match) => ({ name: requiredMatch(match, 1), sql: requiredMatch(match, 0) }),
  );
}

function readPredicate(sql: string): string | null {
  const match = /\bWHERE\b([\s\S]+)$/iu.exec(sql);
  return match ? normalizeSql(requiredMatch(match, 1)) : null;
}

function readObjectSql(database: Database, type: 'table' | 'trigger', name: string): string {
  assertIdentifier(name);
  const rows = database
    .prepare(`SELECT sql FROM sqlite_master WHERE type = '${type}' AND name = '${name}'`)
    .all();
  if (rows.length !== 1) failContract(name);
  return readString(rows[0], 'sql');
}

function normalizeDefinition(value: string): string {
  return canonicalizeSqlDefinition(value);
}

function normalizeSql(value: string): string {
  return canonicalizeSqlContract(value);
}

function readString(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null || !(key in value)) failMetadata(key);
  const result = (value as Record<string, unknown>)[key];
  if (typeof result !== 'string') failMetadata(key);
  return result;
}

function readNullableString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || !(key in value)) failMetadata(key);
  const result = (value as Record<string, unknown>)[key];
  if (result !== null && typeof result !== 'string') failMetadata(key);
  return result;
}

function readNumber(value: unknown, key: string): number {
  if (typeof value !== 'object' || value === null || !(key in value)) failMetadata(key);
  const result = (value as Record<string, unknown>)[key];
  if (typeof result !== 'number') failMetadata(key);
  return result;
}

function requiredMatch(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new Error('Invalid frozen Session DDL contract');
  return value;
}

function failMetadata(key: string): never {
  throw new Error(`Invalid SQLite metadata field: ${key}`);
}

function failContract(name: string): never {
  throw new Error(`Session storage contract mismatch: ${name}`);
}

const PROJECT_TABLE_CONTRACT: TableContract = {
  name: 'local_runtime_projects',
  columns: [
    ['project_id', 'INTEGER', false, null, 1],
    ['project_kind', 'TEXT', true],
    ['workspace_dir', 'TEXT'],
    ['pinned', 'INTEGER', true, '0'],
    ['hidden', 'INTEGER', true, '0'],
    ['order_index', 'INTEGER', true, '2147483647'],
    ['recent_at_ms', 'INTEGER'],
    ['latest_activity_at_ms', 'INTEGER', true, '0'],
    ['session_count', 'INTEGER', true, '0'],
    ['extra_data_json', 'TEXT', true, "'{}'"],
    ['created_at_ms', 'INTEGER', true],
    ['updated_at_ms', 'INTEGER', true],
  ],
  autoIncrementColumn: 'project_id',
  checks: [
    "project_kind IN ('default', 'workspace')",
    "(project_kind = 'default' AND workspace_dir IS NULL) OR (project_kind = 'workspace' AND workspace_dir IS NOT NULL AND trim(workspace_dir) <> '')",
  ],
};

const LEGACY_PROJECT_COLUMNS = PROJECT_TABLE_CONTRACT.columns.filter(
  ([name]) => name !== 'project_kind',
);

const TRANSITIONAL_PROJECT_COLUMNS: readonly ColumnContract[] = [
  ...LEGACY_PROJECT_COLUMNS,
  ['project_kind', 'TEXT'],
] as const;

// prettier-ignore
function markerContract(name: string, completed: string, id = 'session_id'): TableContract {
  return { name, columns: [[id, 'TEXT', false, null, 1], [completed, 'INTEGER', true]] };
}

const TABLE_CONTRACTS: readonly TableContract[] = [
  {
    name: 'local_runtime_sessions',
    columns: [
      ['session_id', 'TEXT', false, null, 1],
      ['record_json', 'TEXT', true],
      ['updated_at_ms', 'INTEGER', true],
      ['columnar_version', 'INTEGER', true, '0'],
      ['agent_name', 'TEXT'],
      ['runtime', 'TEXT'],
      ['session_type', 'TEXT'],
      ['status', 'TEXT'],
      ['archived', 'INTEGER', true, '0'],
      ['visibility', 'TEXT', true, "'visible'"],
      ['session_kind', 'TEXT', true, "'unknown'"],
      ['purpose', 'TEXT'],
      ['purpose_kind', 'TEXT', true, "''"],
      ['origin_cron_id', 'TEXT'],
      ['parent_session_id', 'TEXT'],
      ['workspace_dir', 'TEXT'],
      ['project_workspace_dir', 'TEXT'],
      ['is_default_workspace', 'INTEGER', true, '0'],
      ['title', 'TEXT'],
      ['created_at_ms', 'INTEGER'],
      ['error_message', 'TEXT'],
      ['error_code', 'INTEGER'],
      ['extra_data_json', 'TEXT', true, "'{}'"],
      ['project_id', 'INTEGER'],
    ],
    checks: [
      "session_kind IN ('conversation', 'task', 'peek', 'channel', 'cron', 'unknown')",
      'is_default_workspace IN (0, 1)',
    ],
  },
  // prettier-ignore
  markerContract('local_runtime_session_schema_migrations', 'completed_at_ms', 'migration_key'),
  {
    name: 'local_runtime_session_fts_keys',
    columns: [
      ['fts_rowid', 'INTEGER', false, null, 1],
      ['session_id', 'TEXT', true],
    ],
    autoIncrementColumn: 'fts_rowid',
    foreignKeys: [
      {
        from: 'session_id',
        table: 'local_runtime_sessions',
        to: 'session_id',
        onDelete: 'cascade',
      },
    ],
  },
  {
    name: 'local_runtime_session_agent_state',
    columns: [
      ['session_id', 'TEXT', false, null, 1],
      ['turn_id', 'TEXT', true],
      ['turn_sequence', 'INTEGER', true],
      ['runtime_seq', 'INTEGER'],
      ['event_id', 'TEXT', true],
      ['terminal_outcome', 'TEXT'],
      ['updated_at_ms', 'INTEGER', true],
    ],
    foreignKeys: [
      {
        from: 'session_id',
        table: 'local_runtime_sessions',
        to: 'session_id',
        onDelete: 'cascade',
      },
    ],
  },
  PROJECT_TABLE_CONTRACT,
  // prettier-ignore
  markerContract('local_runtime_project_migrations', 'completed_at_ms', 'migration_key'),
  {
    name: 'local_runtime_messages',
    columns: [
      ['session_id', 'TEXT', false, null, 1],
      ['display_messages_json', 'TEXT', true],
      ['pi_history_json', 'TEXT', true],
    ],
  },
  {
    name: 'local_runtime_message_rows',
    columns: [
      ['id', 'INTEGER', false, null, 1],
      ['session_id', 'TEXT', true],
      ['msg_id', 'TEXT', true],
      ['role', 'TEXT'],
      ['turn_id', 'TEXT'],
      ['source', 'TEXT'],
      ['source_context_json', 'TEXT'],
      ['created_at_ms', 'INTEGER', true],
      ['data_json', 'TEXT', true],
    ],
    autoIncrementColumn: 'id',
  },
  // prettier-ignore
  markerContract('local_runtime_message_row_migrations', 'display_rows_backfilled_at_ms'),
  {
    name: 'local_runtime_session_assets',
    columns: [
      ['id', 'INTEGER', false, null, 1],
      ['session_id', 'TEXT', true],
      ['msg_id', 'TEXT', true],
      ['role', 'TEXT'],
      ['message_created_at_ms', 'INTEGER', true],
      ['asset_index', 'INTEGER', true],
      ['asset_key', 'TEXT', true],
      ['source_tag', 'TEXT', true],
      ['path', 'TEXT', true],
      ['name', 'TEXT'],
      ['asset_type', 'TEXT'],
      ['artifact_id', 'TEXT'],
      ['drive_node_id', 'TEXT'],
      ['data_json', 'TEXT', true],
      ['created_at_ms', 'INTEGER', true],
      ['updated_at_ms', 'INTEGER', true],
    ],
    autoIncrementColumn: 'id',
  },
  {
    name: 'local_runtime_session_asset_index_state',
    columns: [
      ['session_id', 'TEXT', false, null, 1],
      ['index_version', 'INTEGER', true],
      ['indexed_through_message_row_id', 'INTEGER', true],
      ['indexed_at_ms', 'INTEGER', true],
      ['status', 'TEXT', true],
      ['error_json', 'TEXT'],
    ],
  },
  {
    name: 'local_runtime_queues',
    columns: [
      ['session_id', 'TEXT', false, null, 1],
      ['items_json', 'TEXT', true],
    ],
  },
  {
    name: 'local_runtime_queue_items',
    columns: [
      ['id', 'INTEGER', false, null, 1],
      ['session_id', 'TEXT', true],
      ['item_id', 'TEXT', true],
      ['status', 'TEXT'],
      ['created_at_ms', 'INTEGER', true],
      ['data_json', 'TEXT', true],
    ],
    autoIncrementColumn: 'id',
  },
  // prettier-ignore
  markerContract('local_runtime_queue_row_migrations', 'queue_rows_backfilled_at_ms'),
  {
    name: 'local_runtime_preferences',
    columns: [
      ['key', 'TEXT', false, null, 1],
      ['value_json', 'TEXT', true],
    ],
  },
  {
    name: 'local_runtime_token_usage',
    columns: [
      ['id', 'INTEGER', false, null, 1],
      ['session_id', 'TEXT', true],
      ['agent_name', 'TEXT', true],
      ['framework_type', 'TEXT', true],
      ['turn_id', 'TEXT'],
      ['model', 'TEXT'],
      ['ts', 'INTEGER', true],
      ['input_tokens', 'INTEGER', true],
      ['output_tokens', 'INTEGER', true],
      ['reasoning_tokens', 'INTEGER', true],
      ['cache_read_tokens', 'INTEGER', true],
      ['cache_write_tokens', 'INTEGER', true],
      ['cost_usd', 'REAL'],
      ['raw', 'TEXT'],
    ],
    autoIncrementColumn: 'id',
  },
  {
    name: 'local_runtime_session_locks',
    columns: [
      ['session_id', 'TEXT', false, null, 1],
      ['owner_id', 'TEXT', true],
      ['owner_kind', 'TEXT', true],
      ['acquired_at_ms', 'INTEGER', true],
      ['expires_at_ms', 'INTEGER', true],
    ],
  },
  {
    name: 'local_runtime_turn_ingress',
    columns: [
      ['turn_id', 'TEXT', false, null, 1],
      ['session_id', 'TEXT', true],
      ['source', 'TEXT', true],
      ['client_request_id', 'TEXT'],
      ['claim_id', 'TEXT'],
      ['claim_source', 'TEXT'],
      ['queue_item_ids_json', 'TEXT'],
      ['input_json', 'TEXT', true],
      ['status', 'TEXT', true],
      ['accepted_at_ms', 'INTEGER', true],
      ['accepted_sequence', 'INTEGER'],
      ['completed_at_ms', 'INTEGER'],
      ['queue_acknowledged_at_ms', 'INTEGER'],
      ['input_digest', 'TEXT'],
      ['input_metadata_json', 'TEXT', true, "'{}'"],
    ],
    checks: ["status IN ('accepted', 'completed', 'failed', 'aborted')"],
  },
  {
    name: 'local_runtime_turn_ingress_sequences',
    columns: [
      ['sequence', 'INTEGER', false, null, 1],
      ['turn_id', 'TEXT', true],
    ],
    autoIncrementColumn: 'sequence',
  },
  {
    name: 'local_runtime_turn_ingress_client_requests',
    columns: [
      ['session_id', 'TEXT', true, null, 1],
      ['client_request_id', 'TEXT', true, null, 2],
      ['turn_id', 'TEXT', true],
      ['ordinal', 'INTEGER', true],
    ],
    foreignKeys: [
      {
        from: 'turn_id',
        table: 'local_runtime_turn_ingress',
        to: 'turn_id',
        onDelete: 'cascade',
      },
    ],
  },
  {
    name: 'local_runtime_pi_history_file_migrations',
    columns: [
      ['session_id', 'TEXT', false, null, 1],
      ['migrated_at_ms', 'INTEGER', true],
      ['source', 'TEXT', true],
      ['message_count', 'INTEGER', true],
      ['target_revision', 'TEXT', true],
    ],
  },
  {
    name: 'local_runtime_legacy_migrations',
    columns: [
      ['legacy_session_id', 'TEXT', false, null, 1],
      ['local_session_id', 'TEXT', true],
      ['legacy_daemon_session_id', 'TEXT'],
      ['legacy_framework_session_id', 'TEXT'],
      ['source_runtime', 'TEXT', true],
      ['status', 'TEXT', true],
      ['migrated_at_ms', 'INTEGER', true],
      ['source_updated_at_ms', 'INTEGER'],
      ['source_fingerprint', 'TEXT'],
      ['source_schema_fingerprint', 'TEXT'],
      ['source_checksum', 'TEXT'],
      ['display_checksum', 'TEXT'],
      ['pi_history_strategy', 'TEXT'],
      ['pi_history_converter_version', 'INTEGER'],
      ['source_manifest_json', 'TEXT'],
      ['source_message_count', 'INTEGER'],
      ['imported_message_count', 'INTEGER'],
      ['report_json', 'TEXT'],
      ['ledger_imported_at_ms', 'INTEGER'],
      ['projection_ready_at_ms', 'INTEGER'],
      ['display_ready_at_ms', 'INTEGER'],
      ['pi_history_ready_at_ms', 'INTEGER'],
      ['warnings_json', 'TEXT'],
      ['error_json', 'TEXT'],
    ],
  },
  {
    name: 'local_runtime_owner_migrations',
    columns: [
      ['owner', 'TEXT', true, null, 1],
      ['version', 'INTEGER', true, null, 2],
      ['migration_key', 'TEXT', true],
      ['completed_at_ms', 'INTEGER', true],
    ],
    optional: true,
    requiredUniqueColumns: [['owner', 'migration_key']],
  },
  {
    name: 'local_runtime_pi_history_rows',
    columns: [
      ['id', 'INTEGER', false, null, 1],
      ['session_id', 'TEXT', true],
      ['role', 'TEXT'],
      ['created_at_ms', 'INTEGER', true],
      ['data_json', 'TEXT', true],
    ],
    autoIncrementColumn: 'id',
    optional: true,
  },
  {
    name: 'local_runtime_pi_history_row_migrations',
    columns: [
      ['session_id', 'TEXT', false, null, 1],
      ['history_rows_backfilled_at_ms', 'INTEGER', true],
    ],
    optional: true,
  },
] as const;

const SESSION_ADOPTION_COLUMNS: readonly AdoptionColumn[] = [
  { name: 'columnar_version', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'agent_name', definition: 'TEXT' },
  { name: 'runtime', definition: 'TEXT' },
  { name: 'session_type', definition: 'TEXT' },
  { name: 'status', definition: 'TEXT' },
  { name: 'archived', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'visibility', definition: "TEXT NOT NULL DEFAULT 'visible'" },
  {
    name: 'session_kind',
    definition:
      "TEXT NOT NULL DEFAULT 'unknown' CHECK (session_kind IN ('conversation', 'task', 'peek', 'channel', 'cron', 'unknown'))",
  },
  { name: 'purpose', definition: 'TEXT' },
  { name: 'purpose_kind', definition: "TEXT NOT NULL DEFAULT ''" },
  { name: 'origin_cron_id', definition: 'TEXT' },
  { name: 'parent_session_id', definition: 'TEXT' },
  { name: 'workspace_dir', definition: 'TEXT' },
  { name: 'project_workspace_dir', definition: 'TEXT' },
  {
    name: 'is_default_workspace',
    definition: 'INTEGER NOT NULL DEFAULT 0 CHECK (is_default_workspace IN (0, 1))',
  },
  { name: 'title', definition: 'TEXT' },
  { name: 'created_at_ms', definition: 'INTEGER' },
  { name: 'error_message', definition: 'TEXT' },
  { name: 'error_code', definition: 'INTEGER' },
  { name: 'extra_data_json', definition: "TEXT NOT NULL DEFAULT '{}'" },
  { name: 'project_id', definition: 'INTEGER' },
] as const;

const MESSAGE_ROW_ADOPTION_COLUMNS: readonly AdoptionColumn[] = [
  { name: 'role', definition: 'TEXT' },
  { name: 'turn_id', definition: 'TEXT' },
  { name: 'source', definition: 'TEXT' },
  { name: 'source_context_json', definition: 'TEXT' },
] as const;

const TURN_INGRESS_ADOPTION_COLUMNS: readonly AdoptionColumn[] = [
  { name: 'accepted_sequence', definition: 'INTEGER' },
  { name: 'queue_acknowledged_at_ms', definition: 'INTEGER' },
  { name: 'input_digest', definition: 'TEXT' },
  { name: 'input_metadata_json', definition: "TEXT NOT NULL DEFAULT '{}'" },
] as const;

/**
 * The legacy Project table's project_kind requires a later data migration to distinguish
 * default/workspace. Leave it NULL here so m0005 does not rewrite historical Project identities.
 */
const PROJECT_ADOPTION_COLUMNS: readonly AdoptionColumn[] = [
  { name: 'project_kind', definition: 'TEXT' },
] as const;

const LEGACY_MIGRATION_ADOPTION_COLUMNS: readonly AdoptionColumn[] = [
  { name: 'legacy_daemon_session_id', definition: 'TEXT' },
  { name: 'legacy_framework_session_id', definition: 'TEXT' },
  { name: 'source_updated_at_ms', definition: 'INTEGER' },
  { name: 'source_fingerprint', definition: 'TEXT' },
  { name: 'source_schema_fingerprint', definition: 'TEXT' },
  { name: 'source_checksum', definition: 'TEXT' },
  { name: 'display_checksum', definition: 'TEXT' },
  { name: 'pi_history_strategy', definition: 'TEXT' },
  { name: 'pi_history_converter_version', definition: 'INTEGER' },
  { name: 'source_manifest_json', definition: 'TEXT' },
  { name: 'source_message_count', definition: 'INTEGER' },
  { name: 'imported_message_count', definition: 'INTEGER' },
  { name: 'report_json', definition: 'TEXT' },
  { name: 'ledger_imported_at_ms', definition: 'INTEGER' },
  { name: 'projection_ready_at_ms', definition: 'INTEGER' },
  { name: 'display_ready_at_ms', definition: 'INTEGER' },
  { name: 'pi_history_ready_at_ms', definition: 'INTEGER' },
  { name: 'warnings_json', definition: 'TEXT' },
  { name: 'error_json', definition: 'TEXT' },
] as const;
