import type { AppDb } from '../../../infra/db/client.js';
import type { ScheduledJob, SchedulerClient } from '../../../infra/scheduler/index.js';
import {
  CRON_SCHEDULER_HANDLER_KEY,
  type CreateCronDefinitionInput,
  type CronDefinitionRecord,
  type CronDefinitionRepository,
  type CronRun,
  type CronRunRepository,
  type DeleteCronDefinitionInput,
  type UpdateCronDefinitionInput,
} from '../contracts.js';
import { CronRepositoryError } from '../errors.js';
import { toCronSchedule, toSchedulerSchedule } from './schedule.js';

export interface CronDataLifecycleDependencies {
  readonly db: AppDb;
  readonly scheduler: SchedulerClient;
  readonly definitions: CronDefinitionRepository;
  readonly runs: CronRunRepository;
}

export class CronDataLifecycle {
  constructor(private readonly dependencies: CronDataLifecycleDependencies) {}

  create(input: CreateCronDefinitionInput): CronDefinitionRecord {
    let schedulerId: string | undefined;
    try {
      return this.immediate(() => {
        schedulerId = this.dependencies.scheduler.schedule(
          CRON_SCHEDULER_HANDLER_KEY,
          toSchedulerSchedule(input.schedule),
        );
        if (input.active === false) this.dependencies.scheduler.cancel(schedulerId);
        return this.dependencies.definitions.insert({
          ...(input.cronId ? { cronId: input.cronId } : {}),
          schedulerId,
          agentName: input.agentName,
          name: input.name,
          prompt: input.prompt,
          sessionTarget: input.sessionTarget,
          ...(input.project === undefined ? {} : { project: input.project }),
          ...(input.model === undefined ? {} : { model: input.model }),
          createdAtMs: input.nowMs,
        });
      });
    } catch (error) {
      if (schedulerId) this.discardSchedulerJob(schedulerId);
      throw error;
    }
  }

  get(cronId: string, includeDeleted = false): CronDefinitionRecord | undefined {
    return this.dependencies.definitions.get(cronId, includeDeleted);
  }

  update(input: UpdateCronDefinitionInput): CronDefinitionRecord {
    return this.immediate(() => {
      const definition = requireDefinition(this.dependencies.definitions.get(input.cronId));
      const job = requireSchedulerJob(this.dependencies.scheduler.get(definition.schedulerId));
      if (input.project !== undefined) {
        if (this.dependencies.runs.listPage({ cronId: input.cronId, take: 1 }).length > 0) {
          throw new CronRepositoryError(
            'CRON_INVALID_STATE',
            'Cron project can only change before its first run',
          );
        }
      }
      const hasDefinitionPatch =
        input.name !== undefined ||
        input.prompt !== undefined ||
        input.sessionTarget !== undefined ||
        input.model !== undefined ||
        input.project !== undefined;
      const updatedDefinition = hasDefinitionPatch
        ? this.dependencies.definitions.update(
            input.cronId,
            definition.revision,
            definitionPatch(input),
            input.nowMs,
          )
        : definition;

      this.updateSchedulerJob(job, input);
      return updatedDefinition;
    });
  }

  delete(input: DeleteCronDefinitionInput): void {
    this.immediate(() => {
      const definition = requireDefinition(this.dependencies.definitions.get(input.cronId));
      requireSchedulerJob(this.dependencies.scheduler.get(definition.schedulerId));

      if (input.deleteRuns ?? true) {
        if (this.dependencies.runs.hasPendingForCronId(input.cronId)) {
          throw new CronRepositoryError('CRON_INVALID_STATE', 'Cron definition has pending runs');
        }
        this.dependencies.runs.deleteByCronId(input.cronId);
        if (!this.dependencies.definitions.hardDelete(input.cronId)) {
          throw new Error('Cron definition delete failed');
        }
        if (!this.dependencies.scheduler.remove(definition.schedulerId)) {
          throw new Error('Scheduler job delete failed');
        }
        return;
      }

      this.dependencies.definitions.tombstone(input.cronId, definition.revision, input.nowMs);
      this.dependencies.scheduler.cancel(definition.schedulerId);
    });
  }

  createManualRun(cronId: string, nowMs: number, requestId?: string): CronRun {
    // Scheduler state only controls automatic dispatch. An explicit user run
    // remains available for paused and expired definitions; the repository
    // still rejects missing or tombstoned definitions atomically.
    return this.dependencies.runs.insertPendingManualForDefinition(cronId, nowMs, requestId);
  }

  private updateSchedulerJob(job: ScheduledJob, input: UpdateCronDefinitionInput): void {
    if (input.schedule === undefined && input.active === undefined) return;

    const schedule = input.schedule ?? toCronSchedule(job.schedule);
    const shouldBeActive = input.active ?? job.state === 'active';
    if (input.schedule !== undefined || (shouldBeActive && job.state !== 'active')) {
      this.dependencies.scheduler.reschedule(job.schedulerId, toSchedulerSchedule(schedule));
    }
    if (!shouldBeActive) this.dependencies.scheduler.cancel(job.schedulerId);
  }

  private discardSchedulerJob(schedulerId: string): void {
    try {
      this.dependencies.scheduler.remove(schedulerId);
    } catch {
      // Preserve the original creation failure.
    }
  }

  private immediate<T>(operation: () => T): T {
    return this.dependencies.db.transaction(operation, { behavior: 'immediate' });
  }
}

function definitionPatch(input: UpdateCronDefinitionInput) {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.sessionTarget === undefined ? {} : { sessionTarget: input.sessionTarget }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.project === undefined ? {} : { project: input.project }),
  };
}

function requireDefinition(definition: CronDefinitionRecord | undefined): CronDefinitionRecord {
  if (!definition) {
    throw new CronRepositoryError('CRON_NOT_FOUND', 'Cron definition not found');
  }
  return definition;
}

function requireSchedulerJob(job: ScheduledJob | undefined): ScheduledJob {
  if (!job) {
    throw new CronRepositoryError('CRON_NOT_FOUND', 'Cron definition has no Scheduler job');
  }
  return job;
}
