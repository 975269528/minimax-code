import { randomUUID } from 'node:crypto';

import { and, desc, eq, isNull, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm';

import type { AppDb } from '../../../infra/db/client.js';
import { cronDefinitions } from '../../../infra/db/schema/cron.js';
import { CronRepositoryError } from '../errors.js';
import {
  type CronDefinitionPatch,
  type CronDefinitionPageQuery,
  type CronDefinitionRecord,
  type CronDefinitionRepository,
  type CronSessionTarget,
  type NewCronDefinitionRecord,
} from '../contracts.js';

export class SqliteCronDefinitionRepository implements CronDefinitionRepository {
  constructor(
    private readonly db: AppDb,
    private readonly generateId: () => string = randomUUID,
  ) {}

  insert(input: NewCronDefinitionRecord): CronDefinitionRecord {
    const cronId = text(input.cronId ?? this.generateId(), 'cronId');
    const schedulerId = text(input.schedulerId, 'schedulerId');
    const agentName = text(input.agentName, 'agentName');
    const name = text(input.name, 'name');
    const prompt = text(input.prompt, 'prompt');
    const storedTarget = toStoredSessionTarget(input.sessionTarget);
    timestamp(input.createdAtMs, 'createdAtMs');
    try {
      this.db
        .insert(cronDefinitions)
        .values({
          cronId,
          schedulerId,
          agentName,
          name,
          prompt,
          sessionTargetMode: storedTarget.mode,
          targetSessionId: storedTarget.sessionId,
          project: optionalText(input.project),
          model: optionalText(input.model),
          revision: 0,
          deletedAtMs: null,
          createdAtMs: input.createdAtMs,
          updatedAtMs: input.createdAtMs,
        })
        .run();
    } catch (error) {
      if (sqliteConstraint(error)) {
        throw new CronRepositoryError('CRON_CONFLICT', 'Cron definition identity already exists');
      }
      throw error;
    }
    return this.require(cronId);
  }

  get(cronId: string, includeDeleted = false): CronDefinitionRecord | undefined {
    text(cronId, 'cronId');
    const row = this.db
      .select()
      .from(cronDefinitions)
      .where(
        includeDeleted
          ? eq(cronDefinitions.cronId, cronId)
          : and(eq(cronDefinitions.cronId, cronId), isNull(cronDefinitions.deletedAtMs)),
      )
      .get();
    return row ? mapDefinition(row) : undefined;
  }

  getBySchedulerId(schedulerId: string, includeDeleted = false): CronDefinitionRecord | undefined {
    text(schedulerId, 'schedulerId');
    const row = this.db
      .select()
      .from(cronDefinitions)
      .where(
        includeDeleted
          ? eq(cronDefinitions.schedulerId, schedulerId)
          : and(eq(cronDefinitions.schedulerId, schedulerId), isNull(cronDefinitions.deletedAtMs)),
      )
      .get();
    return row ? mapDefinition(row) : undefined;
  }

  listPage(query: CronDefinitionPageQuery): CronDefinitionRecord[] {
    if (!Number.isSafeInteger(query.take) || query.take <= 0) invalid('take is invalid');
    const filters: SQL[] = [];
    if (!query.includeDeleted) filters.push(isNull(cronDefinitions.deletedAtMs));
    if (query.agentName !== undefined) {
      filters.push(eq(cronDefinitions.agentName, text(query.agentName, 'agentName')));
    }
    if (query.before) {
      timestamp(query.before.createdAtMs, 'before.createdAtMs');
      text(query.before.cronId, 'before.cronId');
      filters.push(
        or(
          lt(cronDefinitions.createdAtMs, query.before.createdAtMs),
          and(
            eq(cronDefinitions.createdAtMs, query.before.createdAtMs),
            lt(cronDefinitions.cronId, query.before.cronId),
          ),
        ) as SQL,
      );
    }
    return this.db
      .select()
      .from(cronDefinitions)
      .where(and(...filters))
      .orderBy(desc(cronDefinitions.createdAtMs), desc(cronDefinitions.cronId))
      .limit(query.take)
      .all()
      .map(mapDefinition);
  }

  update(
    cronId: string,
    expectedRevision: number,
    patch: CronDefinitionPatch,
    nowMs: number,
  ): CronDefinitionRecord {
    const current = this.requireExpected(cronId, expectedRevision);
    timestamp(nowMs, 'nowMs');
    if (isEmptyDefinitionPatch(patch)) return current;
    let result: unknown;
    try {
      result = this.db
        .update(cronDefinitions)
        .set(definitionUpdateValues(current, patch, nowMs))
        .where(
          and(
            eq(cronDefinitions.cronId, cronId),
            eq(cronDefinitions.revision, expectedRevision),
            isNull(cronDefinitions.deletedAtMs),
          ),
        )
        .run();
    } catch (error) {
      throwDefinitionWriteError(error);
    }
    this.assertChanged(result, cronId, expectedRevision);
    return this.require(cronId);
  }

  bindPendingTargetSession(cronId: string, sessionId: string, nowMs: number): CronDefinitionRecord {
    const activeCronId = text(cronId, 'cronId');
    const targetSessionId = text(sessionId, 'sessionId');
    timestamp(nowMs, 'nowMs');
    const result = this.db
      .update(cronDefinitions)
      .set({
        targetSessionId,
        revision: sql`${cronDefinitions.revision} + 1`,
        updatedAtMs: nowMs,
      })
      .where(
        and(
          eq(cronDefinitions.cronId, activeCronId),
          eq(cronDefinitions.sessionTargetMode, 'sessionId'),
          isNull(cronDefinitions.targetSessionId),
          isNull(cronDefinitions.deletedAtMs),
        ),
      )
      .run();
    if (changes(result) === 1) return this.require(activeCronId);
    const current = this.get(activeCronId);
    if (!current) throw new CronRepositoryError('CRON_NOT_FOUND', 'Cron definition not found');
    if (current.sessionTarget.mode === 'sessionId' && current.sessionTarget.sessionId) return current;
    throw new CronRepositoryError('CRON_INVALID_STATE', 'Cron session target is not pending');
  }

  tombstone(cronId: string, expectedRevision: number, nowMs: number): CronDefinitionRecord {
    this.requireExpected(cronId, expectedRevision);
    timestamp(nowMs, 'nowMs');
    const result = this.db
      .update(cronDefinitions)
      .set({
        deletedAtMs: nowMs,
        revision: sql`${cronDefinitions.revision} + 1`,
        updatedAtMs: nowMs,
      })
      .where(
        and(
          eq(cronDefinitions.cronId, cronId),
          eq(cronDefinitions.revision, expectedRevision),
          isNull(cronDefinitions.deletedAtMs),
        ),
      )
      .run();
    this.assertChanged(result, cronId, expectedRevision);
    return this.require(cronId, true);
  }

  hardDelete(cronId: string): boolean {
    text(cronId, 'cronId');
    return (
      changes(this.db.delete(cronDefinitions).where(eq(cronDefinitions.cronId, cronId)).run()) === 1
    );
  }

  private require(cronId: string, includeDeleted = false): CronDefinitionRecord {
    const value = this.get(cronId, includeDeleted);
    if (!value) throw new CronRepositoryError('CRON_NOT_FOUND', 'Cron definition not found');
    return value;
  }

  private requireExpected(cronId: string, revision: number): CronDefinitionRecord {
    if (!Number.isSafeInteger(revision) || revision < 0) invalid('expectedRevision is invalid');
    const current = this.require(cronId);
    if (current.revision !== revision) {
      throw new CronRepositoryError('CRON_REVISION_CONFLICT', 'Cron definition revision changed');
    }
    return current;
  }

  private assertChanged(result: unknown, cronId: string, revision: number): void {
    if (changes(result) === 1) return;
    const current = this.get(cronId, true);
    if (!current) throw new CronRepositoryError('CRON_NOT_FOUND', 'Cron definition not found');
    if (current.revision !== revision) {
      throw new CronRepositoryError('CRON_REVISION_CONFLICT', 'Cron definition revision changed');
    }
    throw new CronRepositoryError('CRON_INVALID_STATE', 'Cron definition state changed');
  }
}

function isEmptyDefinitionPatch(patch: CronDefinitionPatch): boolean {
  return (
    patch.name === undefined &&
    patch.prompt === undefined &&
    patch.sessionTarget === undefined &&
    patch.model === undefined &&
    patch.project === undefined
  );
}

function definitionUpdateValues(
  current: CronDefinitionRecord,
  patch: CronDefinitionPatch,
  nowMs: number,
) {
  const storedTarget = resolveStoredSessionTarget(current, patch);
  return {
    name: patch.name === undefined ? current.name : text(patch.name, 'name'),
    prompt: patch.prompt === undefined ? current.prompt : text(patch.prompt, 'prompt'),
    sessionTargetMode: storedTarget.mode,
    targetSessionId: storedTarget.sessionId,
    model: patch.model === undefined ? current.model : optionalText(patch.model),
    project: patch.project === undefined ? current.project : optionalText(patch.project),
    revision: sql`${cronDefinitions.revision} + 1`,
    updatedAtMs: nowMs,
  };
}

function throwDefinitionWriteError(error: unknown): never {
  if (sqliteConstraint(error)) {
    throw new CronRepositoryError('CRON_CONFLICT', 'Cron definition identity already exists');
  }
  throw error;
}

function resolveStoredSessionTarget(
  current: CronDefinitionRecord,
  patch: CronDefinitionPatch,
): StoredSessionTarget {
  if (patch.sessionTarget === undefined) return toStoredSessionTarget(current.sessionTarget);
  return toStoredSessionTarget(patch.sessionTarget);
}

interface StoredSessionTarget {
  readonly mode: 'new' | 'sessionId';
  readonly sessionId: string | null;
}

function toStoredSessionTarget(target: CronSessionTarget): StoredSessionTarget {
  if (target.mode === 'new') return { mode: 'new', sessionId: null };
  return {
    mode: 'sessionId',
    sessionId:
      target.sessionId === undefined ? null : text(target.sessionId, 'sessionTarget.sessionId'),
  };
}

function mapDefinition(value: unknown): CronDefinitionRecord {
  const row = value as typeof cronDefinitions.$inferSelect;
  return {
    cronId: row.cronId,
    schedulerId: row.schedulerId,
    agentName: row.agentName,
    name: row.name,
    prompt: row.prompt,
    sessionTarget: mapStoredSessionTarget(row.sessionTargetMode, row.targetSessionId),
    project: row.project,
    model: row.model,
    revision: row.revision,
    ...(row.deletedAtMs === null ? {} : { deletedAtMs: row.deletedAtMs }),
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function mapStoredSessionTarget(
  storedMode: unknown,
  targetSessionId: string | null,
): CronSessionTarget {
  // A concrete id wins so databases touched by older runtimes remain readable.
  if (targetSessionId !== null) {
    return { mode: 'sessionId', sessionId: text(targetSessionId, 'targetSessionId') };
  }
  if (storedMode === 'new') return { mode: 'new' };
  if (storedMode === 'sessionId') return { mode: 'sessionId' };
  throw new Error('Stored sessionTargetMode is invalid');
}

function optionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  return value.trim();
}

export function text(value: string, field: string): string {
  if (value.trim().length === 0) invalid(`${field} must be non-empty`);
  return value;
}

export function timestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    invalid(`${field} must be a Unix millisecond integer`);
}

export function invalid(message: string): never {
  throw new CronRepositoryError('CRON_INVALID', message);
}

export function changes(value: unknown): number {
  return typeof value === 'object' && value !== null && 'changes' in value
    ? Number((value as { changes: unknown }).changes)
    : 0;
}

function sqliteConstraint(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  );
}

/** Existing targets include paused definitions; deleted definitions no longer classify a session. */
export function listCronTargetSessionIds(db: AppDb): string[] {
  return db
    .select({ id: cronDefinitions.targetSessionId })
    .from(cronDefinitions)
    .where(and(isNull(cronDefinitions.deletedAtMs), isNotNull(cronDefinitions.targetSessionId)))
    .all()
    .map((row) => row.id!);
}
