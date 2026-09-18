import { decodeCronModel, encodeCronModel } from '@mavis/shared/cron-model';
import type {
  CreateCronDefinitionCommand,
  CronDefinitionView,
  CronManualTriggerMetricContext,
  CronMetricTask,
  CronMetrics,
  CronModelSelectionPort,
  CronMutationMetricContext,
  CronPage,
  CronRunView,
  CronRunViewStatus,
  CronRunViewTriggerSource,
  CronService,
  CronDefinitionRecord,
  CronDefinitionRepository,
  CronRun,
  CronRunRepository,
  CronSessionCreationPort,
  DeleteCronDefinitionCommand,
  ListCronDefinitionsQuery,
  ListCronRunsQuery,
  UpdateCronDefinitionCommand,
} from '../contracts.js';
import type { ScheduledJob, SchedulerClient } from '../../../infra/scheduler/index.js';
import { CronRepositoryError } from '../errors.js';
import type { CronExecutor } from './executor.js';
import type { CronDataLifecycle } from './lifecycle.js';
import { toCronSchedule } from './schedule.js';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

async function settleBestEffort(operation: () => Promise<unknown> | undefined): Promise<void> {
  try {
    await operation();
  } catch {
    // A detached reconciliation must never alter the already-committed Cron result.
  }
}

export interface CronServiceDependencies {
  readonly lifecycle: CronDataLifecycle;
  readonly scheduler: SchedulerClient;
  readonly definitions: CronDefinitionRepository;
  readonly runs: CronRunRepository;
  readonly executor: Pick<CronExecutor, 'prepareManual'>;
  readonly sessionCreation: CronSessionCreationPort;
  readonly nowMs: () => number;
  readonly metrics: CronMetrics;
  readonly modelSelection: CronModelSelectionPort;
}

/**
 * Public Cron business implementation. Composes data lifecycle, repositories, and generic Scheduler
 * capabilities, exposing only stable contracts without CAS details.
 */
export function createCronService(deps: CronServiceDependencies): CronService {
  return new SchedulerBackedCronService(deps);
}

class SchedulerBackedCronService implements CronService {
  private readonly detachedReconciliations: Promise<void>[] = [];

  constructor(private readonly deps: CronServiceDependencies) {}

  listDefinitions(query: ListCronDefinitionsQuery): CronPage<CronDefinitionView> {
    const limit = clampLimit(query.limit);
    const cursor = decodeDefinitionCursor(query.cursor, query);
    const rows = this.queryDefinitionPage(query, cursor, limit + 1);
    const page = paginate(rows, limit, (row) => encodeDefinitionCursor(row, query));
    const items = page.items.map((definition) => this.toDefinitionView(definition));
    return {
      items,
      hasMore: page.hasMore,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  getDefinition(cronId: string): CronDefinitionView | undefined {
    const definition = this.deps.definitions.get(cronId, true);
    if (!definition) return undefined;
    return this.toDefinitionView(definition);
  }

  async createDefinition(
    command: CreateCronDefinitionCommand,
    context: CronMutationMetricContext = { mutationSource: 'http_api' },
  ): Promise<CronDefinitionView> {
    const nowMs = this.deps.nowMs();
    const model = resolveDefinitionModel(command.model, this.deps.modelSelection);
    const created = this.deps.lifecycle.create({
      agentName: command.agentName,
      name: command.name,
      prompt: command.prompt,
      schedule: command.schedule,
      active: command.enabled ?? true,
      sessionTarget: command.sessionTarget,
      project: command.project,
      model,
      nowMs,
    });
    if (created.sessionTarget.mode === 'sessionId' && created.sessionTarget.sessionId) {
      this.trackDetached(syncSingleSessionTitle(this.deps.sessionCreation, created));
    }
    const view = this.toDefinitionView(created);
    this.deps.metrics.taskCreated(view, context.mutationSource);
    return view;
  }

  async updateDefinition(
    command: UpdateCronDefinitionCommand,
    context: CronMutationMetricContext = { mutationSource: 'http_api' },
  ): Promise<CronDefinitionView> {
    const nowMs = this.deps.nowMs();
    const model = resolveDefinitionModel(command.model, this.deps.modelSelection);
    const updated = this.deps.lifecycle.update({
      cronId: command.cronId,
      ...(command.name === undefined ? {} : { name: command.name }),
      ...(command.schedule === undefined ? {} : { schedule: command.schedule }),
      ...(command.prompt === undefined ? {} : { prompt: command.prompt }),
      ...(command.sessionTarget === undefined ? {} : { sessionTarget: command.sessionTarget }),
      ...(command.enabled === undefined ? {} : { active: command.enabled }),
      ...(command.model === undefined ? {} : { model }),
      ...(command.project === undefined ? {} : { project: command.project }),
      nowMs,
    });
    if (command.name !== undefined) {
      this.trackDetached(syncSingleSessionTitle(this.deps.sessionCreation, updated));
    }
    const view = this.toDefinitionView(updated);
    this.deps.metrics.taskUpdated(view, context.mutationSource);
    return view;
  }

  deleteDefinition(
    command: DeleteCronDefinitionCommand,
    context: CronMutationMetricContext = { mutationSource: 'http_api' },
  ): Promise<void> {
    const definition = this.deps.definitions.get(command.cronId);
    const metricTask = definition ? this.toMetricTask(definition) : undefined;
    // Product deletion is retention-safe: tombstone the definition, cancel its
    // Scheduler job, and keep every Cron Run and conversation for history.
    this.deps.lifecycle.delete({
      cronId: command.cronId,
      nowMs: this.deps.nowMs(),
      deleteRuns: false,
    });
    if (metricTask) this.deps.metrics.taskDeleted(metricTask, context.mutationSource);
    return (
      this.deps.sessionCreation.detach?.(
        command.cronId,
        definition?.sessionTarget.mode === 'sessionId'
          ? definition.sessionTarget.sessionId
          : undefined,
      ) ?? Promise.resolve()
    );
  }

  deleteDefinitionsByAgent(agentName: string): void {
    const definitions: CronDefinitionRecord[] = [];
    let before: { createdAtMs: number; cronId: string } | undefined;
    do {
      const page = this.deps.definitions.listPage({
        agentName,
        take: MAX_PAGE_LIMIT,
        ...(before ? { before } : {}),
      });
      definitions.push(...page);
      const last = page.at(-1);
      before =
        page.length === MAX_PAGE_LIMIT && last
          ? { createdAtMs: last.createdAtMs, cronId: last.cronId }
          : undefined;
    } while (before);

    for (const definition of definitions) {
      const metricTask = this.toMetricTask(definition);
      this.deps.lifecycle.delete({
        cronId: definition.cronId,
        nowMs: this.deps.nowMs(),
        deleteRuns: false,
      });
      this.trackDetached(() =>
        this.deps.sessionCreation.detach?.(
          definition.cronId,
          definition.sessionTarget.mode === 'sessionId'
            ? definition.sessionTarget.sessionId
            : undefined,
        ),
      );
      if (metricTask) this.deps.metrics.taskDeleted(metricTask, 'system');
    }
  }

  async triggerManualRun(
    cronId: string,
    context: CronManualTriggerMetricContext = { triggerSource: 'http_api' },
  ): Promise<CronRunView> {
    const definition = this.deps.definitions.get(cronId);
    if (!definition) {
      throw new CronRepositoryError('CRON_NOT_FOUND', 'Cron definition not found');
    }
    const metricTask = this.toMetricTask(definition);
    const prepared = await this.deps.executor.prepareManual({
      cronId,
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      ...(metricTask ? { triggerMetric: { source: context.triggerSource, task: metricTask } } : {}),
    });
    return toRunView(prepared);
  }

  listRuns(query: ListCronRunsQuery): CronPage<CronRunView> {
    const limit = clampLimit(query.limit);
    const cursor = decodeRunCursor(query.cursor, query.cronId);
    const rows = this.queryRunPage(query.cronId, cursor, limit + 1);
    const page = paginate(rows, limit, (run) => encodeRunCursor(run, query.cronId));
    return {
      items: page.items.map(toRunView),
      hasMore: page.hasMore,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  private toDefinitionView(definition: CronDefinitionRecord): CronDefinitionView {
    const job = requireSchedulerJob(this.deps.scheduler.inspect(definition.schedulerId));
    return this.composeView(definition, job);
  }

  private composeView(definition: CronDefinitionRecord, job: ScheduledJob): CronDefinitionView {
    return {
      cronId: definition.cronId,
      name: definition.name,
      agentName: definition.agentName,
      schedule: toCronSchedule(job.schedule),
      enabled: job.state === 'active',
      prompt: definition.prompt,
      sessionTarget: definition.sessionTarget,
      project: definition.project,
      model: definition.model,
      createdAtMs: definition.createdAtMs,
      updatedAtMs: definition.updatedAtMs,
      ...(job.nextRunAtMs === undefined ? {} : { nextRunAtMs: job.nextRunAtMs }),
      ...(definition.deletedAtMs === undefined ? {} : { deletedAtMs: definition.deletedAtMs }),
    };
  }

  private toMetricTask(definition: CronDefinitionRecord): CronMetricTask | undefined {
    try {
      const job = this.deps.scheduler.inspect(definition.schedulerId);
      if (!job) return undefined;
      return {
        agentName: definition.agentName,
        schedule: toCronSchedule(job.schedule),
        sessionTarget: definition.sessionTarget,
      };
    } catch {
      return undefined;
    }
  }

  private queryDefinitionPage(
    query: ListCronDefinitionsQuery,
    cursor: DefinitionCursor | undefined,
    take: number,
  ): CronDefinitionRecord[] {
    return this.deps.definitions.listPage({
      ...(query.agentName === undefined ? {} : { agentName: query.agentName }),
      includeDeleted: query.includeDeleted === true,
      ...(cursor ? { before: { createdAtMs: cursor.createdAtMs, cronId: cursor.id } } : {}),
      take,
    });
  }

  private queryRunPage(cronId: string, cursor: RunCursor | undefined, take: number): CronRun[] {
    return this.deps.runs.listPage({
      cronId,
      ...(cursor ? { before: { createdAtMs: cursor.createdAtMs, runId: cursor.id } } : {}),
      take,
    });
  }

  private trackDetached(operation: (() => Promise<unknown> | undefined) | Promise<void>): void {
    this.detachedReconciliations.push(
      typeof operation === 'function' ? settleBestEffort(operation) : operation,
    );
  }
}

function resolveDefinitionModel(
  model: string | null | undefined,
  selection: CronModelSelectionPort,
): string | null | undefined {
  if (model === undefined || model === null) return model;
  let decoded: ReturnType<typeof decodeCronModel>;
  try {
    decoded = decodeCronModel(model);
  } catch {
    throw new CronRepositoryError('CRON_INVALID', 'Invalid scheduled task model configuration');
  }
  const resolution = selection.resolve(decoded.modelKey);
  if (resolution.kind === 'resolved') {
    if (!decoded.selection) return resolution.modelKey;
    const separator = resolution.modelKey.indexOf('/');
    return encodeCronModel({
      ...decoded.selection,
      providerID: resolution.modelKey.slice(0, separator),
      modelID: resolution.modelKey.slice(separator + 1),
    });
  }
  if (resolution.kind === 'ambiguous') {
    throw new CronRepositoryError(
      'CRON_INVALID',
      `Model ${JSON.stringify(model)} matches multiple available models: ${resolution.candidates.join(', ')}. Ask the user to choose one.`,
    );
  }
  throw new CronRepositoryError(
    'CRON_INVALID',
    `Model ${JSON.stringify(model)} does not match an available model. Ask the user to choose one.`,
  );
}

function syncSingleSessionTitle(
  sessionCreation: CronSessionCreationPort,
  definition: CronDefinitionRecord,
): Promise<void> {
  if (definition.sessionTarget.mode !== 'sessionId') return Promise.resolve();
  const sessionId = definition.sessionTarget.sessionId;
  if (!sessionId) return Promise.resolve();
  // The task definition is already durable. Session metadata is a separate
  // boundary, so title convergence follows the same best-effort rule as
  // task-owned session cleanup.
  return settleBestEffort(() => sessionCreation.rename?.(sessionId, definition.name));
}

interface DefinitionCursorRow {
  readonly cronId: string;
  readonly createdAtMs: number;
}

interface DefinitionCursor {
  readonly createdAtMs: number;
  readonly id: string;
}

interface RunCursor {
  readonly createdAtMs: number;
  readonly id: string;
}

interface Paginated<T> {
  readonly items: T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

function paginate<T extends { createdAtMs: number }>(
  rows: T[],
  limit: number,
  toCursor: (row: T) => string,
): Paginated<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    hasMore,
    ...(hasMore && last ? { nextCursor: toCursor(last) } : {}),
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new CronRepositoryError('CRON_INVALID', 'limit must be a positive integer');
  }
  return Math.min(limit, MAX_PAGE_LIMIT);
}

function encodeDefinitionCursor(row: DefinitionCursorRow, query: ListCronDefinitionsQuery): string {
  return encodeCursor({
    version: 1,
    kind: 'definitions',
    scope: {
      agentName: query.agentName ?? null,
      includeDeleted: query.includeDeleted === true,
    },
    createdAtMs: row.createdAtMs,
    id: row.cronId,
  });
}

function decodeDefinitionCursor(
  cursor: string | undefined,
  query: ListCronDefinitionsQuery,
): DefinitionCursor | undefined {
  const decoded = decodeCursor(cursor);
  if (decoded === undefined) return undefined;
  if (
    decoded.kind !== 'definitions' ||
    decoded.scope.agentName !== (query.agentName ?? null) ||
    decoded.scope.includeDeleted !== (query.includeDeleted === true)
  ) {
    throw new CronRepositoryError('CRON_INVALID', 'cursor does not match this definition query');
  }
  return { createdAtMs: decoded.createdAtMs, id: decoded.id };
}

function encodeRunCursor(run: CronRun, cronId: string): string {
  return encodeCursor({
    version: 1,
    kind: 'runs',
    scope: { cronId },
    createdAtMs: run.createdAtMs,
    id: run.runId,
  });
}

function decodeRunCursor(cursor: string | undefined, cronId: string): RunCursor | undefined {
  const decoded = decodeCursor(cursor);
  if (decoded === undefined) return undefined;
  if (decoded.kind !== 'runs' || decoded.scope.cronId !== cronId) {
    throw new CronRepositoryError('CRON_INVALID', 'cursor does not match this run query');
  }
  return { createdAtMs: decoded.createdAtMs, id: decoded.id };
}

type CursorPayload =
  | {
      readonly version: 1;
      readonly kind: 'definitions';
      readonly scope: { readonly agentName: string | null; readonly includeDeleted: boolean };
      readonly createdAtMs: number;
      readonly id: string;
    }
  | {
      readonly version: 1;
      readonly kind: 'runs';
      readonly scope: { readonly cronId: string };
      readonly createdAtMs: number;
      readonly id: string;
    };

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): CursorPayload | undefined {
  if (cursor === undefined || cursor.trim() === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new CronRepositoryError('CRON_INVALID', 'cursor is malformed');
  }
  if (!isCursorPayload(value)) {
    throw new CronRepositoryError('CRON_INVALID', 'cursor is malformed');
  }
  return value;
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (!isCursorBase(value)) return false;
  const payload = value;
  const scope = payload.scope as Record<string, unknown>;
  if (payload.kind === 'definitions') return isDefinitionCursorScope(scope);
  return payload.kind === 'runs' && isRunCursorScope(scope);
}

function isCursorBase(value: unknown): value is Record<string, unknown> & {
  createdAtMs: number;
  id: string;
  scope: Record<string, unknown>;
} {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  const validTimestamp =
    Number.isSafeInteger(payload.createdAtMs) && (payload.createdAtMs as number) >= 0;
  const validId = typeof payload.id === 'string' && payload.id.length > 0;
  const validScope = typeof payload.scope === 'object' && payload.scope !== null;
  return payload.version === 1 && validTimestamp && validId && validScope;
}

function isDefinitionCursorScope(scope: Record<string, unknown>): boolean {
  const validAgentName = scope.agentName === null || typeof scope.agentName === 'string';
  return validAgentName && typeof scope.includeDeleted === 'boolean';
}

function isRunCursorScope(scope: Record<string, unknown>): boolean {
  return typeof scope.cronId === 'string' && scope.cronId.length > 0;
}

const RUN_VIEW_STATUS: Record<CronRun['status'], CronRunViewStatus> = {
  pending: 'pending',
  delivered: 'delivered',
  failed: 'failed',
};

const RUN_VIEW_SOURCE: Record<CronRun['triggerSource'], CronRunViewTriggerSource> = {
  manual: 'manual',
  scheduled: 'scheduled',
};

function toRunView(run: CronRun): CronRunView {
  return {
    runId: run.runId,
    cronId: run.cronId,
    triggerSource: RUN_VIEW_SOURCE[run.triggerSource],
    status: RUN_VIEW_STATUS[run.status],
    createdAtMs: run.createdAtMs,
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
    ...(run.deliveredAtMs === undefined ? {} : { deliveredAtMs: run.deliveredAtMs }),
    ...(run.failedAtMs === undefined ? {} : { failedAtMs: run.failedAtMs }),
    ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }),
    ...(run.error === undefined ? {} : { error: run.error }),
  };
}

function requireSchedulerJob(job: ScheduledJob | undefined): ScheduledJob {
  if (!job) {
    throw new CronRepositoryError('CRON_NOT_FOUND', 'Cron definition has no Scheduler job');
  }
  return job;
}
