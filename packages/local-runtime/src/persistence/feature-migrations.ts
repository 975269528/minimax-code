import { BACKGROUND_TASK_MIGRATIONS } from '../background-task/schema.js';
import { CRON_MIGRATIONS } from '../cron/schema.js';
import { QUESTIONNAIRE_MIGRATIONS } from '../questionnaire/schema.js';
import { SESSION_ASSET_MIGRATIONS } from '../session-assets/schema.js';
import type { Migration } from './db.js';

export const FEATURE_MIGRATIONS: Migration[] = [
  ...BACKGROUND_TASK_MIGRATIONS,
  ...QUESTIONNAIRE_MIGRATIONS,
  ...CRON_MIGRATIONS,
  ...SESSION_ASSET_MIGRATIONS,
];
