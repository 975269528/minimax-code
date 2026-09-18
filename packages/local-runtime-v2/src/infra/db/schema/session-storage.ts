import { getTableConfig, SQLiteSyncDialect, type AnySQLiteTable } from 'drizzle-orm/sqlite-core';

import {
  fileHistoryMigrations,
  legacyMigrations,
  legacyOwnerMigrations,
  legacyPiHistoryRowMigrations,
  legacyPiHistoryRows,
} from './legacy-session.js';
import {
  legacyMessages,
  messageRowMigrations,
  messageRows,
  sessionAssetIndexState,
  sessionAssets,
} from './messages.js';
import { preferences } from './preferences.js';
import {
  PROJECT_V5_TRIGGERS,
  PROJECT_V5_TRIGGERS_SQL,
  projectMigrations,
  projects,
} from './projects.js';
import {
  legacyQueues,
  queueItems,
  queueMigrationQuarantine,
  queuePauses,
  queueRowMigrations,
} from './queue.js';
import {
  SESSION_FTS_SQL,
  SESSION_FTS_TABLE,
  sessionAgentState,
  sessionAgentDefinitions,
  taskSessionBindings,
  sessionFtsKeys,
  sessionSchemaMigrations,
  sessions,
} from './sessions.js';
import {
  sessionLocks,
  turnIngress,
  turnIngressClientRequests,
  turnIngressSequences,
} from './turn.js';
import { tokenUsage } from './usage.js';
import { canonicalizeSqlExpression } from '../sql-contract.js';
import { fileApiUploads } from './file-api.js';
import { queryCollapseViewStates } from './query-collapse.js';
import { sessionResources, sessionTurnResources } from './session-resources.js';

/**
 * Centralized Session storage metadata. Categories describe current read/write responsibilities
 * without creating a second migration registry.
 */
export const SESSION_STORAGE_SCHEMA = {
  active: [
    sessions,
    sessionFtsKeys,
    sessionAgentState,
    sessionAgentDefinitions,
    taskSessionBindings,
    projects,
    messageRows,
    sessionAssets,
    sessionAssetIndexState,
    queueItems,
    queuePauses,
    tokenUsage,
    sessionLocks,
    turnIngress,
    turnIngressSequences,
    turnIngressClientRequests,
    fileApiUploads,
    queryCollapseViewStates,
    sessionResources,
    sessionTurnResources,
    preferences,
  ],
  migrationAudit: [fileHistoryMigrations, legacyMigrations, queueMigrationQuarantine],
  legacyRead: [
    legacyMessages,
    legacyQueues,
    sessionSchemaMigrations,
    messageRowMigrations,
    queueRowMigrations,
    projectMigrations,
  ],
  legacyDiagnostic: [legacyOwnerMigrations],
  conditionalLegacyInput: [legacyPiHistoryRows, legacyPiHistoryRowMigrations],
} as const;

export const SESSION_STORAGE_RAW_OBJECTS = {
  virtualTables: [SESSION_FTS_TABLE],
  triggers: PROJECT_V5_TRIGGERS,
  externalTables: [
    'local_runtime_schema_migrations',
    'local_runtime_v2_data_layout_migrations',
    'local_runtime_ledger_watermarks',
    'local_runtime_session_projection_watermarks',
    'local_runtime_agents',
  ],
} as const;

export const SESSION_STORAGE_VIRTUAL_TABLE_METADATA = [
  {
    name: SESSION_FTS_TABLE,
    sql: SESSION_FTS_SQL,
    columns: [
      'session_id',
      'session_id_terms',
      'agent_name_terms',
      'title_terms',
      'workspace_dir_terms',
      'purpose_terms',
      'status_terms',
      'session_type_terms',
    ],
    tokenizer: 'unicode61',
  },
] as const;

export const SESSION_STORAGE_TRIGGER_METADATA = Array.from(
  PROJECT_V5_TRIGGERS_SQL.matchAll(
    /CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\s+([a-z0-9_]+)[\s\S]*?\bEND\s*;/giu,
  ),
  (match) => ({
    name: requireMatch(match, 1),
    sql: requireMatch(match, 0),
  }),
);

const dialect = new SQLiteSyncDialect();

/** Stable metadata for production consumers such as schema-consistency, without leaking Drizzle dependencies. */
export const SESSION_STORAGE_TABLE_METADATA = {
  required: [
    ...SESSION_STORAGE_SCHEMA.active,
    ...SESSION_STORAGE_SCHEMA.migrationAudit,
    ...SESSION_STORAGE_SCHEMA.legacyRead,
  ].map(tableMetadata),
  optionalDiagnostic: SESSION_STORAGE_SCHEMA.legacyDiagnostic.map(tableMetadata),
  conditionalLegacyInput: SESSION_STORAGE_SCHEMA.conditionalLegacyInput.map(tableMetadata),
} as const;

const finalProjectMetadata = tableMetadata(projects);
export const SESSION_STORAGE_TRANSITIONAL_TABLE_METADATA = [
  {
    ...finalProjectMetadata,
    columns: [
      'project_id',
      'workspace_dir',
      'pinned',
      'hidden',
      'order_index',
      'recent_at_ms',
      'latest_activity_at_ms',
      'session_count',
      'extra_data_json',
      'created_at_ms',
      'updated_at_ms',
      'project_kind',
    ],
    columnDefinitions: [
      ...finalProjectMetadata.columnDefinitions.filter(({ name }) => name !== 'project_kind'),
      {
        ...requireColumn(finalProjectMetadata.columnDefinitions, 'project_kind'),
        notNull: false,
      },
    ],
    checks: [],
  },
] as const;

function tableMetadata(table: AnySQLiteTable): {
  readonly name: string;
  readonly columns: readonly string[];
  readonly columnDefinitions: readonly {
    readonly name: string;
    readonly type: string;
    readonly notNull: boolean;
    readonly defaultValue: string | null;
    readonly primaryKeyOrdinal: number;
    readonly autoIncrement: boolean;
  }[];
  readonly indexes: readonly string[];
  readonly indexDefinitions: readonly {
    readonly name: string;
    readonly table: string;
    readonly unique: boolean;
    readonly columns: readonly string[];
    readonly collations: readonly string[];
    readonly where: string | null;
  }[];
  readonly checks: readonly string[];
  readonly foreignKeys: readonly {
    readonly from: string;
    readonly table: string;
    readonly to: string;
    readonly onDelete: string;
    readonly onUpdate: string;
  }[];
} {
  const config = getTableConfig(table);
  const compositePrimaryKey = config.primaryKeys[0]?.columns ?? [];
  return {
    name: config.name,
    columns: config.columns.map((column) => column.name),
    columnDefinitions: config.columns.map((column) => ({
      name: column.name,
      type: column.getSQLType().toUpperCase(),
      notNull: column.primary ? false : column.notNull,
      defaultValue: sqliteDefault(column.default),
      primaryKeyOrdinal: column.primary ? 1 : Math.max(0, compositePrimaryKey.indexOf(column) + 1),
      autoIncrement: 'autoIncrement' in column && column.autoIncrement === true,
    })),
    indexes: config.indexes.map((index) => index.config.name),
    indexDefinitions: config.indexes.map((index) => ({
      name: index.config.name,
      table: config.name,
      unique: index.config.unique,
      columns: index.config.columns.map((column) =>
        normalizeIndexColumnSql(dialect.sqlToQuery(column.getSQL(), 'indexes').sql, config.name),
      ),
      collations: index.config.columns.map(() => 'BINARY'),
      where: index.config.where
        ? canonicalizeSqlExpression(
            dialect.sqlToQuery(index.config.where, 'indexes').sql,
            config.name,
          )
        : null,
    })),
    checks: config.checks.map((constraint) =>
      normalizeConstraintSql(dialect.sqlToQuery(constraint.value, 'indexes').sql, config.name),
    ),
    foreignKeys: config.foreignKeys.flatMap((foreignKey) => {
      const reference = foreignKey.reference();
      const foreignTable = getTableConfig(reference.foreignTable).name;
      return reference.columns.map((column, index) => ({
        from: column.name,
        table: foreignTable,
        to: requireColumn(reference.foreignColumns, index).name,
        onDelete: foreignKey.onDelete ?? 'no action',
        onUpdate: foreignKey.onUpdate ?? 'no action',
      }));
    }),
  };
}

function normalizeConstraintSql(value: string, table: string): string {
  return value
    .replaceAll('"', '')
    .replace(new RegExp(`\\b${table}\\.`, 'giu'), '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

function normalizeIndexColumnSql(value: string, table: string): string {
  return normalizeConstraintSql(value, table).replace(/\s+asc$/u, '');
}

function sqliteDefault(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  throw new Error('Unsupported Session storage SQLite default');
}

function requireMatch(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new Error('Invalid centralized Project trigger metadata');
  return value;
}

function requireColumn<T>(columns: readonly T[], key: number | string): T {
  const value =
    typeof key === 'number'
      ? columns[key]
      : columns.find(
          (column) =>
            typeof column === 'object' &&
            column !== null &&
            'name' in column &&
            column.name === key,
        );
  if (!value) throw new Error(`Session storage column metadata missing: ${key}`);
  return value;
}
