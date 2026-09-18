import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export type SchedulerJobSchedule =
  | {
      readonly kind: 'cron';
      readonly expression: string;
      readonly timezone?: string;
      readonly maxRuns?: number;
    }
  | {
      readonly kind: 'once';
      readonly runAtMs: number;
    };

export type SchedulerJobState = 'active' | 'completed' | 'expired' | 'cancelled';

export const schedulerJobs = sqliteTable(
  'local_runtime_v2_scheduler_jobs',
  {
    schedulerId: text('scheduler_id').primaryKey(),
    handlerKey: text('handler_key').notNull(),
    scheduleJson: text('schedule_json', { mode: 'json' }).$type<SchedulerJobSchedule>().notNull(),
    runCount: integer('run_count').notNull().default(0),
    state: text('state', {
      enum: ['active', 'completed', 'expired', 'cancelled'],
    }).notNull(),
    nextRunAtMs: integer('next_run_at_ms'),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    scheduleGeneration: integer('schedule_generation').notNull().default(0),
  },
  (table) => [
    check(
      'local_runtime_v2_scheduler_job_identity',
      sql`length(trim(${table.schedulerId})) > 0 AND length(trim(${table.handlerKey})) > 0 AND json_valid(${table.scheduleJson})`,
    ),
    check(
      'local_runtime_v2_scheduler_job_state',
      sql`${table.state} IN ('active', 'completed', 'expired', 'cancelled')`,
    ),
    check('local_runtime_v2_scheduler_job_count', sql`${table.runCount} >= 0`),
    check('local_runtime_v2_scheduler_job_generation', sql`${table.scheduleGeneration} >= 0`),
    check(
      'local_runtime_v2_scheduler_job_next_run',
      sql`(${table.state} = 'active' AND ${table.nextRunAtMs} IS NOT NULL)
        OR (${table.state} IN ('completed', 'expired', 'cancelled') AND ${table.nextRunAtMs} IS NULL)`,
    ),
    check(
      'local_runtime_v2_scheduler_job_timestamps',
      sql`${table.createdAtMs} >= 0 AND ${table.updatedAtMs} >= 0`,
    ),
  ],
);
