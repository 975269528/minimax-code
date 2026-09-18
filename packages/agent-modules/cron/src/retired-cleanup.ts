import { logger, backgroundCtx } from './host-utils.js';

/**
 * Cron task names that were once seeded as built-ins but have been removed or
 * migrated. On daemon startup we proactively delete their config files so
 * CronRegistry.start() does not pick them up and schedule ghost executions.
 *
 * - idle-progress-check / hourly-patrol — retired 2026-05-04 (noisy defaults)
 * - skill-evolve-nightly — migrated 2026-05-04 from cron task to internal-skills
 *
 * Keep entries indefinitely (cheap idempotent cleanup; no harm if already gone).
 */
const RETIRED_CRON_NAMES: ReadonlyArray<string> = [
  'idle-progress-check',
  'hourly-patrol',
  'skill-evolve-nightly',
];

export interface RetiredCronFileStore {
  listAgentNames(agentsDir: string): string[];
  removeCronConfig(agentsDir: string, agentName: string, cronName: string): boolean;
  removeLegacyCronDir(agentsDir: string, agentName: string, cronName: string): boolean;
}

const noopRetiredCronFileStore: RetiredCronFileStore = {
  listAgentNames: () => [],
  removeCronConfig: () => false,
  removeLegacyCronDir: () => false,
};

/**
 * Remove retired cron task configs from ALL agents' crons/ directories.
 *
 * Scans every agent subdirectory under agentsDir to ensure retired names
 * are cleaned from non-primary agents too (e.g. if a user copied a cron config
 * to a secondary agent). Handles both current `.md` format and legacy
 * `<name>/config.yaml` directory format.
 *
 * Called once at daemon startup, before CronRegistry.start().
 * Idempotent: missing files are silently ignored.
 */
export async function cleanupRetiredCronTasks(
  agentsDir: string,
  fileStore: RetiredCronFileStore = noopRetiredCronFileStore,
): Promise<void> {
  const ctx = backgroundCtx();
  let removed = 0;

  const agentNames = fileStore.listAgentNames(agentsDir);

  for (const agentName of agentNames) {
    for (const cronName of RETIRED_CRON_NAMES) {
      const removedConfig = fileStore.removeCronConfig(agentsDir, agentName, cronName);
      const removedLegacy = fileStore.removeLegacyCronDir(agentsDir, agentName, cronName);
      const didRemove = removedConfig || removedLegacy;

      if (didRemove) {
        removed++;
        logger.info(
          ctx,
          `[cron] Removed retired cron task: agentName=${agentName} cronName=${cronName}`,
        );
      }
    }
  }

  if (removed > 0) {
    logger.info(ctx, `[cron] Retired cron tasks cleaned: removed=${removed}`);
  }
}
