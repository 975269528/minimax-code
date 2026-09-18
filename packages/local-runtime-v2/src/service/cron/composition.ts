import type { AppDb } from '../../infra/db/client.js';
import type { ScheduledJob, SchedulerClient } from '../../infra/scheduler/index.js';
import { SqliteCronDefinitionRepository } from './adapters/definition.repository.js';
import { createCronMetrics } from './adapters/metrics.client.js';
import { SqliteCronRunRepository } from './adapters/run.repository.js';
import { createCronService } from './orchestration/cron.service.js';
import { CronExecutor, type CronExecutionLogger } from './orchestration/executor.js';
import { CronDataLifecycle } from './orchestration/lifecycle.js';
import {
  CRON_SCHEDULER_HANDLER_KEY,
  type CronDefinitionRepository,
  type CronMetricTask,
  type CronMetrics,
  type CronModelSelectionPort,
  type CronService,
  type CronSessionCreationPort,
  type CronSessionDeliveryPort,
  type CronSessionPorts,
} from './contracts.js';
import { toCronSchedule } from './orchestration/schedule.js';

export interface CronCompositionOptions {
  readonly db: AppDb;
  readonly scheduler: SchedulerClient;
  readonly sessionPorts?: CronSessionPorts;
  readonly nowMs?: () => number;
  readonly executionLogger?: CronExecutionLogger;
  readonly metrics?: CronMetrics;
  readonly modelSelection?: CronModelSelectionPort;
}

export interface CronComposition {
  readonly service: CronService;
  readonly executor: CronExecutor;
  /** True while an active Single task owns this session for its whole lifetime. */
  isSessionOwnedByDefinition(sessionId: string): boolean;
  recoverPendingRuns(): Promise<void>;
  close(): Promise<void>;
}

const NOOP_EXECUTION_LOGGER: CronExecutionLogger = {
  warn: () => undefined,
};

const CRON_EXECUTOR_UNAVAILABLE = 'CRON_EXECUTOR_UNAVAILABLE';

const SOURCE_QUALIFIED_MODEL_SELECTION: CronModelSelectionPort = {
  resolve: (rawModel) => {
    const modelKey = rawModel.trim();
    const separator = modelKey.indexOf('/');
    return separator > 0 && separator < modelKey.length - 1
      ? { kind: 'resolved', modelKey }
      : { kind: 'not_found' };
  },
};

const FAIL_CLOSED_SESSION_CREATION: CronSessionCreationPort = {
  create: () =>
    Promise.reject(new Error('Cron session creation is not available on this runtime host')),
  discard: () => Promise.resolve(),
};

const FAIL_CLOSED_DELIVERY: CronSessionDeliveryPort = {
  deliver: () =>
    Promise.resolve({
      delivered: false,
      errorCode: CRON_EXECUTOR_UNAVAILABLE,
      error: 'Cron delivery is not available on this runtime host',
    }),
};

export function composeCronService(options: CronCompositionOptions): CronComposition {
  const nowMs = options.nowMs ?? Date.now;
  const metrics = options.metrics ?? createCronMetrics();
  const definitions = new SqliteCronDefinitionRepository(options.db);
  const runs = new SqliteCronRunRepository(options.db);
  const lifecycle = new CronDataLifecycle({
    db: options.db,
    scheduler: options.scheduler,
    definitions,
    runs,
  });

  const executor = new CronExecutor({
    db: options.db,
    definitions,
    runs,
    lifecycle,
    sessionCreation: options.sessionPorts?.sessionCreation ?? FAIL_CLOSED_SESSION_CREATION,
    delivery: options.sessionPorts?.delivery ?? FAIL_CLOSED_DELIVERY,
    nowMs,
    logger: options.executionLogger ?? NOOP_EXECUTION_LOGGER,
    metrics,
  });

  options.scheduler.registerHandler(CRON_SCHEDULER_HANDLER_KEY, (schedulerId) => {
    const job = options.scheduler.get(schedulerId);
    if (!job) return;
    const metricTask = resolveScheduledMetricTask(definitions, job);
    const accepted = executor.acceptScheduledTrigger({
      schedulerId,
      triggerId: `${schedulerId}:${job.scheduleGeneration}:${job.runCount}`,
      ...(metricTask ? { triggerMetric: { source: 'schedule', task: metricTask } } : {}),
    });
    if (!accepted.accepted && metricTask) {
      metrics.taskTriggered(
        metricTask,
        'schedule',
        accepted.errorCode === 'CRON_NOT_FOUND' ? 'skipped' : 'error',
      );
    }
    if (!accepted.accepted && accepted.errorCode === 'CRON_PERSIST_FAILED') {
      throw new Error('Cron scheduled trigger persistence failed');
    }
  });

  const service = createCronService({
    lifecycle,
    scheduler: options.scheduler,
    definitions,
    runs,
    executor,
    sessionCreation: options.sessionPorts?.sessionCreation ?? FAIL_CLOSED_SESSION_CREATION,
    nowMs,
    metrics,
    modelSelection: options.modelSelection ?? SOURCE_QUALIFIED_MODEL_SELECTION,
  });
  return {
    service,
    executor,
    isSessionOwnedByDefinition: (sessionId) =>
      hasActiveDefinitionOwningSession(definitions, sessionId),
    recoverPendingRuns: async () => {
      await executor.recoverPendingRuns();
    },
    close: async () => {
      await executor.close();
    },
  };
}

function hasActiveDefinitionOwningSession(
  definitions: CronDefinitionRepository,
  sessionId: string,
): boolean {
  let before: { createdAtMs: number; cronId: string } | undefined;
  do {
    const page = definitions.listPage({
      take: 200,
      ...(before ? { before } : {}),
    });
    if (
      page.some(
        (definition) =>
          definition.sessionTarget.mode === 'sessionId' &&
          definition.sessionTarget.sessionId === sessionId,
      )
    ) {
      return true;
    }
    const last = page.at(-1);
    before =
      page.length === 200 && last
        ? { createdAtMs: last.createdAtMs, cronId: last.cronId }
        : undefined;
  } while (before);
  return false;
}

function resolveScheduledMetricTask(
  definitions: CronDefinitionRepository,
  job: ScheduledJob,
): CronMetricTask | undefined {
  try {
    const definition = definitions.getBySchedulerId(job.schedulerId);
    if (!definition) return undefined;
    return {
      agentName: definition.agentName,
      schedule: toCronSchedule(job.schedule),
      sessionTarget: definition.sessionTarget,
    };
  } catch {
    return undefined;
  }
}
