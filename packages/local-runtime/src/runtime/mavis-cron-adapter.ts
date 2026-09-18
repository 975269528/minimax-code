import { randomBytes } from 'node:crypto';

import type {
  LocalMavisCronAdapter,
  LocalMavisCronCreationSessionTarget,
  LocalMavisCronSessionTarget,
  LocalMavisCronTask,
} from '@mavis/agent-tools/desktop';
import type { CronStorePort } from '@mavis/cron';
import { generateWatchCronName, parseWatchInterval } from '@mavis/shared';

import {
  assertCronName,
  assertSchedulable,
  createCronReqToConfig,
  cronStateToCronTask,
  toCronContractError,
  updateCronReqToConfigUpdate,
} from '../cron/contract.js';
import type { LocalCronRuntime } from '../cron/index.js';
import {
  createStoredCronTask,
  deleteStoredCronTask,
  getStoredCronTask,
  listStoredCronTasks,
  updateStoredCronTask,
} from '../cron/index.js';
import { parseOnceRunAtMs } from '../cron/once-time.js';
import type { LocalSessionRecord } from '../sessions/controller.js';

type CronKey = { agentName: string; cronName: string };

export interface HostMavisCronDeps {
  cronRuntime: LocalCronRuntime;
  cronStore: CronStorePort & {
    resolveKeyByCronId?(cronId: string): Promise<CronKey | undefined>;
  };
  agentExists(agentName: string): Promise<boolean>;
  getSessionById(sessionId: string): Promise<LocalSessionRecord | undefined>;
  isReadOnlyLegacySession?: (session: LocalSessionRecord) => Promise<boolean>;
  nowMs(): number;
}

export function buildMavisCronAdapter(deps: HostMavisCronDeps): LocalMavisCronAdapter {
  return {
    listCrons: async (req) => {
      await deps.cronRuntime.ensureStarted('mavis_tool:list_crons');
      const allTasks = req.agentName
        ? deps.cronRuntime.cronConsumerEnabled
          ? deps.cronRuntime.registry.listTasks(req.agentName)
          : await listStoredCronTasks(deps.cronStore, req.agentName)
        : deps.cronRuntime.cronConsumerEnabled
          ? deps.cronRuntime.registry.listAllTasks()
          : await listStoredCronTasks(deps.cronStore);
      const page = pageByCronCursor(allTasks.map(toMavisCronTask), req.cursor, req.limit);
      return {
        tasks: page.items,
        count: page.items.length,
        hasMore: page.hasMore,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
    getCron: async (req) => {
      await deps.cronRuntime.ensureStarted('mavis_tool:get_cron');
      const key = await resolveMavisCronKey(deps, req.cronId);
      if (!key) return {};
      const task = deps.cronRuntime.cronConsumerEnabled
        ? deps.cronRuntime.registry.getTask(key.agentName, key.cronName)
        : await getStoredCronTask(deps.cronStore, key.agentName, key.cronName);
      return { ...(task ? { task: toMavisCronTask(task) } : {}) };
    },
    createCron: async (req) => {
      await deps.cronRuntime.ensureStarted('mavis_tool:create_cron');
      return mapMavisCronErrors(async () => {
        assertCronName(req.cronName);
        if (!(await deps.agentExists(req.agentName))) {
          throw Object.assign(new Error('Agent not found'), {
            status: 404,
            statusCode: 404,
            code: 'AGENT_NOT_FOUND',
          });
        }
        const config = createCronReqToConfig({
          name: req.agentName,
          cronName: req.cronName,
          schedule: req.schedule,
          prompt: req.prompt,
          ...(req.timezone ? { timezone: req.timezone } : {}),
          ...(req.activeHours ? { activeHours: req.activeHours } : {}),
          session: req.session,
          ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
        });
        assertSchedulable(config);
        const state = deps.cronRuntime.cronConsumerEnabled
          ? await deps.cronRuntime.registry.createTask(req.agentName, req.cronName, config, {
              mutationSource: 'agent_tool',
            })
          : await createStoredCronTask(deps.cronStore, req.agentName, req.cronName, config);
        return { task: toMavisCronTask(state) };
      });
    },
    createSelfReminder: async (req) => {
      await deps.cronRuntime.ensureStarted('mavis_tool:create_self_reminder');
      return mapMavisCronErrors(async () => {
        const session = await deps.getSessionById(req.sessionId);
        if (!session) {
          throw Object.assign(new Error(`Session not found: ${req.sessionId}`), {
            status: 404,
            statusCode: 404,
            code: 'SESSION_NOT_FOUND',
          });
        }
        if (await deps.isReadOnlyLegacySession?.(session)) {
          throw Object.assign(
            new Error('Legacy opencode sessions are read-only in clean local-runtime mode.'),
            {
              status: 409,
              statusCode: 409,
              code: 'read_only_legacy_session',
            },
          );
        }
        const cronName =
          req.cronName?.trim() || generateWatchCronName('watch', randomBytes(3).toString('hex'));
        assertCronName(cronName);
        const schedule = parseWatchInterval(req.every).cronExpr;
        const prompt = appendQuietOnSkipPromptSuffix(req.prompt, req.quietOnSkip ?? true);
        const config = {
          schedule,
          scheduleType: 'cron' as const,
          prompt,
          ...(req.timezone ? { timezone: req.timezone } : {}),
          session: { mode: 'sessionId' as const, sessionId: req.sessionId },
          disabled: false,
        };
        const state = deps.cronRuntime.cronConsumerEnabled
          ? await deps.cronRuntime.registry.createTask(session.agentName, cronName, config, {
              mutationSource: 'agent_tool',
              deliveryTarget: 'me',
            })
          : await createStoredCronTask(deps.cronStore, session.agentName, cronName, config);
        return {
          agentName: session.agentName,
          cronName,
          schedule,
          sessionId: req.sessionId,
          task: toMavisCronTask(state),
        };
      });
    },
    createOnceCron: async (req) => {
      await deps.cronRuntime.ensureStarted('mavis_tool:create_once_cron');
      return mapMavisCronErrors(async () => {
        if (!(await deps.agentExists(req.agentName))) {
          throw Object.assign(new Error('Agent not found'), {
            status: 404,
            statusCode: 404,
            code: 'AGENT_NOT_FOUND',
          });
        }
        const cronName =
          req.cronName?.trim() || generateWatchCronName('once', randomBytes(3).toString('hex'));
        assertCronName(cronName);
        const runAtMs = parseOnceRunAtMs(req, deps.nowMs());
        const session = normalizeOnceSession(req.session);
        const config = {
          schedule: `once:${runAtMs}`,
          scheduleType: 'once' as const,
          runAtMs,
          deleteAfterRun: true,
          prompt: req.prompt,
          ...(req.timezone ? { timezone: req.timezone } : {}),
          session,
          disabled: false,
        };
        const state = deps.cronRuntime.cronConsumerEnabled
          ? await deps.cronRuntime.registry.createTask(req.agentName, cronName, config, {
              mutationSource: 'agent_tool',
            })
          : await createStoredCronTask(deps.cronStore, req.agentName, cronName, config);
        return {
          agentName: req.agentName,
          cronName,
          runAtMs,
          ...(session.mode === 'sessionId' ? { sessionId: session.sessionId } : {}),
          task: toMavisCronTask(state),
        };
      });
    },
    updateCron: async (req) => {
      await deps.cronRuntime.ensureStarted('mavis_tool:update_cron');
      return mapMavisCronErrors(async () => {
        const key = await resolveMavisCronKeyOrThrow(deps, req.cronId);
        const update = updateCronReqToConfigUpdate({
          cronId: req.cronId,
          ...(req.schedule !== undefined ? { schedule: req.schedule } : {}),
          ...(req.prompt !== undefined ? { prompt: req.prompt } : {}),
          ...(req.timezone !== undefined ? { timezone: req.timezone } : {}),
          ...(req.activeHours ? { activeHours: req.activeHours } : {}),
          ...(req.session ? { session: req.session } : {}),
          ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
        });
        if (Object.keys(update).length === 0) {
          throw Object.assign(new Error('At least one field must be provided'), {
            status: 400,
            statusCode: 400,
            code: 'VALIDATION_ERROR',
          });
        }
        const existing = deps.cronRuntime.cronConsumerEnabled
          ? deps.cronRuntime.registry.getTask(key.agentName, key.cronName)
          : await getStoredCronTask(deps.cronStore, key.agentName, key.cronName);
        if (!existing) throw mavisCronNotFound(req.cronId);
        if (update.schedule !== undefined || update.timezone !== undefined) {
          assertSchedulable({
            schedule: update.schedule ?? existing.config.schedule,
            timezone:
              update.timezone === null ? undefined : (update.timezone ?? existing.config.timezone),
          });
        }
        const updated = deps.cronRuntime.cronConsumerEnabled
          ? await deps.cronRuntime.registry.updateConfig(key.agentName, key.cronName, update, {
              mutationSource: 'agent_tool',
            })
          : await updateStoredCronTask(deps.cronStore, key.agentName, key.cronName, update);
        if (!updated) throw mavisCronNotFound(req.cronId);
        return { task: toMavisCronTask(updated) };
      });
    },
    deleteCron: async (req) => {
      await deps.cronRuntime.ensureStarted('mavis_tool:delete_cron');
      return mapMavisCronErrors(async () => {
        const key = await resolveMavisCronKeyOrThrow(deps, req.cronId);
        const deleted = deps.cronRuntime.cronConsumerEnabled
          ? await deps.cronRuntime.registry.deleteTask(key.agentName, key.cronName, {
              mutationSource: 'agent_tool',
            })
          : await deleteStoredCronTask(deps.cronStore, key.agentName, key.cronName);
        if (!deleted) throw mavisCronNotFound(req.cronId);
        return { success: true };
      });
    },
    triggerCron: async (req) => {
      await deps.cronRuntime.ensureStarted('mavis_tool:trigger_cron');
      return mapMavisCronErrors(async () => {
        if (!deps.cronRuntime.cronConsumerEnabled) {
          throw Object.assign(new Error('Cron consumer is disabled for this runtime'), {
            status: 409,
            statusCode: 409,
            code: 'CRON_CONSUMER_DISABLED',
          });
        }
        const key = await resolveMavisCronKeyOrThrow(deps, req.cronId);
        const task = deps.cronRuntime.registry.getTask(key.agentName, key.cronName);
        if (!task) throw mavisCronNotFound(req.cronId);
        const result = await deps.cronRuntime.registry.triggerTask(key.agentName, key.cronName, {
          triggerSource: 'agent_tool',
        });
        return {
          success: result.executed || result.reason === 'enqueued',
          triggeredAt: String(deps.nowMs()),
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        };
      });
    },
    listCronSessions: async (req) => {
      await deps.cronRuntime.ensureStarted('mavis_tool:list_cron_sessions');
      return mapMavisCronErrors(async () => {
        const key = await resolveMavisCronKeyOrThrow(deps, req.cronId);
        const task = deps.cronRuntime.cronConsumerEnabled
          ? deps.cronRuntime.registry.getTask(key.agentName, key.cronName)
          : await getStoredCronTask(deps.cronStore, key.agentName, key.cronName);
        if (!task) throw mavisCronNotFound(req.cronId);
        const history = await deps.cronRuntime.registry.getSessionHistory(
          key.agentName,
          key.cronName,
        );
        const allSessions = await Promise.all(
          history
            .slice()
            .reverse()
            .map(async (record) => {
              const session = await deps.getSessionById(record.sessionId).catch(() => undefined);
              return {
                sessionId: record.sessionId,
                createdAt: record.createdAt,
                ...(session?.title ? { title: session.title } : {}),
                ...(session ? { status: session.status } : {}),
              };
            }),
        );
        const page = pageBySessionCursor(allSessions, req.cursor, req.limit);
        return {
          sessions: page.items,
          total: allSessions.length,
          hasMore: page.hasMore,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      });
    },
  };
}

async function resolveMavisCronKey(
  deps: HostMavisCronDeps,
  cronId: string,
): Promise<CronKey | undefined> {
  return deps.cronStore.resolveKeyByCronId?.(cronId) ?? undefined;
}

async function resolveMavisCronKeyOrThrow(
  deps: HostMavisCronDeps,
  cronId: string,
): Promise<CronKey> {
  const key = await resolveMavisCronKey(deps, cronId);
  if (!key) throw mavisCronNotFound(cronId);
  return key;
}

function mavisCronNotFound(cronId: string): Error & {
  status: number;
  statusCode: number;
  code: string;
} {
  return Object.assign(new Error(`Cron task not found: ${cronId}`), {
    status: 404,
    statusCode: 404,
    code: 'CRON_TASK_NOT_FOUND',
  });
}

function normalizeOnceSession(session: LocalMavisCronCreationSessionTarget) {
  if (session.mode === 'new') return { mode: 'new' as const };
  if (session.sessionId) {
    return { mode: 'sessionId' as const, sessionId: session.sessionId };
  }
  throw Object.assign(new Error('session.session_id is required for sessionId mode'), {
    status: 400,
    statusCode: 400,
    code: 'VALIDATION_ERROR',
  });
}

function toMavisCronTask(state: Parameters<typeof cronStateToCronTask>[0]): LocalMavisCronTask {
  const task = cronStateToCronTask(state);
  const { session: legacySession, model: modelSelection, ...rest } = task;
  const session =
    legacySession?.mode === 'sessionId' && legacySession.sessionId
      ? ({ mode: 'sessionId', sessionId: legacySession.sessionId } as const)
      : legacySession?.mode === 'new'
        ? ({ mode: 'new' } as const)
        : undefined;
  return {
    ...rest,
    ...(modelSelection?.modelId === undefined ? {} : { model: modelSelection.modelId }),
    ...(session ? { session } : {}),
  };
}

function appendQuietOnSkipPromptSuffix(basePrompt: string, quietOnSkip: boolean): string {
  if (!quietOnSkip) return basePrompt;
  return [
    basePrompt.trimEnd(),
    '',
    '---',
    '[gate-discipline] If your guard condition is not met (CI still running, MR not merged, no new evidence), wrap a one-line status in `<mavis-progress>...</mavis-progress>` and exit. The progress tag lets the user glance at "still waiting" without lighting up an unread notification. Do NOT send IMs and do NOT write plain replies on skip ticks.',
  ].join('\n');
}

async function mapMavisCronErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const mapped = toCronContractError(error);
    throw Object.assign(new Error(mapped.message), {
      status: mapped.status,
      code: mapped.code,
    });
  }
}

function pageByCronCursor<T extends { cronId?: string; cronName?: string }>(
  items: T[],
  cursor: string | undefined,
  limit: number | undefined,
): { items: T[]; hasMore: boolean; nextCursor?: string } {
  const start =
    cursor === undefined
      ? 0
      : Math.max(
          0,
          items.findIndex((item) => item.cronId === cursor || item.cronName === cursor) + 1,
        );
  return pageItems(items.slice(start), limit, (item) => item.cronId ?? item.cronName);
}

function pageBySessionCursor<T extends { sessionId?: string }>(
  items: T[],
  cursor: string | undefined,
  limit: number | undefined,
): { items: T[]; hasMore: boolean; nextCursor?: string } {
  const start =
    cursor === undefined
      ? 0
      : Math.max(0, items.findIndex((item) => item.sessionId === cursor) + 1);
  return pageItems(items.slice(start), limit, (item) => item.sessionId);
}

function pageItems<T>(
  items: T[],
  limit: number | undefined,
  cursorFor: (item: T) => string | undefined,
): { items: T[]; hasMore: boolean; nextCursor?: string } {
  if (limit === undefined || limit <= 0) return { items, hasMore: false };
  const page = items.slice(0, limit);
  const hasMore = items.length > limit;
  const lastItem = page.at(-1);
  const nextCursor = hasMore && lastItem ? cursorFor(lastItem) : undefined;
  return {
    items: page,
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
  };
}
