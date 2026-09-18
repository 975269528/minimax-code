import type { GlobalEvent } from '@mavis/shared/global-events';

import type { AppDb } from './infra/db/client.js';
import { EventBus, type EventBusClient } from './infra/event-bus/index.js';
import { createForkWorktreeAdapter } from './infra/git/fork-worktree-adapter.js';
import {
  createProcessLocalRuntimeOwnerIdentity,
  createRuntimeOwnerIdentity,
  type RuntimeOwnerIdentity,
} from './infra/runtime-owner/index.js';
import { Scheduler, type SchedulerClient, type SchedulerOptions } from './infra/scheduler/index.js';
import { pruneTransientStorage } from './infra/storage-retention/index.js';

interface BackgroundRuntimeClients {
  /** Scheduler is an Electron-owned capability; embedded CLI keeps only the event bus. */
  readonly scheduler?: SchedulerClient;
  readonly eventBus: EventBusClient<GlobalEvent>;
  readonly runtimeOwnerIdentity: RuntimeOwnerIdentity;
  readonly forkWorktree: ReturnType<typeof createForkWorktreeAdapter>;
}

export interface CreateBackgroundRuntimeOptions {
  readonly db: AppDb;
  /** Production hosts persist an exact cross-process Runtime instance lease here. */
  readonly dataDir?: string;
  readonly logger?: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
  readonly metrics?: SchedulerOptions['metrics'];
  readonly nowMs?: () => number;
  readonly restorePersistedJobExecution?: boolean;
  /** Disable Electron-only scheduled work for embedded command-line owners. */
  readonly enableScheduler?: boolean;
}

export interface BackgroundRuntime {
  /** Lifecycle-free capabilities borrowed by business services. */
  readonly clients: BackgroundRuntimeClients;
  /** Starts all shared background infrastructure after services register handlers. */
  start(): Promise<void>;
  /** Registers a bounded best-effort task before post-ready maintenance starts. */
  registerMaintenance(name: string, task: () => Promise<unknown>): void;
  /** Starts registered retention only after the product Runtime is ready. */
  startMaintenance(): void;
  /** Stops new background triggers before business services drain their accepted work. */
  stop(): Promise<void>;
  /** Releases every owned infrastructure resource after business services drain. */
  close(): Promise<void>;
}

export async function createBackgroundRuntime(
  options: CreateBackgroundRuntimeOptions,
): Promise<BackgroundRuntime> {
  const runtimeOwnerIdentity = options.dataDir
    ? await createRuntimeOwnerIdentity({ dataDir: options.dataDir })
    : createProcessLocalRuntimeOwnerIdentity();
  let scheduler: Scheduler | undefined;
  let eventBus: EventBus<GlobalEvent>;
  let forkWorktree: ReturnType<typeof createForkWorktreeAdapter>;
  try {
    scheduler =
      options.enableScheduler === false
        ? undefined
        : new Scheduler({
            db: options.db,
            ...(options.metrics ? { metrics: options.metrics } : {}),
            ...(options.nowMs ? { nowMs: options.nowMs } : {}),
          });
    eventBus = new EventBus<GlobalEvent>();
    forkWorktree = createForkWorktreeAdapter({});
  } catch (error) {
    await runtimeOwnerIdentity.close();
    throw error;
  }
  let startPromise: Promise<void> | undefined;
  let maintenancePromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const maintenanceTasks: Array<{ readonly name: string; readonly run: () => Promise<unknown> }> =
    [];
  if (options.dataDir) {
    maintenanceTasks.push({
      name: 'transient-storage-retention',
      run: () => prunePostReadyTransientStorage(options),
    });
  }

  const close = (): Promise<void> => {
    closePromise ??= closeBackgroundInfrastructure();
    return closePromise;
  };
  const stop = (): Promise<void> => {
    stopPromise ??= stopBackgroundInfrastructure();
    return stopPromise;
  };
  const start = (): Promise<void> => {
    startPromise ??= startInfrastructure();
    return startPromise;
  };
  const registerMaintenance = (name: string, task: () => Promise<unknown>): void => {
    if (maintenancePromise) throw new Error('Background maintenance already started');
    maintenanceTasks.push({ name, run: task });
  };
  const startMaintenance = (): void => {
    maintenancePromise ??= runDeferredMaintenance();
  };

  async function runDeferredMaintenance(): Promise<void> {
    await deferMaintenance();
    await runMaintenanceTasks();
  }

  async function runMaintenanceTasks(): Promise<void> {
    await Promise.all(
      maintenanceTasks.map(async ({ name, run }) => {
        try {
          await run();
        } catch (error) {
          options.logger?.warn(
            { error, maintenance: name },
            'local-runtime-v2 background maintenance failed',
          );
        }
      }),
    );
  }

  async function stopBackgroundInfrastructure(): Promise<void> {
    try {
      if (scheduler) scheduler.stop();
    } finally {
      eventBus.close();
    }
  }

  async function closeBackgroundInfrastructure(): Promise<void> {
    let firstError: unknown;
    try {
      await stop();
    } catch (error) {
      firstError = error;
    }
    try {
      await maintenancePromise;
    } catch (error) {
      firstError ??= error;
    }
    try {
      await runtimeOwnerIdentity.close();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) throw firstError;
  }

  async function startInfrastructure(): Promise<void> {
    try {
      if (scheduler) {
        scheduler.start({
          restorePersistedJobExecution: options.restorePersistedJobExecution !== false,
        });
      }
    } catch (error) {
      try {
        await close();
      } catch {
        // Startup cleanup is best effort; the Scheduler failure remains primary.
      }
      throw error;
    }
  }

  return {
    clients: {
      ...(scheduler ? { scheduler } : {}),
      eventBus,
      runtimeOwnerIdentity,
      forkWorktree,
    },
    start,
    registerMaintenance,
    startMaintenance,
    stop,
    close,
  };
}

function deferMaintenance(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function prunePostReadyTransientStorage(
  options: CreateBackgroundRuntimeOptions,
): Promise<void> {
  if (!options.dataDir) return;
  const retention = await pruneTransientStorage({
    dataDir: options.dataDir,
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
  });
  if (retention.logFilesDeleted <= 0 && !retention.retiredContextDebugDeleted) {
    return;
  }
  options.logger?.info({ ...retention }, 'local-runtime-v2 transient storage retention completed');
}
