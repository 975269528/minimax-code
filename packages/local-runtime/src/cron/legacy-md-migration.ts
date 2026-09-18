import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import yaml from 'js-yaml';
import {
  CronConfigSchema,
  CronFrontmatterSchema,
  normalizeSessionConfig,
  type CronConfig,
  type CronRegistryStartOptions,
  type CronStorePort,
} from '@mavis/cron';

import { logger } from '../common/logger.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import type { LocalRuntimeStartupExecutionPolicy } from '../runtime/startup-execution-policy.js';
import { SqliteCronLegacyImportStore, type CronLegacyImportStore } from './legacy-import-store.js';
import {
  backfillCronSessionHistoryFromPurposeSessions,
  SqliteCronDataMigrationStore,
} from './purpose-session-history-backfill.js';

/**
 * One-shot startup migration: import pre-SQLite `.md` cron files into the
 * `local_runtime_crons` table.
 *
 * The pre-SQLite daemon (FsCronStore) stored each cron as
 *   <dataDir>/agents/<agentName>/crons/<cronName>.md
 * — YAML frontmatter (schedule/timezone/session/...) + markdown body (prompt),
 * keyed by filename. The current runtime persists crons in SQLite and never
 * scans those files, so a cron created by an older packaged app is invisible
 * after upgrade.
 *
 * Idempotency lives in the `local_runtime_cron_legacy_imports` marker table,
 * NOT in the filesystem: once a `(agent, cronName)` is recorded there it is
 * never re-imported. This keeps the source `.md` untouched (non-destructive —
 * the old app still reads it) and removes every filesystem-rename failure mode.
 *
 * Safety invariants:
 * - A cron is imported exactly once: the marker is recorded only after the row
 *   is present, and re-runs short-circuit on the marker. Deleting the cron in
 *   the new app does NOT resurrect it (the marker persists).
 * - Files that fail to parse / validate are left untouched and unmarked, so a
 *   later fix is retried on the next launch (they never become invisible,
 *   un-deletable SQLite orphans).
 * - The migration never throws out of this function — per-file failures are
 *   logged and counted so one bad file cannot block cron startup.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\s*\n?([\s\S]*)$/;
/** Cron name charset the API/registry can address — mirror of `CRON_NAME_RE` in `cron/api.ts`. */
const CRON_NAME_RE = /^[^\s/\\:*?"<>|]+$/;

export interface LegacyMdCronMigrationResult {
  imported: number;
  skipped: number;
  failed: number;
}

export interface LegacyMdCronMigrationDeps {
  cronStore: CronStorePort;
  /** Durable record of which `(agent, cronName)` have already been migrated. */
  importStore: CronLegacyImportStore;
  /** `<dataDir>/agents` — root holding per-agent `crons/` directories. */
  agentsDir: string;
  /**
   * Reject a parsed config the registry could not schedule (bad cron
   * expression / timezone). MUST throw when unschedulable. When provided, an
   * unschedulable legacy file is left untouched (not imported, not marked)
   * rather than becoming an invisible SQLite row the registry silently drops.
   */
  assertSchedulable?: (config: CronConfig) => void;
  /** Reject a cron name the API/registry cannot address. Return false to skip. */
  isValidCronName?: (cronName: string) => boolean;
}

interface MigrateOneArgs {
  deps: LegacyMdCronMigrationDeps;
  agentName: string;
  cronName: string;
  filePath: string;
  result: LegacyMdCronMigrationResult;
}

/**
 * Host-wiring entry point: run the legacy `.md` cron migration for the
 * runtime's data dir, then start the registry. Lives here (not in `cron/api.ts`)
 * so the migration glue does not grow api.ts past its pinned layout budget.
 * Reuses the host cron scheduler for the schedulability check and the API
 * cron-name rules.
 */
export function startCronRuntimeWithMigration(
  options: {
    cronStore: CronStorePort;
    dataDir: () => string;
    listAllSessions: (
      agentName?: string,
      options?: { includePurposePrefix?: string; includeHidden?: boolean; limit?: number },
    ) => Promise<LocalSessionRecord[]>;
    startupExecutionPolicy?: LocalRuntimeStartupExecutionPolicy;
  },
  scheduler: { assertSchedulable(config: CronConfig): void },
  registry: { start(options?: CronRegistryStartOptions): Promise<void> },
): Promise<void> {
  return migrateLegacyMdCrons({
    cronStore: options.cronStore,
    importStore: new SqliteCronLegacyImportStore(options.dataDir),
    agentsDir: path.join(options.dataDir(), 'agents'),
    assertSchedulable: (config) => scheduler.assertSchedulable(config),
    isValidCronName: (name) => name.length > 0 && name.length <= 64 && CRON_NAME_RE.test(name),
  })
    .then(() =>
      backfillCronSessionHistoryFromPurposeSessions({
        cronStore: options.cronStore,
        dataMigrationStore: new SqliteCronDataMigrationStore(options.dataDir),
        listAllSessions: options.listAllSessions,
      }),
    )
    .then(() =>
      registry.start({ restoredTaskExecution: options.startupExecutionPolicy ?? 'enabled' }),
    );
}

/**
 * Scan every agent's `crons/` directory and import legacy `.md` crons into
 * SQLite. Never throws.
 */
export async function migrateLegacyMdCrons(
  deps: LegacyMdCronMigrationDeps,
): Promise<LegacyMdCronMigrationResult> {
  const result: LegacyMdCronMigrationResult = { imported: 0, skipped: 0, failed: 0 };

  try {
    const agentNames = await safeReaddir(deps.agentsDir);
    for (const agentName of agentNames) {
      const cronsDir = path.join(deps.agentsDir, agentName, 'crons');
      const entries = await safeReaddir(cronsDir);
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const cronName = entry.slice(0, -'.md'.length);
        const filePath = path.join(cronsDir, entry);
        try {
          await migrateOne({ deps, agentName, cronName, filePath, result });
        } catch (err) {
          result.failed += 1;
          logger.error(
            { agentName, cronName, err: (err as Error).message },
            '[cron-md-migration] Failed to migrate legacy cron file',
          );
        }
      }
    }
  } catch (err) {
    // Defensive: any unexpected top-level failure must not block cron startup.
    logger.error(
      { agentsDir: deps.agentsDir, err: (err as Error).message },
      '[cron-md-migration] Legacy cron migration aborted',
    );
    return result;
  }

  if (result.imported > 0 || result.failed > 0) {
    logger.info(
      { ...result, agentsDir: deps.agentsDir },
      '[cron-md-migration] Legacy .md cron migration complete',
    );
  }
  return result;
}

async function migrateOne(args: MigrateOneArgs): Promise<void> {
  const { deps, agentName, cronName, filePath, result } = args;

  // Already migrated in a prior run — the marker outlives any later delete of
  // the cron, so this is what prevents resurrection.
  if (await deps.importStore.has(agentName, cronName)) {
    result.skipped += 1;
    return;
  }

  const config = parseMdCron(await readFile(filePath, 'utf-8'));
  if (!config) {
    leaveUnmigrated(result, agentName, cronName, 'unparseable frontmatter/body');
    return;
  }
  if (deps.isValidCronName && !deps.isValidCronName(cronName)) {
    leaveUnmigrated(result, agentName, cronName, 'cron name rejected by API rules');
    return;
  }
  if (deps.assertSchedulable) {
    try {
      deps.assertSchedulable(config);
    } catch (err) {
      leaveUnmigrated(result, agentName, cronName, `unschedulable: ${(err as Error).message}`);
      return;
    }
  }

  // create() first, marker second: if we crash between them the next run finds
  // the row via get() and records the marker in the skip branch — idempotent,
  // no duplicate, no loss.
  if (await deps.cronStore.get(agentName, cronName)) {
    // SQLite already owns this name (user-created, or a prior interrupted run).
    // Don't overwrite; just mark the legacy file as handled.
    result.skipped += 1;
  } else {
    await deps.cronStore.create(agentName, cronName, config);
    result.imported += 1;
    logger.info(
      { agentName, cronName, schedule: config.schedule },
      '[cron-md-migration] Imported legacy .md cron into SQLite',
    );
  }
  await deps.importStore.record(agentName, cronName);
}

/** Count + log a legacy file we intentionally left untouched and unmarked. */
function leaveUnmigrated(
  result: LegacyMdCronMigrationResult,
  agentName: string,
  cronName: string,
  reason: string,
): void {
  result.failed += 1;
  logger.warn(
    { agentName, cronName, reason },
    '[cron-md-migration] Leaving invalid legacy cron .md unmigrated (will retry next launch)',
  );
}

/** Parse a legacy `.md` cron file (YAML frontmatter + body prompt). */
function parseMdCron(content: string): CronConfig | undefined {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return undefined;
  const fmRaw = match[1] ?? '';
  const body = (match[2] ?? '').trim();
  if (!body) return undefined; // prompt (body) is required

  let parsedYaml: unknown;
  try {
    parsedYaml = yaml.load(fmRaw);
  } catch {
    return undefined;
  }

  const fm = CronFrontmatterSchema.safeParse(parsedYaml);
  if (!fm.success) return undefined;

  const full = CronConfigSchema.safeParse({ ...fm.data, prompt: body });
  if (!full.success) return undefined;

  // Normalize legacy aliases the same way the old FsCronStore did on read:
  //   - session.mode='main' → 'root' (handled by StoredSessionConfigSchema)
  //   - report_to_main (legacy) → report_to_root when canonical is unset
  const data = full.data;
  return {
    ...data,
    session: normalizeSessionConfig(data.session),
    report_to_root: data.report_to_root ?? data.report_to_main,
    report_to_main: undefined,
  };
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
}
