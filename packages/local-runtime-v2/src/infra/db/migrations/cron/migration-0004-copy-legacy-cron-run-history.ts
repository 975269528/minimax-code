import type { MigrationEntry } from '../../migrate.js';
import { copyLegacyCronRunHistory } from './migration-0002-copy-legacy-cron-data.js';

export const migration: MigrationEntry = {
  version: 4,
  name: 'copy-legacy-cron-run-history',
  up(database) {
    copyLegacyCronRunHistory(database, { warnOnOrphanedNativeRows: true });
  },
};
