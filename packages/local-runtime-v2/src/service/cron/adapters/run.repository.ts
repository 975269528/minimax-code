import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import type { AppDb } from '../../../infra/db/client.js';
import { cronDefinitions, cronRuns } from '../../../infra/db/schema/cron.js';
import { CronRepositoryError } from '../errors.js';
import {
  type MarkCronRunFailedInput,
  type CronRun,
  type CronRunPageQuery,
  type CronRunRepository,
  type CronRunTriggerSource,
} from '../contracts.js';
import { changes, invalid, text, timestamp } from './definition.repository.js';

export class SqliteCronRunRepository implements CronRunRepository {
  constructor(
    private readonly db: AppDb,
    private readonly generateId: () => string = randomUUID,
  ) {}

  insertPendingManualForDefinition(
    cronId: string,
    createdAtMs: number,
    requestId?: string,
  ): CronRun {
    const manualRunId = text(this.generateId(), 'runId');
    const manualRequestId = requestId === undefined ? null : text(requestId, 'requestId');
    const activeCronId = text(cronId, 'cronId');
    timestamp(createdAtMs, 'createdAtMs');
    const activeDefinition = this.db
      .select({
        runId: sql<string>`${manualRunId}`.as('run_id'),
        cronId: cronDefinitions.cronId,
        schedulerTriggerId: sql<null>`NULL`.as('scheduler_trigger_id'),
        manualRequestId: sql<string | null>`${manualRequestId}`.as('manual_request_id'),
        triggerSource: sql<'manual'>`'manual'`.as('trigger_source'),
        sessionId: sql<null>`NULL`.as('session_id'),
        status: sql<'pending'>`'pending'`.as('status'),
        createdAtMs: sql<number>`${createdAtMs}`.as('created_at_ms'),
        executionClaimedAtMs: sql<null>`NULL`.as('execution_claimed_at_ms'),
        deliveredAtMs: sql<null>`NULL`.as('delivered_at_ms'),
        failedAtMs: sql<null>`NULL`.as('failed_at_ms'),
        errorCode: sql<null>`NULL`.as('error_code'),
        error: sql<null>`NULL`.as('error'),
      })
      .from(cronDefinitions)
      .where(and(eq(cronDefinitions.cronId, activeCronId), isNull(cronDefinitions.deletedAtMs)));
    const result = this.db.insert(cronRuns).select(activeDefinition).run();
    if (changes(result) !== 1) {
      throw new CronRepositoryError('CRON_NOT_FOUND', 'Cron definition not found');
    }
    return this.require(manualRunId);
  }

  insertPendingScheduled(cronId: string, schedulerTriggerId: string, createdAtMs: number): CronRun {
    text(cronId, 'cronId');
    text(schedulerTriggerId, 'schedulerTriggerId');
    const existing = this.getBySchedulerTriggerId(schedulerTriggerId);
    if (existing) {
      if (existing.cronId !== cronId || existing.triggerSource !== 'scheduled') {
        throw new CronRepositoryError(
          'CRON_CONFLICT',
          'Scheduler trigger is bound to another Cron run',
        );
      }
      return existing;
    }
    try {
      return this.insertPending({
        runId: this.generateId(),
        cronId,
        schedulerTriggerId,
        triggerSource: 'scheduled',
        createdAtMs,
      });
    } catch (error) {
      const raced = this.getBySchedulerTriggerId(schedulerTriggerId);
      if (raced?.cronId === cronId && raced.triggerSource === 'scheduled') return raced;
      throw error;
    }
  }

  get(runId: string): CronRun | undefined {
    text(runId, 'runId');
    const row = this.db.select().from(cronRuns).where(eq(cronRuns.runId, runId)).get();
    return row ? mapRun(row) : undefined;
  }

  getByManualRequestId(requestId: string): CronRun | undefined {
    text(requestId, 'requestId');
    const row = this.db
      .select()
      .from(cronRuns)
      .where(eq(cronRuns.manualRequestId, requestId))
      .get();
    return row ? mapRun(row) : undefined;
  }

  getBySchedulerTriggerId(schedulerTriggerId: string): CronRun | undefined {
    text(schedulerTriggerId, 'schedulerTriggerId');
    const row = this.db
      .select()
      .from(cronRuns)
      .where(eq(cronRuns.schedulerTriggerId, schedulerTriggerId))
      .get();
    return row ? mapRun(row) : undefined;
  }

  listPage(query: CronRunPageQuery): CronRun[] {
    text(query.cronId, 'cronId');
    if (!Number.isSafeInteger(query.take) || query.take <= 0) invalid('take is invalid');
    const filters: SQL[] = [eq(cronRuns.cronId, query.cronId)];
    if (query.before) {
      timestamp(query.before.createdAtMs, 'before.createdAtMs');
      text(query.before.runId, 'before.runId');
      filters.push(
        or(
          lt(cronRuns.createdAtMs, query.before.createdAtMs),
          and(
            eq(cronRuns.createdAtMs, query.before.createdAtMs),
            lt(cronRuns.runId, query.before.runId),
          ),
        ) as SQL,
      );
    }
    return this.db
      .select()
      .from(cronRuns)
      .where(and(...filters))
      .orderBy(desc(cronRuns.createdAtMs), desc(cronRuns.runId))
      .limit(query.take)
      .all()
      .map(mapRun);
  }

  listPending(): CronRun[] {
    return this.db
      .select()
      .from(cronRuns)
      .where(eq(cronRuns.status, 'pending'))
      .orderBy(asc(cronRuns.createdAtMs), asc(cronRuns.runId))
      .all()
      .map(mapRun);
  }

  hasPendingForCronId(cronId: string): boolean {
    text(cronId, 'cronId');
    return (
      this.db
        .select({ present: sql<number>`1` })
        .from(cronRuns)
        .where(and(eq(cronRuns.cronId, cronId), eq(cronRuns.status, 'pending')))
        .limit(1)
        .get() !== undefined
    );
  }

  claimExecution(runId: string, claimedAtMs: number): CronRun | undefined {
    text(runId, 'runId');
    timestamp(claimedAtMs, 'claimedAtMs');
    const result = this.db
      .update(cronRuns)
      .set({ executionClaimedAtMs: claimedAtMs })
      .where(
        and(
          eq(cronRuns.runId, runId),
          eq(cronRuns.status, 'pending'),
          isNull(cronRuns.executionClaimedAtMs),
        ),
      )
      .run();
    return changes(result) === 1 ? this.require(runId) : undefined;
  }

  attachSession(runId: string, sessionId: string): boolean {
    text(runId, 'runId');
    text(sessionId, 'sessionId');
    const result = this.db
      .update(cronRuns)
      .set({ sessionId })
      .where(
        and(
          eq(cronRuns.runId, runId),
          eq(cronRuns.status, 'pending'),
          isNull(cronRuns.sessionId),
          isNotNull(cronRuns.executionClaimedAtMs),
        ),
      )
      .run();
    if (changes(result) === 1) return true;
    const current = this.get(runId);
    return (
      current?.status === 'pending' &&
      current.sessionId === sessionId &&
      current.executionClaimedAtMs !== undefined
    );
  }

  markDelivered(runId: string, deliveredAtMs: number): boolean {
    text(runId, 'runId');
    timestamp(deliveredAtMs, 'deliveredAtMs');
    const result = this.db
      .update(cronRuns)
      .set({ status: 'delivered', deliveredAtMs })
      .where(
        and(
          eq(cronRuns.runId, runId),
          eq(cronRuns.status, 'pending'),
          isNotNull(cronRuns.sessionId),
          isNotNull(cronRuns.executionClaimedAtMs),
        ),
      )
      .run();
    if (changes(result) === 1) return true;
    return sameTerminal(this.get(runId), 'delivered');
  }

  markFailed(input: MarkCronRunFailedInput): boolean {
    text(input.runId, 'runId');
    timestamp(input.failedAtMs, 'failedAtMs');
    text(input.errorCode, 'errorCode');
    const result = this.db
      .update(cronRuns)
      .set({
        status: 'failed',
        failedAtMs: input.failedAtMs,
        errorCode: input.errorCode,
        error: input.error ?? null,
      })
      .where(
        and(
          eq(cronRuns.runId, input.runId),
          eq(cronRuns.status, 'pending'),
          isNotNull(cronRuns.executionClaimedAtMs),
        ),
      )
      .run();
    if (changes(result) === 1) return true;
    return sameTerminal(this.get(input.runId), 'failed');
  }

  deleteByCronId(cronId: string): number {
    text(cronId, 'cronId');
    return changes(this.db.delete(cronRuns).where(eq(cronRuns.cronId, cronId)).run());
  }

  private insertPending(input: {
    readonly runId: string;
    readonly cronId: string;
    readonly schedulerTriggerId?: string;
    readonly requestId?: string;
    readonly triggerSource: CronRunTriggerSource;
    readonly createdAtMs: number;
  }): CronRun {
    const runId = text(input.runId, 'runId');
    const cronId = text(input.cronId, 'cronId');
    timestamp(input.createdAtMs, 'createdAtMs');
    this.db
      .insert(cronRuns)
      .values({
        runId,
        cronId,
        schedulerTriggerId: input.schedulerTriggerId ?? null,
        manualRequestId: input.requestId ?? null,
        triggerSource: input.triggerSource,
        sessionId: null,
        status: 'pending',
        createdAtMs: input.createdAtMs,
        executionClaimedAtMs: null,
        deliveredAtMs: null,
        failedAtMs: null,
        errorCode: null,
        error: null,
      })
      .run();
    return this.require(runId);
  }

  private require(runId: string): CronRun {
    const run = this.get(runId);
    if (!run) throw new CronRepositoryError('CRON_NOT_FOUND', 'Cron run not found');
    return run;
  }
}

function mapRun(value: unknown): CronRun {
  const row = value as typeof cronRuns.$inferSelect;
  const triggerSource = row.triggerSource as unknown;
  const status = row.status as unknown;
  if (triggerSource !== 'manual' && triggerSource !== 'scheduled') {
    throw new Error('Stored trigger is invalid');
  }
  if (status !== 'pending' && status !== 'delivered' && status !== 'failed') {
    throw new Error('Stored status is invalid');
  }
  return {
    runId: storedText(row.runId, 'runId'),
    cronId: storedText(row.cronId, 'cronId'),
    triggerSource,
    status,
    createdAtMs: storedTimestamp(row.createdAtMs, 'createdAtMs'),
    ...optionalRunFields(row),
  };
}

interface OptionalRunFields {
  schedulerTriggerId?: string;
  requestId?: string;
  sessionId?: string;
  executionClaimedAtMs?: number;
  deliveredAtMs?: number;
  failedAtMs?: number;
  errorCode?: string;
  error?: string;
}

function optionalRunFields(row: typeof cronRuns.$inferSelect): OptionalRunFields {
  return {
    ...optionalRunIdentityFields(row),
    ...optionalRunClaimFields(row),
    ...optionalRunTerminalFields(row),
  };
}

function optionalRunIdentityFields(row: typeof cronRuns.$inferSelect): OptionalRunFields {
  const fields: OptionalRunFields = {};
  if (row.schedulerTriggerId !== null) {
    fields.schedulerTriggerId = storedText(row.schedulerTriggerId, 'schedulerTriggerId');
  }
  if (row.manualRequestId !== null) {
    fields.requestId = storedText(row.manualRequestId, 'manualRequestId');
  }
  if (row.sessionId !== null) fields.sessionId = storedText(row.sessionId, 'sessionId');
  return fields;
}

function optionalRunClaimFields(row: typeof cronRuns.$inferSelect): OptionalRunFields {
  const fields: OptionalRunFields = {};
  if (row.executionClaimedAtMs !== null) {
    fields.executionClaimedAtMs = storedTimestamp(row.executionClaimedAtMs, 'executionClaimedAtMs');
  }
  return fields;
}

function optionalRunTerminalFields(row: typeof cronRuns.$inferSelect): OptionalRunFields {
  const fields: OptionalRunFields = {};
  if (row.deliveredAtMs !== null) {
    fields.deliveredAtMs = storedTimestamp(row.deliveredAtMs, 'deliveredAtMs');
  }
  if (row.failedAtMs !== null) {
    fields.failedAtMs = storedTimestamp(row.failedAtMs, 'failedAtMs');
  }
  if (row.errorCode !== null) fields.errorCode = storedText(row.errorCode, 'errorCode');
  if (row.error !== null) {
    if (typeof row.error !== 'string') throw new Error('Stored error is invalid');
    fields.error = row.error;
  }
  return fields;
}

function storedText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Stored ${field} is invalid`);
  }
  return value;
}

function storedTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Stored ${field} is invalid`);
  }
  return value;
}

function sameTerminal(run: CronRun | undefined, status: 'delivered' | 'failed'): boolean {
  return run?.status === status;
}
