/**
 * Cron config schemas + types — canonical location.
 *
 * Schemas live in agent-core so cron orchestration logic can validate
 * inputs without crossing the package boundary. Daemon's
 * `store/types.ts` re-exports these names for backward compatibility
 * with API schemas, store impls, and existing tests.
 */

import { z } from 'zod';

export const ActiveHoursSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
  end: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
});

/**
 * Canonical session config schema for **input surfaces** (HTTP API request
 * bodies, CLI parsing). The legacy 'main' alias is rejected here per
 * session-rename narrowing — clients must send 'root'.
 *
 * For reading legacy on-disk cron `.md` files written before the rename,
 * use `StoredSessionConfigSchema` below, which still accepts 'main' and
 * normalizes it to 'root'.
 */
export const SessionConfigSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('root') }),
  z.object({ mode: z.literal('sessionId'), sessionId: z.string().min(1) }),
  z.object({
    mode: z.literal('new'),
    /**
     * How many completed sessions to keep visible per cron task.
     * - undefined (omitted): use default (3)
     * - null: keep all sessions (no archiving)
     * - number >= 1: keep N most recent sessions, archive older ones
     */
    keepSessions: z.number().int().min(1).nullable().optional(),
  }),
]);

/**
 * Storage-side schema: same as input, but additionally accepts the legacy
 * `mode: 'main'` alias and normalizes it to `mode: 'root'` after parse.
 * Used only for reading legacy on-disk cron `.md` files written before the
 * session-rename. Writers always emit canonical `mode: 'root'`.
 */
export const StoredSessionConfigSchema = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('root') }),
    z.object({ mode: z.literal('main') }), // legacy on-disk alias, normalized below
    z.object({ mode: z.literal('sessionId'), sessionId: z.string().min(1) }),
    z.object({
      mode: z.literal('new'),
      keepSessions: z.number().int().min(1).nullable().optional(),
    }),
  ])
  .transform((parsed) => {
    if (parsed.mode === 'main') {
      return { mode: 'root' as const };
    }
    return parsed;
  });

export const DeliveryConfigSchema = z
  .object({
    /** Channel client name to deliver to (e.g., 'my-feishu-bot'). */
    channel: z.string().min(1),
    /** Target chat ID within the channel. */
    chatId: z.string().min(1),
  })
  .optional();

export type DeliveryConfig = z.infer<typeof DeliveryConfigSchema>;

/**
 * Frontmatter-only schema for the new `.md` cron format.
 * The `prompt` field lives in the markdown body, not in frontmatter.
 *
 * Uses `StoredSessionConfigSchema` so that legacy on-disk files written
 * with `session.mode: 'main'` still parse — the schema transforms 'main'
 * to canonical 'root' at parse time. Writers always emit canonical 'root'.
 */
export const CronFrontmatterSchema = z.object({
  name: z.string().optional(),
  disabled: z.boolean().default(false),
  schedule: z.string().min(1),
  scheduleType: z.enum(['cron', 'once']).default('cron'),
  runAtMs: z.number().int().positive().optional(),
  deleteAfterRun: z.boolean().optional(),
  timezone: z.string().optional(),
  activeHours: ActiveHoursSchema.optional(),
  session: StoredSessionConfigSchema.default({ mode: 'new' }),
  /** @deprecated Legacy IM auto-delivery preference; never writes to Root. */
  report_to_root: z.boolean().optional(),
  /** @deprecated Legacy IM auto-delivery preference; never writes to Root. */
  report_to_main: z.boolean().optional(),
});

export const CronConfigSchema = z.object({
  disabled: z.boolean().default(false),
  schedule: z.string().min(1),
  scheduleType: z.enum(['cron', 'once']).default('cron'),
  runAtMs: z.number().int().positive().optional(),
  deleteAfterRun: z.boolean().optional(),
  timezone: z.string().optional(),
  activeHours: ActiveHoursSchema.optional(),
  prompt: z.string().min(1),
  session: StoredSessionConfigSchema.default({ mode: 'new' }),
  delivery: DeliveryConfigSchema,
  /** @deprecated Legacy IM auto-delivery preference; never writes to Root. */
  report_to_root: z.boolean().optional(),
  /** @deprecated Legacy IM auto-delivery preference; never writes to Root. */
  report_to_main: z.boolean().optional(),
});

export type CronFrontmatter = z.infer<typeof CronFrontmatterSchema>;
export type CronConfig = z.infer<typeof CronConfigSchema>;
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type ActiveHoursConfig = z.infer<typeof ActiveHoursSchema>;

export type CronConfigUpdate = Partial<{
  disabled: boolean;
  schedule: string;
  scheduleType: 'cron' | 'once';
  runAtMs: number | null;
  deleteAfterRun: boolean | null;
  timezone: string | null;
  activeHours: ActiveHoursConfig | null;
  prompt: string;
  session: SessionConfig;
  delivery: DeliveryConfig | null;
  /** @deprecated Legacy IM auto-delivery preference; never writes to Root. */
  report_to_root: boolean | null;
  /** @deprecated Legacy IM auto-delivery preference; never writes to Root. */
  report_to_main: boolean | null;
}>;

/**
 * Normalize a SessionConfig.
 *
 * Post session-rename narrowing: this is an identity function. Both
 * `SessionConfigSchema` (input) and `StoredSessionConfigSchema` (storage,
 * via `.transform()`) already produce a `SessionConfig` whose `mode` is
 * never 'main'. Kept as a thin helper for callers that want a clear
 * "I assume this is normalized" assertion site.
 */
export function normalizeSessionConfig(cfg: SessionConfig): SessionConfig {
  return cfg;
}

/**
 * Read the retired root-report flag from legacy config. The executor uses it
 * only to preserve existing bound-channel auto-delivery opt-in/opt-out state.
 */
export function resolveReportToRoot(cfg: {
  report_to_root?: boolean | null;
  report_to_main?: boolean | null;
}): boolean | null | undefined {
  if (cfg.report_to_root !== undefined) return cfg.report_to_root;
  return cfg.report_to_main;
}

// ─── Runtime task state types (consumed by registry + executor) ──────────

export type CronExecutionStatus = 'idle' | 'running' | 'skipped';

/** Runtime state for a registered cron task. */
export interface CronTaskState {
  agentName: string;
  cronName: string;
  config: CronConfig;
  /**
   * Stable cron identifier minted/persisted by the store, aligning the local
   * runtime with the archon_biz cron contract (mutations key on cron_id).
   * Optional so hosts/stores that do not persist a cron_id yet still satisfy
   * the type; the engine continues to key on (agentName, cronName).
   */
  cronId?: string;
  enabled: boolean;
  /** Unix-ms timestamp of the last run, or null if never run. */
  lastRun: number | null;
  lastResult: 'success' | 'error' | 'skipped' | null;
  lastError: string | null;
  /** Unix-ms timestamp of the next scheduled run, or null. */
  nextRun: number | null;
  status: CronExecutionStatus;
}

/** API response type. */
export interface CronTaskResponse {
  cronName: string;
  agentName: string;
  /**
   * Stable cron identifier (cron_id). Optional until every store/host
   * persists it; surfaced for observability and to let Step 2 address crons
   * by id without changing engine key control here.
   */
  cronId?: string;
  schedule: string;
  scheduleType?: 'cron' | 'once';
  runAtMs?: number;
  deleteAfterRun?: boolean;
  timezone: string | undefined;
  enabled: boolean;
  prompt: string;
  session: SessionConfig;
  delivery: DeliveryConfig | undefined;
  /** Retired compatibility field; current hosts return false. */
  reportToRoot: boolean;
  /** @deprecated Retired compatibility alias; current hosts return false. */
  reportToMain: boolean;
  activeHours: ActiveHoursConfig | undefined;
  status: CronExecutionStatus;
  /** Unix-ms timestamp of the last run, or null if never run. */
  lastRun: number | null;
  lastResult: string | null;
  lastError: string | null;
  /** Unix-ms timestamp of the next scheduled run, or null. */
  nextRun: number | null;
}
