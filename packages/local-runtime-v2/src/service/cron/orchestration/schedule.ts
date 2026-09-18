import type { Schedule } from '../../../infra/scheduler/index.js';
import type { CronSchedule } from '../contracts.js';

export function toSchedulerSchedule(schedule: CronSchedule): Schedule {
  if (schedule.kind === 'once') return { ...schedule };
  return {
    kind: 'cron',
    expression: schedule.expression,
    ...(schedule.timezone === undefined ? {} : { timezone: schedule.timezone }),
    ...(schedule.maxRuns === undefined ? {} : { maxRuns: schedule.maxRuns }),
  };
}

export function toCronSchedule(schedule: Schedule): CronSchedule {
  if (schedule.kind === 'once') return { ...schedule };
  return {
    kind: 'recurring',
    expression: schedule.expression,
    ...(schedule.timezone === undefined ? {} : { timezone: schedule.timezone }),
    ...(schedule.maxRuns === undefined ? {} : { maxRuns: schedule.maxRuns }),
  };
}
