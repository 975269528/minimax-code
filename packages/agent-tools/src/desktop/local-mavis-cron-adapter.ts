import {
  appendQuietOnSkipPromptSuffix,
  LocalMavisCronValidationError,
  parseOnceRunAtMs,
  everyToCronExpression,
} from '../shared/cron-schedule-input.js';

import type {
  LocalMavisCronAdapter,
  LocalMavisCronCreationSessionTarget,
  LocalMavisCronRun,
  LocalMavisCronSessionTarget,
  LocalMavisCronTask,
  LocalMavisModelResolution,
} from './types.js';
import { CRON_REQUEST_SOURCE_HEADER } from '@mavis/protocol';

export {
  LocalMavisCronValidationError,
  parseOnceRunAtMs,
  everyToCronExpression,
} from '../shared/cron-schedule-input.js';

const CronScheduleKind = { Recurring: 0, Once: 1 } as const;
const CronSessionTargetMode = { New: 0, SessionId: 1 } as const;
const CronRunStatus = { Pending: 0, Delivered: 1, Failed: 2 } as const;
const CronTriggerSource = { Manual: 0, Scheduled: 1 } as const;

type CronScheduleKind = (typeof CronScheduleKind)[keyof typeof CronScheduleKind];
type CronSessionTargetMode = (typeof CronSessionTargetMode)[keyof typeof CronSessionTargetMode];
type CronRunStatus = (typeof CronRunStatus)[keyof typeof CronRunStatus];
type CronTriggerSource = (typeof CronTriggerSource)[keyof typeof CronTriggerSource];

interface CronSchedule {
  readonly kind: CronScheduleKind;
  readonly expression?: string;
  readonly timezone?: string;
  readonly runAtMs?: number;
}

interface CronSessionTarget {
  readonly mode: CronSessionTargetMode;
  readonly sessionId?: string;
}

interface CronDefinition {
  readonly cronId: string;
  readonly name: string;
  readonly agentName: string;
  readonly schedule: CronSchedule;
  readonly enabled: boolean;
  readonly prompt: string;
  readonly nextRunAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly consumedAt?: number;
  readonly deletedAt?: number;
  readonly sessionTarget: CronSessionTarget;
  readonly project?: string;
  readonly model?: string;
}

interface CronRun {
  readonly runId: string;
  readonly cronId: string;
  readonly triggerSource: CronTriggerSource;
  readonly sessionId?: string;
  readonly status: CronRunStatus;
  readonly createdAt: number;
  readonly deliveredAt?: number;
  readonly failedAt?: number;
  readonly errorCode?: string;
  readonly error?: string;
}

interface CronClientCallOptions {
  readonly signal?: AbortSignal;
  readonly headers?: Record<string, string>;
}

interface RuntimeModelInfo {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName?: string;
  readonly modelConfigId?: string;
}

interface ListRuntimeModelsRequest {
  readonly sessionId?: string;
}

/** Structural subset of the generated `DesktopService` client required by legacy tool adapters. */
export interface CronV2GeneratedClient {
  listModels(
    request: ListRuntimeModelsRequest,
    options?: CronClientCallOptions,
  ): Promise<{ models: RuntimeModelInfo[] }>;
  listCronDefinitions(
    request: { cursor?: string; limit?: number; includeDeleted?: boolean; agentName?: string },
    options?: CronClientCallOptions,
  ): Promise<{
    definitions: CronDefinition[];
    count?: number;
    hasMore?: boolean;
    nextCursor?: string;
  }>;
  getCronDefinition(
    request: { cronId: string },
    options?: CronClientCallOptions,
  ): Promise<{ definition: CronDefinition }>;
  createCronDefinition(
    request: {
      name: string;
      agentName: string;
      schedule: CronSchedule;
      prompt: string;
      enabled?: boolean;
      sessionTarget: CronSessionTarget;
      project?: string;
      model?: string;
    },
    options?: CronClientCallOptions,
  ): Promise<{ definition: CronDefinition }>;
  updateCronDefinition(
    request: {
      cronId: string;
      schedule?: CronSchedule;
      prompt?: string;
      enabled?: boolean;
      sessionTarget?: CronSessionTarget;
    },
    options?: CronClientCallOptions,
  ): Promise<{ definition: CronDefinition }>;
  deleteCronDefinition(
    request: { cronId: string },
    options?: CronClientCallOptions,
  ): Promise<{ success: boolean }>;
  triggerCronRun(
    request: { cronId: string },
    options?: CronClientCallOptions,
  ): Promise<{ run: CronRun }>;
  listCronRuns(
    request: { cronId: string; cursor?: string; limit?: number },
    options?: CronClientCallOptions,
  ): Promise<{ runs: CronRun[]; count?: number; hasMore?: boolean; nextCursor?: string }>;
}

/**
 * Options for {@link createLocalMavisCronAdapter}.
 *
 * The adapter only converts user input: parsing `after`/`at`, converting `every` to Cron
 * expressions, and generating self-reminder names. All persisted facts come unchanged from the
 * generated Cron v2 API.
 */
export interface LocalMavisCronAdapterOptions {
  /** Injected clock; defaults to {@link Date.now}. */
  readonly nowMs?: () => number;
  /** Generate a deterministic name for `cron once` when the caller omits one. */
  readonly onceNameFactory?: () => string;
  /** Generate a deterministic name for `cron self` when the caller omits one. */
  readonly selfNameFactory?: () => string;
}

/**
 * Stable error thrown when callers bypass the Tool schema and directly provide arguments explicitly
 * unsupported by the Cron v2 domain. Currently only `active_hours` is explicitly rejected.
 *
 * `dispatchLocalMavis` maps the existing `status`/`code` error structure to a `validation` failure
 * result.
 */
export class LocalMavisCronUnsupportedError extends Error {
  readonly status = 400;
  readonly statusCode = 400;
  readonly code = 'CRON_PARAM_UNSUPPORTED';
  readonly parameter: string;

  constructor(parameter: string, detail: string) {
    super(`unsupported cron parameter: ${parameter} — ${detail}`);
    this.name = 'LocalMavisCronUnsupportedError';
    this.parameter = parameter;
  }
}

const NOT_FOUND_CODES = new Set(['CRON_NOT_FOUND', 'NOT_FOUND', 'CRON_DEFINITION_NOT_FOUND']);

/**
 * Create a {@link LocalMavisCronAdapter} forwarding legacy Local Mavis Cron commands to the
 * generated `DesktopService` Cron v2 client.
 *
 * Success and failure results remain compatible with the pre-MR2 Local Mavis Tool contract. Mapping
 * follows task §8.5:
 * - `session.mode=new` → Explicit new-session target.
 * - `session.mode=sessionId` → Explicit fixed-session target.
 * - `cron self` → Use the current `sessionId` as the fixed-session target.
 * - `enabled=false` → paused; `enabled=true` → active/resume.
 * - `cron delete` → Delete only the Definition, retaining CronRun and chat Session.
 * - `cron sessions` → CronRun history, including `sessionId` per run.
 * - Recurring create/update → Recurring scheduling.
 * - `cron once` → One-time scheduling.
 *
 * `active_hours` is explicitly rejected via {@link LocalMavisCronUnsupportedError}.
 */
export function createLocalMavisCronAdapter(
  client: CronV2GeneratedClient,
  options: LocalMavisCronAdapterOptions = {},
): LocalMavisCronAdapter {
  const nowMs = options.nowMs ?? (() => Date.now());
  const onceName = options.onceNameFactory ?? (() => `once-${randomSlug()}`);
  const selfName = options.selfNameFactory ?? (() => `watch-${randomSlug()}`);
  const callOptions = (signal: AbortSignal | undefined) => (signal ? { signal } : undefined);
  const mutationCallOptions = (signal: AbortSignal | undefined): CronClientCallOptions => ({
    ...(signal ? { signal } : {}),
    headers: { [CRON_REQUEST_SOURCE_HEADER]: 'agent_tool' },
  });

  return {
    async resolveModel(req, signal) {
      const response = await client.listModels(
        { ...(req.sessionId ? { sessionId: req.sessionId } : {}) },
        callOptions(signal),
      );
      return resolveModelFromCatalog(response.models, req.model);
    },

    async listCrons(req, signal) {
      const resp = await client.listCronDefinitions(
        {
          ...(req.agentName === undefined ? {} : { agentName: req.agentName }),
          ...(req.cursor === undefined ? {} : { cursor: req.cursor }),
          ...(req.limit === undefined ? {} : { limit: req.limit }),
        },
        callOptions(signal),
      );
      return {
        tasks: (resp.definitions ?? []).map(toCronTask),
        ...(resp.count === undefined ? {} : { count: resp.count }),
        ...(resp.hasMore === undefined ? {} : { hasMore: resp.hasMore }),
        ...(resp.nextCursor === undefined ? {} : { nextCursor: resp.nextCursor }),
      };
    },

    async getCron(req, signal) {
      try {
        const resp = await client.getCronDefinition({ cronId: req.cronId }, callOptions(signal));
        return { task: toCronTask(resp.definition) };
      } catch (error) {
        if (isNotFound(error)) return {};
        throw error;
      }
    },

    async createCron(req, signal) {
      rejectActiveHours(req.activeHours);
      const sessionTarget = mapCreationSessionTarget(req.session);
      const resp = await client.createCronDefinition(
        {
          name: req.cronName,
          agentName: req.agentName,
          schedule: recurringSchedule(req.schedule, req.timezone),
          prompt: req.prompt,
          sessionTarget,
          ...(req.project === undefined ? {} : { project: req.project }),
          ...(req.model === undefined ? {} : { model: req.model }),
          ...(req.enabled === undefined ? {} : { enabled: req.enabled }),
        },
        mutationCallOptions(signal),
      );
      return { task: toCronTask(resp.definition) };
    },

    async createSelfReminder(req, signal) {
      const name = req.cronName?.trim() || selfName();
      // Self-reminders must include their owning agent. The generated createCronDefinition contract returns 400
      // for an empty agentName; the Cron executor validates it again when creating the session.
      // The caller must resolve the current session's agent and pass it here.
      const agentName = req.agentName.trim();
      if (!agentName) {
        throw new LocalMavisCronValidationError('cron self requires a non-empty agent name');
      }
      const resp = await client.createCronDefinition(
        {
          name,
          agentName,
          schedule: recurringSchedule(everyToCronExpression(req.every), req.timezone),
          prompt: appendQuietOnSkipPromptSuffix(req.prompt, req.quietOnSkip ?? true),
          sessionTarget: { mode: CronSessionTargetMode.SessionId, sessionId: req.sessionId },
          ...(req.project === undefined ? {} : { project: req.project }),
          ...(req.model === undefined ? {} : { model: req.model }),
        },
        mutationCallOptions(signal),
      );
      const definition = resp.definition;
      return {
        agentName: definition.agentName,
        cronName: definition.name,
        schedule: definition.schedule.expression ?? '',
        sessionId:
          definition.sessionTarget.mode === CronSessionTargetMode.SessionId
            ? requireSessionTargetId(definition.sessionTarget)
            : req.sessionId,
        task: toCronTask(definition),
      };
    },

    async createOnceCron(req, signal) {
      const sessionTarget = mapCreationSessionTarget(req.session);
      const runAtMs = parseOnceRunAtMs(req, nowMs());
      const resp = await client.createCronDefinition(
        {
          name: req.cronName?.trim() || onceName(),
          agentName: req.agentName,
          schedule: { kind: CronScheduleKind.Once, runAtMs },
          prompt: req.prompt,
          sessionTarget,
          ...(req.project === undefined ? {} : { project: req.project }),
          ...(req.model === undefined ? {} : { model: req.model }),
        },
        mutationCallOptions(signal),
      );
      const definition = resp.definition;
      return {
        agentName: definition.agentName,
        cronName: definition.name,
        runAtMs: definition.schedule.runAtMs ?? runAtMs,
        ...(definition.sessionTarget.mode === CronSessionTargetMode.SessionId
          ? { sessionId: requireSessionTargetId(definition.sessionTarget) }
          : {}),
        task: toCronTask(definition),
      };
    },

    async updateCron(req, signal) {
      rejectActiveHours(req.activeHours);
      const targetFields =
        req.session === undefined ? {} : { sessionTarget: mapSessionTarget(req.session) };
      const resp = await client.updateCronDefinition(
        {
          cronId: req.cronId,
          ...(req.schedule === undefined
            ? {}
            : { schedule: recurringSchedule(req.schedule, req.timezone) }),
          ...(req.prompt === undefined ? {} : { prompt: req.prompt }),
          ...targetFields,
          ...(req.enabled === undefined ? {} : { enabled: req.enabled }),
        },
        mutationCallOptions(signal),
      );
      return { task: toCronTask(resp.definition) };
    },

    async deleteCron(req, signal) {
      const resp = await client.deleteCronDefinition(
        { cronId: req.cronId },
        mutationCallOptions(signal),
      );
      return { success: resp.success };
    },

    async triggerCron(req, signal) {
      const resp = await client.triggerCronRun({ cronId: req.cronId }, mutationCallOptions(signal));
      const run = resp.run;
      return {
        success: run.status !== CronRunStatus.Failed,
        runId: run.runId,
        ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
        createdAt: run.createdAt,
        status: runStatusLabel(run.status),
        triggerSource: triggerSourceLabel(run.triggerSource),
        ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }),
        ...(run.status === CronRunStatus.Failed && run.error !== undefined
          ? { reason: run.error }
          : {}),
      };
    },

    async listCronSessions(req, signal) {
      const resp = await client.listCronRuns(
        {
          cronId: req.cronId,
          ...(req.cursor === undefined ? {} : { cursor: req.cursor }),
          ...(req.limit === undefined ? {} : { limit: req.limit }),
        },
        callOptions(signal),
      );
      return {
        sessions: (resp.runs ?? []).map(toRunSession),
        ...(resp.count === undefined ? {} : { total: resp.count }),
        ...(resp.hasMore === undefined ? {} : { hasMore: resp.hasMore }),
        ...(resp.nextCursor === undefined ? {} : { nextCursor: resp.nextCursor }),
      };
    },
  };
}

function resolveModelFromCatalog(
  catalog: readonly RuntimeModelInfo[],
  rawModel: string,
): LocalMavisModelResolution {
  const input = rawModel.trim();
  if (!input) return { kind: 'not_found' };

  const exactKey = uniqueModelMatches(
    catalog.filter((model) => modelKey(model).toLowerCase() === input.toLowerCase()),
  );
  if (exactKey) return exactKey;

  const exactName = uniqueModelMatches(
    catalog.filter(
      (model) =>
        model.modelId.toLowerCase() === input.toLowerCase() ||
        model.displayName?.toLowerCase() === input.toLowerCase(),
    ),
  );
  if (exactName) return exactName;

  const shorthand = normalizeModelSearchText(input);
  if (shorthand.length < 2) return { kind: 'not_found' };
  return (
    uniqueModelMatches(
      catalog.filter((model) =>
        [model.modelId, model.displayName].some(
          (value) => value && normalizeModelSearchText(value).includes(shorthand),
        ),
      ),
    ) ?? { kind: 'not_found' }
  );
}

function uniqueModelMatches(
  models: readonly RuntimeModelInfo[],
): Exclude<LocalMavisModelResolution, { readonly kind: 'not_found' }> | undefined {
  const candidates = [...new Set(models.map(modelKey))];
  const [model] = candidates;
  if (candidates.length === 1 && model !== undefined) return { kind: 'resolved', model };
  if (candidates.length > 1) return { kind: 'ambiguous', candidates };
  return undefined;
}

function modelKey(model: RuntimeModelInfo): string {
  return model.modelConfigId?.trim() || `${model.providerId}/${model.modelId}`;
}

function normalizeModelSearchText(value: string): string {
  return (
    value
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).join('');
}

function mapSessionTarget(session: LocalMavisCronSessionTarget | undefined): CronSessionTarget {
  if (!session) {
    throw new LocalMavisCronValidationError('cron create requires an explicit session target');
  }
  if (session.mode === 'new') return { mode: CronSessionTargetMode.New };
  if (session.mode !== 'sessionId') {
    throw new LocalMavisCronValidationError(
      `unknown session.mode: ${JSON.stringify((session as { mode?: unknown }).mode)}`,
    );
  }
  const sessionId = session.sessionId?.trim();
  if (!sessionId) {
    throw new LocalMavisCronValidationError(
      'session.mode=sessionId requires a non-empty session_id',
    );
  }
  return { mode: CronSessionTargetMode.SessionId, sessionId };
}

function mapCreationSessionTarget(
  session: LocalMavisCronCreationSessionTarget | undefined,
): CronSessionTarget {
  if (!session) {
    throw new LocalMavisCronValidationError('cron create requires an explicit session target');
  }
  if (session.mode === 'new') return { mode: CronSessionTargetMode.New };
  const sessionId = session.sessionId?.trim();
  return {
    mode: CronSessionTargetMode.SessionId,
    ...(sessionId ? { sessionId } : {}),
  };
}

function rejectActiveHours(activeHours: { start?: string; end?: string } | undefined): void {
  if (activeHours === undefined) return;
  throw new LocalMavisCronUnsupportedError(
    'active_hours',
    'active-hours windows are not supported; the cron fires on its schedule regardless of time of day',
  );
}

function recurringSchedule(expression: string, timezone: string | undefined): CronSchedule {
  return {
    kind: CronScheduleKind.Recurring,
    expression,
    ...(timezone === undefined ? {} : { timezone }),
  };
}

function toCronTask(definition: CronDefinition): LocalMavisCronTask {
  const once = definition.schedule.kind === CronScheduleKind.Once;
  return {
    cronId: definition.cronId,
    cronName: definition.name,
    agentName: definition.agentName,
    scheduleType: once ? 'once' : 'cron',
    ...(definition.schedule.expression === undefined
      ? {}
      : { schedule: definition.schedule.expression }),
    ...(definition.schedule.runAtMs === undefined ? {} : { runAtMs: definition.schedule.runAtMs }),
    ...(definition.schedule.timezone === undefined
      ? {}
      : { timezone: definition.schedule.timezone }),
    enabled: definition.enabled,
    prompt: definition.prompt,
    session:
      definition.sessionTarget.mode === CronSessionTargetMode.New
        ? { mode: 'new' }
        : { mode: 'sessionId', sessionId: requireSessionTargetId(definition.sessionTarget) },
    ...(definition.project ? { project: definition.project } : {}),
    ...(definition.model ? { model: definition.model } : {}),
    ...(definition.nextRunAt === undefined ? {} : { nextRun: definition.nextRunAt }),
    status: definitionStatus(definition),
  };
}

function requireSessionTargetId(target: CronSessionTarget): string {
  const sessionId = target.sessionId?.trim();
  if (!sessionId) {
    throw new LocalMavisCronValidationError(
      'sessionTarget.sessionId is required for SessionId mode',
    );
  }
  return sessionId;
}

function definitionStatus(definition: CronDefinition): string {
  if (definition.deletedAt !== undefined) return 'deleted';
  if (definition.consumedAt !== undefined) return 'consumed';
  return definition.enabled ? 'active' : 'paused';
}

function toRunSession(run: CronRun): LocalMavisCronRun {
  return {
    runId: run.runId,
    createdAt: run.createdAt,
    status: runStatusLabel(run.status),
    triggerSource: triggerSourceLabel(run.triggerSource),
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
    ...(run.deliveredAt === undefined ? {} : { deliveredAt: run.deliveredAt }),
    ...(run.failedAt === undefined ? {} : { failedAt: run.failedAt }),
    ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }),
    ...(run.error === undefined ? {} : { error: run.error }),
  };
}

function runStatusLabel(status: CronRunStatus): LocalMavisCronRun['status'] {
  switch (status) {
    case CronRunStatus.Delivered:
      return 'delivered';
    case CronRunStatus.Failed:
      return 'failed';
    default:
      return 'pending';
  }
}

function triggerSourceLabel(triggerSource: CronTriggerSource): LocalMavisCronRun['triggerSource'] {
  return triggerSource === CronTriggerSource.Manual ? 'manual' : 'scheduled';
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { status?: number; statusCode?: number; code?: string };
  if (candidate.status === 404 || candidate.statusCode === 404) return true;
  return typeof candidate.code === 'string' && NOT_FOUND_CODES.has(candidate.code);
}

function randomSlug(): string {
  return Math.random().toString(36).slice(2, 8);
}
