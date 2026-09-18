import type { MigrationEntry } from '../../migrate.js';

export const migration: MigrationEntry = {
  version: 3,
  name: 'add_scheduler_schedule_generation',
  up: (database) => {
    const columns = database.prepare('PRAGMA table_info(local_runtime_v2_scheduler_jobs)').all();
    if (columns.some(isScheduleGenerationColumn)) return;

    database.exec(`
      ALTER TABLE local_runtime_v2_scheduler_jobs
      ADD COLUMN schedule_generation INTEGER NOT NULL DEFAULT 0
      CHECK (schedule_generation >= 0);
    `);
  },
};

function isScheduleGenerationColumn(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    value.name === 'schedule_generation'
  );
}
