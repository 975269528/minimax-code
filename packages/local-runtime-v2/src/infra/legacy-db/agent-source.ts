import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { logger } from '../logging/index.js';
import { loadSqlite3Constructor } from '../db/client.js';

const AGENT_COLUMNS = [
  'agent_name',
  'agent_role',
  'framework_type',
  'pid',
  'port',
  'process_alive',
  'last_active_at',
  'config_synced_hash',
  'opencode_config_hash',
  'main_session_id',
  'source_project',
  'harness_source_type',
  'creation_source',
  'enc_display_name',
  'enc_description',
  'enc_avatar',
  'greeting_sent',
  'star_timestamp',
  'pinned',
  'pinned_at',
  'spawned_by_data_dir',
  'created_at',
  'updated_at',
] as const;

const KNOWN_AGENT_INDEXES = new Set(['idx_agents_source_project', 'idx_agents_process_state']);

const AGENT_COLUMN_AFFINITIES: Readonly<Record<LegacyAgentColumn, SqliteAffinity>> = {
  agent_name: 'TEXT',
  agent_role: 'INTEGER',
  framework_type: 'TEXT',
  pid: 'INTEGER',
  port: 'INTEGER',
  process_alive: 'INTEGER',
  last_active_at: 'INTEGER',
  config_synced_hash: 'TEXT',
  opencode_config_hash: 'TEXT',
  main_session_id: 'TEXT',
  source_project: 'TEXT',
  harness_source_type: 'TEXT',
  creation_source: 'TEXT',
  enc_display_name: 'TEXT',
  enc_description: 'TEXT',
  enc_avatar: 'TEXT',
  greeting_sent: 'INTEGER',
  star_timestamp: 'INTEGER',
  pinned: 'INTEGER',
  pinned_at: 'INTEGER',
  spawned_by_data_dir: 'TEXT',
  created_at: 'INTEGER',
  updated_at: 'INTEGER',
};

const AGENT_INDEX_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  idx_agents_source_project: ['source_project'],
  idx_agents_process_state: ['framework_type', 'process_alive'],
};

type SqliteAffinity = 'INTEGER' | 'TEXT' | 'BLOB' | 'REAL' | 'NUMERIC';

type LegacyAgentColumn = (typeof AGENT_COLUMNS)[number];

type LegacyAgentTimestampColumn =
  | 'last_active_at'
  | 'star_timestamp'
  | 'pinned_at'
  | 'created_at'
  | 'updated_at';

const LEGACY_TEXT_AGENT_TIMESTAMP_COLUMNS = new Set<LegacyAgentTimestampColumn>([
  'last_active_at',
  'star_timestamp',
  'pinned_at',
  'created_at',
  'updated_at',
]);

export interface LegacyAgentRow {
  readonly agent_name: unknown;
  readonly agent_role: unknown;
  readonly framework_type: unknown;
  readonly pid: unknown;
  readonly port: unknown;
  readonly process_alive: unknown;
  readonly last_active_at: number | null;
  readonly config_synced_hash: unknown;
  readonly opencode_config_hash: unknown;
  readonly main_session_id: unknown;
  readonly source_project: unknown;
  readonly harness_source_type: unknown;
  readonly creation_source: unknown;
  readonly enc_display_name: unknown;
  readonly enc_description: unknown;
  readonly enc_avatar: unknown;
  readonly greeting_sent: unknown;
  readonly star_timestamp: number | null;
  readonly pinned: unknown;
  readonly pinned_at: number | null;
  readonly spawned_by_data_dir: unknown;
  readonly created_at: number;
  readonly updated_at: number;
}

/**
 * The fingerprint form exposed in place of the raw legacy `agent_name`.  The
 * shape is `sha256:<first-16-hex>` of the raw value so the same source row
 * maps to a stable, irreversible identifier across the reader, the migration
 * metadata, the structured event, and the logger payload.  Downstream code
 * can use the fingerprint to cross-reference recovered timestamp metadata
 * without ever needing the original string.
 */
type LegacyAgentNameFingerprint = `sha256:${string}`;

function fingerprintLegacyAgentName(raw: string): LegacyAgentNameFingerprint {
  return `sha256:${createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16)}`;
}

type LegacyAgentTimestampRecoveryReason = 'malformed' | 'binary' | 'nonfinite' | 'empty';

type LegacyAgentTimestampFallback = 'null' | 'zero';

export interface LegacyAgentTimestampRecovery {
  /** Stable one-way identity for diagnostics; never the raw Agent name. */
  readonly agentNameFingerprint: LegacyAgentNameFingerprint;
  readonly field: LegacyAgentTimestampColumn;
  readonly reason: LegacyAgentTimestampRecoveryReason;
  readonly fallback: LegacyAgentTimestampFallback;
}

/**
 * Thrown only for a recognized legacy timestamp value failure.  The row
 * normalizer catches this error around that single field, records bounded
 * recovery metadata, and applies the same fallback used by NULL/missing
 * values.  Schema and unknown errors never use this class and still fail
 * closed.
 *
 * The error deliberately does NOT carry the original timestamp or Agent name.
 */
class LegacyAgentInvalidTimestampError extends Error {
  readonly field: LegacyAgentTimestampColumn;
  readonly reason: LegacyAgentTimestampRecoveryReason;
  constructor(field: LegacyAgentTimestampColumn, reason: LegacyAgentTimestampRecoveryReason) {
    super(`Legacy Agent source has invalid timestamp: ${field}`);
    this.name = 'LegacyAgentInvalidTimestampError';
    this.field = field;
    this.reason = reason;
  }
}

type LegacyAgentSourceResult =
  | { readonly status: 'missing' | 'table-missing'; readonly rows: readonly [] }
  | {
      readonly status: 'ready';
      readonly rows: readonly LegacyAgentRow[];
      readonly recoveries: readonly LegacyAgentTimestampRecovery[];
    };

/** Read-only source for the one-time Agent copy; never initializes or writes the legacy DB. */
export interface LegacyAgentSource {
  readAgents(): LegacyAgentSourceResult;
}

export function createLegacyAgentSource(sourceDataDir: string): LegacyAgentSource {
  return new SqliteLegacyAgentSource(sourceDataDir);
}

class SqliteLegacyAgentSource implements LegacyAgentSource {
  private readonly path: string;

  constructor(sourceDataDir: string) {
    this.path = join(sourceDataDir, 'sqlite.db');
  }

  readAgents(): LegacyAgentSourceResult {
    if (!existsSync(this.path)) return { status: 'missing', rows: [] };
    const Database = loadSqlite3Constructor();
    const db = new Database(this.path, { readonly: true, fileMustExist: true });
    try {
      const tableInfo = db.prepare('PRAGMA table_info(agents)').all();
      const columns = new Set(
        tableInfo.flatMap((row) => {
          const name = readString(row, 'name');
          return name ? [name] : [];
        }),
      );
      if (columns.size === 0) return { status: 'table-missing', rows: [] };
      const unknownColumns = [...columns].filter(
        (column) => !(AGENT_COLUMNS as readonly string[]).includes(column),
      );
      if (unknownColumns.length > 0) {
        throw new Error(
          `Legacy Agent source has unsupported columns: ${unknownColumns.sort().join(',')}`,
        );
      }
      assertAgentColumns(tableInfo);
      assertKnownIndexes(db);
      const selected = AGENT_COLUMNS.filter((column) => columns.has(column));
      // Every recognized source row remains importable.  Only timestamp value
      // errors receive deterministic field fallbacks inside normalizeRow;
      // schema validation and unknown exceptions above/below still throw.
      const rawRows = db
        .prepare(
          `SELECT ${selected.map(quoteIdentifier).join(', ')}
           FROM agents ORDER BY agent_name ASC`,
        )
        .all() as readonly Record<string, unknown>[];
      const rows: LegacyAgentRow[] = [];
      const recoveries: LegacyAgentTimestampRecovery[] = [];
      for (const raw of rawRows) {
        const normalized = normalizeRow(raw, columns);
        rows.push(normalized.row);
        recoveries.push(...normalized.recoveries);
      }
      if (recoveries.length > 0) logTimestampRecoveries(rows.length, recoveries);
      return { status: 'ready', rows, recoveries };
    } finally {
      db.close();
    }
  }
}

function assertKnownIndexes(db: {
  prepare(sql: string): { all(...values: unknown[]): unknown[] };
}): void {
  const indexes = db.prepare('PRAGMA index_list(agents)').all();
  for (const row of indexes) {
    const name = readString(row, 'name');
    if (!name) throw new Error('Legacy Agent source has malformed index metadata');
    if (name.startsWith('sqlite_autoindex_agents_')) {
      if (readString(row, 'origin') !== 'pk') {
        throw new Error(`Legacy Agent source has unsupported indexes: ${name}`);
      }
      assertIndexDefinition(db, row, name, {
        columns: ['agent_name'],
        unique: 1,
        origin: 'pk',
        partial: 0,
      });
      continue;
    }
    if (!KNOWN_AGENT_INDEXES.has(name)) {
      throw new Error(`Legacy Agent source has unsupported indexes: ${name}`);
    }
    const expectedColumns = AGENT_INDEX_COLUMNS[name];
    if (!expectedColumns) {
      throw new Error(`Legacy Agent source has unsupported indexes: ${name}`);
    }
    assertIndexDefinition(db, row, name, {
      columns: expectedColumns,
      unique: 0,
      origin: 'c',
      partial: 0,
    });
  }
}

function assertAgentColumns(rows: readonly unknown[]): void {
  const primaryKeys = rows.filter((row) => readInteger(row, 'pk') > 0);
  const agentName = rows.find((row) => readString(row, 'name') === 'agent_name');
  if (!agentName || readInteger(agentName, 'pk') !== 1 || primaryKeys.length !== 1) {
    throw new Error('Legacy Agent source has unsupported primary key: expected agents(agent_name)');
  }
  for (const row of rows) {
    const name = readString(row, 'name');
    if (!name || !(AGENT_COLUMNS as readonly string[]).includes(name)) continue;
    const column = name as LegacyAgentColumn;
    assertAgentColumnAffinity(row, column);
    if (name !== 'agent_name' && readInteger(row, 'pk') > 0) {
      throw new Error(
        'Legacy Agent source has unsupported primary key: expected agents(agent_name)',
      );
    }
  }
}

function assertAgentColumnAffinity(row: unknown, column: LegacyAgentColumn): void {
  const expected = AGENT_COLUMN_AFFINITIES[column];
  const declaredType = readString(row, 'type');
  const actual = sqliteAffinity(declaredType);
  if (actual !== expected && !isLegacyTextAgentTimestampColumn(column, declaredType)) {
    throw new Error(
      `Legacy Agent source has unsupported column affinity: ${column} expected ${expected} got ${actual}`,
    );
  }
}

function isLegacyTextAgentTimestampColumn(
  column: LegacyAgentColumn,
  declaredType: string | undefined,
): boolean {
  return isLegacyAgentTimestampColumn(column) && declaredType?.trim().toUpperCase() === 'TEXT';
}

function isLegacyAgentTimestampColumn(
  column: LegacyAgentColumn,
): column is LegacyAgentTimestampColumn {
  return LEGACY_TEXT_AGENT_TIMESTAMP_COLUMNS.has(column as LegacyAgentTimestampColumn);
}

function assertIndexDefinition(
  db: { prepare(sql: string): { all(...values: unknown[]): unknown[] } },
  row: unknown,
  name: string,
  expected: {
    readonly columns: readonly string[];
    readonly unique: number;
    readonly origin: string;
    readonly partial: number;
  },
): void {
  const actualUnique = readInteger(row, 'unique');
  const actualOrigin = readString(row, 'origin');
  const actualPartial = readInteger(row, 'partial');
  if (
    actualUnique !== expected.unique ||
    actualOrigin !== expected.origin ||
    actualPartial !== expected.partial
  ) {
    throw new Error(`Legacy Agent source has unsupported index definition: ${name}`);
  }
  const columnIds = new Map(
    db
      .prepare('PRAGMA table_info(agents)')
      .all()
      .flatMap((candidate) => {
        const column = readString(candidate, 'name');
        const cid = readInteger(candidate, 'cid');
        return column && cid >= 0 ? [[column, cid] as const] : [];
      }),
  );
  const expectedColumnsWithIds = expected.columns.map((column, seqno) => ({
    seqno,
    cid: columnIds.get(column) ?? -1,
    name: column,
  }));
  const indexInfo = readIndexInfoColumns(db, name);
  const indexXInfo = readIndexXInfoColumns(db, name);
  if (JSON.stringify(indexInfo) !== JSON.stringify(expectedColumnsWithIds)) {
    throw new Error(`Legacy Agent source has unsupported index columns: ${name}`);
  }
  if (
    indexXInfo.length !== expectedColumnsWithIds.length ||
    indexXInfo.some(
      (column, index) =>
        column.seqno !== expectedColumnsWithIds[index]?.seqno ||
        column.cid !== expectedColumnsWithIds[index]?.cid ||
        column.name !== expectedColumnsWithIds[index]?.name ||
        column.desc !== 0 ||
        column.coll !== 'BINARY' ||
        column.key !== 1,
    )
  ) {
    throw new Error(`Legacy Agent source has unsupported index columns: ${name}`);
  }
}

function readIndexInfoColumns(
  db: { prepare(sql: string): { all(...values: unknown[]): unknown[] } },
  name: string,
): Array<{ readonly seqno: number; readonly cid: number; readonly name: string }> {
  const rows = db
    .prepare(`PRAGMA index_info(${quoteIdentifier(name)})`)
    .all()
    .sort((left, right) => readInteger(left, 'seqno') - readInteger(right, 'seqno'));
  return rows.map((row) => {
    const column = readString(row, 'name');
    if (!column) throw new Error(`Legacy Agent source has unsupported index columns: ${name}`);
    return {
      seqno: readInteger(row, 'seqno'),
      cid: readInteger(row, 'cid'),
      name: column,
    };
  });
}

function readIndexXInfoColumns(
  db: { prepare(sql: string): { all(...values: unknown[]): unknown[] } },
  name: string,
): Array<{
  readonly seqno: number;
  readonly cid: number;
  readonly name: string;
  readonly desc: number;
  readonly coll: string | undefined;
  readonly key: number;
}> {
  const rows = db
    .prepare(`PRAGMA index_xinfo(${quoteIdentifier(name)})`)
    .all()
    .filter((row) => readInteger(row, 'key') === 1)
    .sort((left, right) => readInteger(left, 'seqno') - readInteger(right, 'seqno'));
  return rows.map((row) => {
    const column = readString(row, 'name');
    if (!column) throw new Error(`Legacy Agent source has unsupported index columns: ${name}`);
    return {
      seqno: readInteger(row, 'seqno'),
      cid: readInteger(row, 'cid'),
      name: column,
      desc: readInteger(row, 'desc'),
      coll: readString(row, 'coll'),
      key: readInteger(row, 'key'),
    };
  });
}

function sqliteAffinity(declaredType: string | undefined): SqliteAffinity {
  const type = declaredType?.trim().toUpperCase() ?? '';
  const matched = [
    { affinity: 'INTEGER' as const, pattern: /INT/ },
    { affinity: 'TEXT' as const, pattern: /CHAR|CLOB|TEXT/ },
    { affinity: 'BLOB' as const, pattern: /BLOB/ },
    { affinity: 'REAL' as const, pattern: /REAL|FLOA|DOUB/ },
  ].find((rule) => rule.pattern.test(type));
  return matched?.affinity ?? (type.length === 0 ? 'BLOB' : 'NUMERIC');
}

type NormalizedLegacyAgentRow = {
  readonly row: LegacyAgentRow;
  readonly recoveries: readonly LegacyAgentTimestampRecovery[];
};

function normalizeRow(
  row: Record<string, unknown>,
  columns: ReadonlySet<string>,
): NormalizedLegacyAgentRow {
  const value = (column: LegacyAgentColumn): unknown => {
    if (!columns.has(column)) return missingDefault(column);
    const raw = readValue(row, column);
    return raw === null || raw === undefined ? nullableDefault(column) : raw;
  };
  const normalized: Record<string, unknown> = {};
  const recoveries: LegacyAgentTimestampRecovery[] = [];
  for (const column of AGENT_COLUMNS) {
    const raw = value(column);
    if (!isLegacyAgentTimestampColumn(column)) {
      normalized[column] = raw;
      continue;
    }
    try {
      normalized[column] = normalizeLegacyAgentTimestamp(column, raw);
    } catch (error) {
      if (!(error instanceof LegacyAgentInvalidTimestampError)) throw error;
      // Timestamp fields are non-authoritative metadata.  Recover exactly the
      // failed field using its established NULL/missing fallback so the Agent
      // identity and all other row data are preserved.
      const fallback = timestampFallback(column);
      normalized[column] = fallback.value;
      recoveries.push({
        agentNameFingerprint: fingerprintAgentNameForRecovery(row),
        field: error.field,
        reason: error.reason,
        fallback: fallback.kind,
      });
    }
  }
  return { row: Object.assign({} as LegacyAgentRow, normalized), recoveries };
}

type RequiredLegacyAgentTimestampColumn = 'created_at' | 'updated_at';

function normalizeLegacyAgentTimestamp(
  column: RequiredLegacyAgentTimestampColumn,
  value: unknown,
): number;
function normalizeLegacyAgentTimestamp(
  column: Exclude<LegacyAgentTimestampColumn, RequiredLegacyAgentTimestampColumn>,
  value: unknown,
): number | null;
function normalizeLegacyAgentTimestamp(
  column: LegacyAgentTimestampColumn,
  value: unknown,
): number | null;
function normalizeLegacyAgentTimestamp(
  column: LegacyAgentTimestampColumn,
  value: unknown,
): number | null {
  if (value === null) return nullableLegacyAgentTimestampDefault(column);
  if (typeof value === 'string' && value.trim().length === 0) {
    return invalidLegacyAgentTimestamp(column, 'empty');
  }
  // BLOB values arrive as Uint8Array/Buffer from better-sqlite3.  They are
  // recognized value contamination and receive the field's normal fallback.
  if (value instanceof Uint8Array) {
    return invalidLegacyAgentTimestamp(column, 'binary');
  }
  const parsed = parseLegacyAgentTimestampValue(value);
  if (parsed !== undefined) return parsed;
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return invalidLegacyAgentTimestamp(column, 'nonfinite');
  }
  return invalidLegacyAgentTimestamp(column, 'malformed');
}

function parseLegacyAgentTimestampValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = /^-?\d+$/u.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nullableLegacyAgentTimestampDefault(column: LegacyAgentTimestampColumn): number | null {
  return isRequiredLegacyAgentTimestampColumn(column) ? 0 : null;
}

function isRequiredLegacyAgentTimestampColumn(
  column: LegacyAgentTimestampColumn,
): column is RequiredLegacyAgentTimestampColumn {
  return column === 'created_at' || column === 'updated_at';
}

function invalidLegacyAgentTimestamp(
  column: LegacyAgentTimestampColumn,
  reason: LegacyAgentTimestampRecoveryReason,
): never {
  throw new LegacyAgentInvalidTimestampError(column, reason);
}

function timestampFallback(column: LegacyAgentTimestampColumn): {
  readonly kind: LegacyAgentTimestampFallback;
  readonly value: number | null;
} {
  return isRequiredLegacyAgentTimestampColumn(column)
    ? { kind: 'zero', value: 0 }
    : { kind: 'null', value: null };
}

function fingerprintAgentNameForRecovery(raw: Record<string, unknown>): LegacyAgentNameFingerprint {
  // `agent_name` is validated as a TEXT PRIMARY KEY before rows are read.
  // Hashing happens only in memory; raw identity never enters metadata/logs.
  const candidate = raw['agent_name'];
  return fingerprintLegacyAgentName(
    typeof candidate === 'string' && candidate.length > 0 ? candidate : '<unknown-agent>',
  );
}

function logTimestampRecoveries(
  sourceRowCount: number,
  recoveries: readonly LegacyAgentTimestampRecovery[],
): void {
  // One aggregate event avoids duplicate per-field/import/composition warnings.
  // Entries contain only a fingerprint and fixed enums; no raw source values.
  logger.warn(
    {
      event: 'legacy_agent_timestamp_metadata_recovered',
      source_row_count: sourceRowCount,
      recovered_timestamp_count: recoveries.length,
      recoveries,
    },
    'Legacy Agent source recovered invalid timestamp metadata',
  );
}

function nullableDefault(column: LegacyAgentColumn): unknown {
  switch (column) {
    case 'agent_role':
      return 0;
    case 'framework_type':
      return 'pi-agent';
    case 'process_alive':
      return 0;
    case 'harness_source_type':
      return '';
    case 'creation_source':
      return 'manual';
    case 'greeting_sent':
      return 0;
    case 'created_at':
    case 'updated_at':
      return 0;
    default:
      return null;
  }
}

function missingDefault(column: LegacyAgentColumn): unknown {
  switch (column) {
    case 'agent_role':
      return 0;
    case 'framework_type':
      return 'pi-agent';
    case 'process_alive':
    case 'pinned':
      return 0;
    case 'harness_source_type':
      return '';
    case 'creation_source':
      return 'manual';
    case 'greeting_sent':
      // Existing rows predate this column and were already greeted.
      return 1;
    case 'created_at':
    case 'updated_at':
      return 0;
    default:
      return null;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function readValue(row: unknown, key: string): unknown {
  return isObject(row) ? row[key] : undefined;
}

function readString(row: unknown, key: string): string | undefined {
  const value = readValue(row, key);
  return typeof value === 'string' ? value : undefined;
}

function readInteger(row: unknown, key: string): number {
  const value = readValue(row, key);
  return typeof value === 'number' && Number.isInteger(value) ? value : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
