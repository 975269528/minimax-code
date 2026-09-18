import { asc, desc, sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const sessions = sqliteTable(
  'local_runtime_sessions',
  {
    sessionId: text('session_id').primaryKey(),
    recordJson: text('record_json').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    columnarVersion: integer('columnar_version').notNull().default(0),
    agentName: text('agent_name'),
    runtime: text('runtime'),
    sessionType: text('session_type'),
    status: text('status'),
    archived: integer('archived').notNull().default(0),
    visibility: text('visibility').notNull().default('visible'),
    sessionKind: text('session_kind').notNull().default('unknown'),
    purpose: text('purpose'),
    purposeKind: text('purpose_kind').notNull().default(''),
    originCronId: text('origin_cron_id'),
    parentSessionId: text('parent_session_id'),
    workspaceDir: text('workspace_dir'),
    projectWorkspaceDir: text('project_workspace_dir'),
    isDefaultWorkspace: integer('is_default_workspace').notNull().default(0),
    title: text('title'),
    createdAtMs: integer('created_at_ms'),
    errorMessage: text('error_message'),
    errorCode: integer('error_code'),
    extraDataJson: text('extra_data_json').notNull().default('{}'),
    projectId: integer('project_id'),
    historyRelativeDir: text('history_relative_dir'),
  },
  (table) => [
    check(
      'local_runtime_sessions_session_kind_check',
      sql`${table.sessionKind} IN ('conversation', 'task', 'peek', 'channel', 'cron', 'unknown')`,
    ),
    check(
      'local_runtime_sessions_default_workspace_check',
      sql`${table.isDefaultWorkspace} IN (0, 1)`,
    ),
    index('idx_local_runtime_sessions_updated_at').on(desc(table.updatedAtMs)),
    index('idx_local_runtime_sessions_recency_v2').on(
      desc(table.updatedAtMs),
      desc(table.createdAtMs),
      asc(table.sessionId),
    ),
    index('idx_local_runtime_sessions_agent_recency_v3')
      .on(table.agentName, desc(table.updatedAtMs), desc(table.createdAtMs), asc(table.sessionId))
      .where(sql`${table.columnarVersion} = 3`),
    index('idx_local_runtime_sessions_agent_archive_recency_v3')
      .on(
        table.agentName,
        table.archived,
        desc(table.updatedAtMs),
        desc(table.createdAtMs),
        asc(table.sessionId),
      )
      .where(sql`${table.columnarVersion} = 3`),
    index('idx_local_runtime_sessions_root_recency_v3')
      .on(table.agentName, desc(table.updatedAtMs), desc(table.createdAtMs), asc(table.sessionId))
      .where(sql`${table.columnarVersion} = 3 AND ${table.parentSessionId} IS NULL`),
    index('idx_local_runtime_sessions_root_archive_recency_v3')
      .on(
        table.agentName,
        table.archived,
        desc(table.updatedAtMs),
        desc(table.createdAtMs),
        asc(table.sessionId),
      )
      .where(sql`${table.columnarVersion} = 3 AND ${table.parentSessionId} IS NULL`),
    index('idx_local_runtime_sessions_parent_recency_v3')
      .on(
        table.parentSessionId,
        desc(table.updatedAtMs),
        desc(table.createdAtMs),
        asc(table.sessionId),
      )
      .where(sql`${table.columnarVersion} = 3`),
    index('idx_local_runtime_sessions_cron_origin_created_v3')
      .on(table.originCronId, desc(table.createdAtMs), asc(table.sessionId))
      .where(sql`${table.columnarVersion} = 3 AND ${table.originCronId} IS NOT NULL`),
    index('idx_local_runtime_sessions_pi_stale_v3')
      .on(asc(table.updatedAtMs), asc(table.sessionId))
      .where(
        sql`${table.columnarVersion} = 3 AND ${table.runtime} = 'pi-agent' AND ${table.status} = 'started'`,
      ),
    index('idx_local_runtime_sessions_project_activity_v4')
      .on(table.projectId, desc(table.updatedAtMs))
      .where(
        sql`${table.columnarVersion} = 3 AND ${table.archived} = 0 AND ${table.visibility} <> 'hidden' AND ${table.sessionKind} NOT IN ('peek', 'channel', 'cron')`,
      ),
    index('idx_local_runtime_sessions_project_root_recency_v4')
      .on(
        table.projectId,
        table.archived,
        desc(table.updatedAtMs),
        desc(table.createdAtMs),
        asc(table.sessionId),
      )
      .where(
        sql`${table.columnarVersion} = 3 AND ${table.parentSessionId} IS NULL AND ${table.visibility} <> 'hidden' AND ${table.sessionKind} NOT IN ('peek', 'channel', 'cron')`,
      ),
    index('idx_local_runtime_sessions_project_agent_root_recency_v4')
      .on(
        table.projectId,
        table.agentName,
        table.archived,
        desc(table.updatedAtMs),
        desc(table.createdAtMs),
        asc(table.sessionId),
      )
      .where(
        sql`${table.columnarVersion} = 3 AND ${table.parentSessionId} IS NULL AND ${table.visibility} <> 'hidden' AND ${table.sessionKind} NOT IN ('peek', 'channel', 'cron')`,
      ),
    index('idx_local_runtime_sessions_project_activity_v6')
      .on(table.projectId, desc(table.updatedAtMs))
      .where(
        sql`${table.columnarVersion} = 3 AND ${table.archived} = 0 AND ${table.visibility} <> 'hidden' AND ${table.sessionKind} NOT IN ('peek', 'cron')`,
      ),
    index('idx_local_runtime_sessions_project_root_recency_v6')
      .on(
        table.projectId,
        table.archived,
        desc(table.updatedAtMs),
        desc(table.createdAtMs),
        asc(table.sessionId),
      )
      .where(
        sql`${table.columnarVersion} = 3 AND ${table.parentSessionId} IS NULL AND ${table.visibility} <> 'hidden' AND ${table.sessionKind} NOT IN ('peek', 'cron')`,
      ),
    index('idx_local_runtime_sessions_project_agent_root_recency_v6')
      .on(
        table.projectId,
        table.agentName,
        table.archived,
        desc(table.updatedAtMs),
        desc(table.createdAtMs),
        asc(table.sessionId),
      )
      .where(
        sql`${table.columnarVersion} = 3 AND ${table.parentSessionId} IS NULL AND ${table.visibility} <> 'hidden' AND ${table.sessionKind} NOT IN ('peek', 'cron')`,
      ),
  ],
);

export const sessionSchemaMigrations = sqliteTable('local_runtime_session_schema_migrations', {
  migrationKey: text('migration_key').primaryKey(),
  completedAtMs: integer('completed_at_ms').notNull(),
});

export const sessionFtsKeys = sqliteTable(
  'local_runtime_session_fts_keys',
  {
    ftsRowId: integer('fts_rowid').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
  },
  (table) => [uniqueIndex('local_runtime_session_fts_keys_session_id').on(table.sessionId)],
);

export const sessionAgentState = sqliteTable('local_runtime_session_agent_state', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.sessionId, { onDelete: 'cascade' }),
  turnId: text('turn_id').notNull(),
  turnSequence: integer('turn_sequence').notNull(),
  runtimeSeq: integer('runtime_seq'),
  eventId: text('event_id').notNull(),
  terminalOutcome: text('terminal_outcome'),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

/**
 * V1 compatibility mirror for Task-only binaries. New code reads the generic
 * definition table below; Task creation writes a downlevel copy here so an
 * upgraded data directory can still be opened by the immediately previous
 * Desktop binary during rollback.
 */
export const taskSessionBindings = sqliteTable(
  'local_runtime_task_session_bindings',
  {
    sessionId: text('session_id')
      .primaryKey()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    definitionJson: text('definition_json').notNull(),
  },
  (table) => [
    check(
      'local_runtime_task_session_bindings_definition_check',
      sql`length(trim(${table.definitionJson})) > 0`,
    ),
  ],
);

/** One immutable Agent execution snapshot for every local-runtime Session. */
export const sessionAgentDefinitions = sqliteTable(
  'local_runtime_session_agent_definitions',
  {
    sessionId: text('session_id')
      .primaryKey()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    definitionJson: text('definition_json').notNull(),
  },
  (table) => [
    check(
      'local_runtime_session_agent_definitions_definition_check',
      sql`length(trim(${table.definitionJson})) > 0`,
    ),
  ],
);

export const SESSION_FTS_TABLE = 'local_runtime_sessions_fts' as const;

export const SESSION_FTS_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS local_runtime_sessions_fts USING fts5(
    session_id UNINDEXED,
    session_id_terms,
    agent_name_terms,
    title_terms,
    workspace_dir_terms,
    purpose_terms,
    status_terms,
    session_type_terms,
    tokenize = 'unicode61'
  );
`;
