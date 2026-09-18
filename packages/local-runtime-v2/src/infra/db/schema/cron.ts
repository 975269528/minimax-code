import { desc, sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const cronDefinitions = sqliteTable(
  'local_runtime_v2_cron_definitions',
  {
    cronId: text('cron_id').primaryKey(),
    schedulerId: text('scheduler_id').notNull(),
    agentName: text('agent_name').notNull(),
    name: text('name').notNull(),
    prompt: text('prompt').notNull(),
    targetSessionId: text('target_session_id'),
    revision: integer('revision').notNull().default(0),
    deletedAtMs: integer('deleted_at_ms'),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    project: text('project'),
    model: text('model'),
    // Mode remains explicit so a fixed target can stay unbound until its first run.
    sessionTargetMode: text('session_target_mode', { enum: ['new', 'sessionId'] })
      .notNull()
      .default('new'),
  },
  (table) => [
    uniqueIndex('idx_v2_cron_definitions_scheduler').on(table.schedulerId),
    uniqueIndex('idx_v2_cron_definitions_active_name')
      .on(table.agentName, table.name)
      .where(sql`${table.deletedAtMs} IS NULL`),
    index('idx_v2_cron_definitions_page').on(
      table.agentName,
      desc(table.createdAtMs),
      desc(table.cronId),
    ),
    check(
      'local_runtime_v2_cron_definition_identity',
      sql`length(trim(${table.cronId})) > 0 AND length(trim(${table.schedulerId})) > 0`,
    ),
    check(
      'local_runtime_v2_cron_definition_text',
      sql`length(trim(${table.agentName})) > 0 AND length(trim(${table.name})) > 0 AND length(trim(${table.prompt})) > 0`,
    ),
    check(
      'local_runtime_v2_cron_definition_target',
      sql`${table.sessionTargetMode} IN ('new', 'sessionId')
        AND (${table.targetSessionId} IS NULL OR length(trim(${table.targetSessionId})) > 0)`,
    ),
    check('local_runtime_v2_cron_definition_revision', sql`${table.revision} >= 0`),
  ],
);

export const cronRuns = sqliteTable(
  'local_runtime_v2_cron_runs',
  {
    runId: text('run_id').primaryKey(),
    cronId: text('cron_id')
      .notNull()
      .references(() => cronDefinitions.cronId, { onDelete: 'restrict' }),
    schedulerTriggerId: text('scheduler_trigger_id'),
    manualRequestId: text('manual_request_id'),
    triggerSource: text('trigger_source', { enum: ['manual', 'scheduled'] }).notNull(),
    sessionId: text('session_id'),
    status: text('status', { enum: ['pending', 'delivered', 'failed'] }).notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    executionClaimedAtMs: integer('execution_claimed_at_ms'),
    deliveredAtMs: integer('delivered_at_ms'),
    failedAtMs: integer('failed_at_ms'),
    errorCode: text('error_code'),
    error: text('error'),
  },
  (table) => [
    uniqueIndex('idx_v2_cron_runs_scheduler_trigger')
      .on(table.schedulerTriggerId)
      .where(sql`${table.schedulerTriggerId} IS NOT NULL`),
    uniqueIndex('idx_v2_cron_runs_manual_request')
      .on(table.manualRequestId)
      .where(sql`${table.manualRequestId} IS NOT NULL`),
    index('idx_v2_cron_runs_page').on(table.cronId, desc(table.createdAtMs), desc(table.runId)),
    check(
      'local_runtime_v2_cron_run_trigger',
      sql`(${table.triggerSource} = 'manual' AND ${table.schedulerTriggerId} IS NULL)
        OR (${table.triggerSource} = 'scheduled' AND ${table.schedulerTriggerId} IS NOT NULL AND length(trim(${table.schedulerTriggerId})) > 0)`,
    ),
    check(
      'local_runtime_v2_cron_run_request',
      sql`${table.manualRequestId} IS NULL OR (${table.triggerSource} = 'manual' AND length(trim(${table.manualRequestId})) > 0)`,
    ),
    check(
      'local_runtime_v2_cron_run_status',
      sql`${table.status} IN ('pending', 'delivered', 'failed')`,
    ),
    check(
      'local_runtime_v2_cron_run_session',
      sql`${table.sessionId} IS NULL OR length(trim(${table.sessionId})) > 0`,
    ),
    check(
      'local_runtime_v2_cron_run_claim',
      sql`(${table.executionClaimedAtMs} IS NULL AND ${table.status} = 'pending' AND ${table.sessionId} IS NULL)
        OR (${table.executionClaimedAtMs} IS NOT NULL AND ${table.executionClaimedAtMs} >= 0)`,
    ),
    check(
      'local_runtime_v2_cron_run_terminal',
      sql`(${table.status} = 'pending' AND ${table.deliveredAtMs} IS NULL AND ${table.failedAtMs} IS NULL AND ${table.errorCode} IS NULL AND ${table.error} IS NULL)
        OR (${table.status} = 'delivered' AND ${table.sessionId} IS NOT NULL AND ${table.deliveredAtMs} IS NOT NULL AND ${table.failedAtMs} IS NULL AND ${table.errorCode} IS NULL AND ${table.error} IS NULL)
        OR (${table.status} = 'failed' AND ${table.deliveredAtMs} IS NULL AND ${table.failedAtMs} IS NOT NULL AND ${table.errorCode} IS NOT NULL AND length(trim(${table.errorCode})) > 0)`,
    ),
  ],
);
