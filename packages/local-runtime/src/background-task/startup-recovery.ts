import {
  isTerminalTaskStatus,
  type BackgroundTask,
  type BackgroundTaskPatch,
  type TaskStore,
} from './domain.js';
import { logger } from '../common/logger.js';

export interface BackgroundTaskRuntimeOwner {
  readonly ownerId: string;
  isOwnerAlive(ownerId: string): boolean | undefined;
}

type StartupRecoveryOptions = { createdBeforeMs?: number; recoveredTurnIds?: readonly string[] };

interface StartupRecoverySettlement {
  nowMs(): number;
  patchLost(
    task: BackgroundTask,
    patch: Omit<BackgroundTaskPatch, 'status'>,
  ): Promise<{ task: BackgroundTask; patched: boolean }>;
  emitCompleted(task: BackgroundTask, reason: string): Promise<void>;
}

/** Track only unresolved external owners from the startup snapshot; unchanged polls do not repeat full reads. */
export class StartupTaskRecovery {
  private readonly watchedTasks = new Map<string, Set<string>>();
  private options: StartupRecoveryOptions = {};
  private readonly settlement: StartupRecoverySettlement;

  constructor(settlement: StartupRecoverySettlement) {
    this.settlement = settlement;
  }

  hasPending(): boolean {
    return this.watchedTasks.size > 0;
  }

  async collect(
    store: TaskStore,
    options: StartupRecoveryOptions,
    owner?: BackgroundTaskRuntimeOwner,
  ): Promise<BackgroundTask[]> {
    const pending = await store.snapshotPending();
    this.options = options;
    this.watchedTasks.clear();
    return this.select(pending, owner);
  }

  async poll(store: TaskStore, owner: BackgroundTaskRuntimeOwner): Promise<BackgroundTask[]> {
    const refreshOwners = new Set<string>();
    for (const [ownerId, taskIds] of this.watchedTasks) {
      if (owner.isOwnerAlive(ownerId) === false) {
        refreshOwners.add(ownerId);
        continue;
      }
      let pending = false;
      for (const taskId of taskIds) {
        const task = await store.get(taskId);
        if (
          task &&
          !isTerminalTaskStatus(task.status) &&
          task.metadata?.runtimeOwnerId === ownerId
        ) {
          pending = true;
        } else {
          taskIds.delete(taskId);
        }
      }
      if (!pending) refreshOwners.add(ownerId);
    }
    if (refreshOwners.size === 0) return [];
    // Refresh only after an owner exits or all known tasks settle, covering tasks created by that owner after the first snapshot.
    const pending = await store.snapshotPending();
    for (const ownerId of refreshOwners) this.watchedTasks.delete(ownerId);
    return this.select(
      pending.filter((task) => {
        const ownerId = task.metadata?.runtimeOwnerId;
        return typeof ownerId === 'string' && refreshOwners.has(ownerId);
      }),
      owner,
    );
  }

  async settle(
    pending: readonly BackgroundTask[],
    options: { reason?: string; createdBeforeMs?: number } = {},
  ): Promise<BackgroundTask[]> {
    const reason = options.reason ?? 'Local runtime restarted before task completed';
    const lost: BackgroundTask[] = [];
    for (const task of pending) {
      const now = this.settlement.nowMs();
      const patched = await this.settlement.patchLost(task, {
        updatedAt: now,
        endedAt: now,
        lastError: { message: reason, code: 'TASK_LOST_ON_STARTUP' },
      });
      this.settled([patched.task]);
      if (!patched.patched) continue;
      const next = patched.task;
      logStartupLostTask(task, options.createdBeforeMs, now);
      await this.settlement.emitCompleted(next, reason);
      lost.push(next);
    }
    return lost;
  }

  private settled(tasks: readonly BackgroundTask[]): void {
    for (const task of tasks) {
      const ownerId = task.metadata?.runtimeOwnerId;
      if (typeof ownerId !== 'string') continue;
      const ids = this.watchedTasks.get(ownerId);
      ids?.delete(task.taskId);
      if (ids?.size === 0) this.watchedTasks.delete(ownerId);
    }
  }

  private select(
    pending: readonly BackgroundTask[],
    owner?: BackgroundTaskRuntimeOwner,
  ): BackgroundTask[] {
    const recoveredTurns = new Set(this.options.recoveredTurnIds ?? []);
    return pending.filter((task) => {
      if (
        this.options.createdBeforeMs !== undefined &&
        task.createdAt >= this.options.createdBeforeMs
      )
        return false;
      const ownerId = task.metadata?.runtimeOwnerId;
      if (owner && typeof ownerId === 'string' && ownerId !== owner.ownerId) {
        const ids = this.watchedTasks.get(ownerId) ?? new Set<string>();
        ids.add(task.taskId);
        this.watchedTasks.set(ownerId, ids);
      }
      return !owner || isLostRuntimeTask(task, owner, recoveredTurns);
    });
  }
}

function isLostRuntimeTask(
  task: BackgroundTask,
  runtimeOwner: BackgroundTaskRuntimeOwner,
  recoveredTurns: ReadonlySet<string>,
): boolean {
  const ownerId = task.metadata?.runtimeOwnerId;
  if (typeof ownerId === 'string') return runtimeOwner.isOwnerAlive(ownerId) === false;
  // Legacy rows have no owner identity. Only exact recovered Turn evidence
  // permits settlement; age or an idle Session does not prove ownership loss.
  const turnId = task.kind === 'subagent' ? task.metadata?.subTurnId : task.metadata?.turnId;
  if (typeof turnId === 'string' && recoveredTurns.has(turnId)) return true;
  const parentTurnId = task.metadata?.parentTurnId;
  return (
    !task.metadata?.childSessionId &&
    typeof parentTurnId === 'string' &&
    recoveredTurns.has(parentTurnId)
  );
}

function logStartupLostTask(
  task: BackgroundTask,
  createdBeforeMs: number | undefined,
  reconciledAt: number,
): void {
  logger.warn(
    {
      event: 'background_task_reconciled_lost_on_startup',
      taskId: task.taskId,
      ownerSessionId: task.ownerSessionId,
      kind: task.kind,
      priorStatus: task.status,
      taskCreatedAt: task.createdAt,
      taskUpdatedAt: task.updatedAt,
      startupCutoffMs: createdBeforeMs ?? null,
      reconciledAt,
      reasonCode: 'TASK_LOST_ON_STARTUP',
      processPid: process.pid,
      processParentPid: process.ppid,
      processExecPath: process.execPath,
    },
    'Local background task reconciled as lost at startup',
  );
}
