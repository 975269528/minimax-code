import type { AppDb } from '../../infra/db/client.js';
import type { SchedulerClient } from '../../infra/scheduler/index.js';
import { createCronMetrics } from './adapters/metrics.client.js';
import { composeCronService, type CronComposition } from './composition.js';
import type {
  CronMetrics,
  CronMetricsClient,
  CronModelSelectionPort,
  CronService,
  CronSessionPorts,
} from './contracts.js';

export interface InitializeCronServiceOptions {
  readonly db: AppDb;
  readonly scheduler: SchedulerClient;
  readonly sessionPorts?: CronSessionPorts;
  readonly nowMs?: () => number;
  readonly metrics?: CronMetricsClient;
  readonly modelSelection?: CronModelSelectionPort;
  readonly recoverPendingRuns?: boolean;
}

export interface InitializedCronService {
  readonly service: CronService;
  isSessionOwnedByDefinition(sessionId: string): boolean;
  /** Completes Cron recovery after the shared Scheduler has started. */
  ready(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Initializes the Cron service and registers its Scheduler handler. The caller starts shared
 * background infrastructure before awaiting ready(), preserving the existing start/recovery order.
 */
export function initializeCronService(
  options: InitializeCronServiceOptions,
): InitializedCronService {
  const metrics = createCronMetrics(options.metrics);
  const composition = composeCronService({
    db: options.db,
    scheduler: options.scheduler,
    ...(options.sessionPorts ? { sessionPorts: options.sessionPorts } : {}),
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    metrics,
  });
  let readyPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closePromise ??= composition.close();
    return closePromise;
  };
  const ready = (): Promise<void> => {
    readyPromise ??= reportStartedAndRecover(
      composition,
      metrics,
      options.recoverPendingRuns !== false,
    );
    return readyPromise;
  };

  return {
    service: composition.service,
    isSessionOwnedByDefinition: composition.isSessionOwnedByDefinition,
    ready,
    close,
  };
}

async function reportStartedAndRecover(
  composition: CronComposition,
  metrics: CronMetrics,
  recoverPendingRuns: boolean,
): Promise<void> {
  metrics.engineStarted();
  if (recoverPendingRuns) await composition.recoverPendingRuns();
}
