/**
 * Watch / cron self-reminder interval helpers.
 *
 * Shared between the daemon (server-side resolution for /api/cron/self-reminder),
 * the CLI (mavis cron self), and the UI (/watch slash command). All three layers
 * accept the same surface so users get the same forgiveness.
 *
 * Accepted forms (case-insensitive):
 *   - Natural-language duration:  "30s" | "5m" | "2h" | "1d" | "1w"
 *   - Compound duration:           "1h30m" | "2d12h"
 *   - Raw 5-field cron expression: "* / 5 * * * *" (passes through unchanged)
 *
 * The parser is intentionally minimal — it covers the common self-reminder
 * cases (seconds → days). Anything more exotic should be a raw cron expression.
 */

const SECONDS_PER_UNIT: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

/** Maximum self-reminder TTL allowed by the daemon — 30 days. */
export const MAX_SELF_REMINDER_TTL_SECONDS = 30 * 86400;

/** Default self-reminder TTL when caller omits --ttl. */
export const DEFAULT_SELF_REMINDER_TTL_SECONDS = 14 * 86400;

/** Sentinel TTL meaning "never auto-expire". Caller is responsible for cleanup. */
export const TTL_NEVER = 'never';

export interface ParsedInterval {
  /** A valid 5-field cron expression usable by croner. */
  cronExpr: string;
  /** Approximate seconds between ticks (best-effort, only meaningful for duration input). */
  approxSeconds: number;
  /** Original user input, lowercased and trimmed. */
  raw: string;
}

/**
 * Parse a user-supplied interval string into a cron expression.
 *
 * @throws Error with a user-facing message when the input is unparseable.
 */
export function parseWatchInterval(input: string): ParsedInterval {
  const raw = input.trim().toLowerCase();
  if (!raw) {
    throw new Error('Interval is empty. Try "5m", "30s", or a cron expression.');
  }

  // 5-field cron expressions contain whitespace; pass through after a sanity check.
  if (/\s/.test(raw)) {
    const parts = raw.split(/\s+/);
    if (parts.length < 5 || parts.length > 6) {
      throw new Error(
        `Cannot parse interval "${input}". ` +
          'Expected a duration like "5m" or "1h30m", or a 5-field cron expression like "*/5 * * * *".',
      );
    }
    // We trust croner to reject syntactically wrong cron strings later.
    return { cronExpr: raw, approxSeconds: 0, raw };
  }

  // Compound duration: "1h30m", "2d12h", "30s", "1w" …
  const totalSeconds = parseDurationSeconds(raw, input);

  if (totalSeconds < 1) {
    throw new Error(`Interval must be at least 1 second; got "${input}".`);
  }

  return { cronExpr: secondsToCronExpr(totalSeconds, input), approxSeconds: totalSeconds, raw };
}

/** Convert a compound duration string into total seconds. */
function parseDurationSeconds(raw: string, original: string): number {
  // Match all <number><unit> tuples; reject anything left over.
  const matches: RegExpExecArray[] = [];
  const re = /(\d+)([smhdw])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    matches.push(m);
  }
  if (matches.length === 0) {
    throw new Error(
      `Cannot parse interval "${original}". Use forms like "30s", "5m", "1h30m", or a cron expression.`,
    );
  }
  const consumed = matches.reduce((acc, mm) => acc + mm[0].length, 0);
  if (consumed !== raw.length) {
    throw new Error(
      `Cannot parse interval "${original}". Use forms like "30s", "5m", "1h30m", or a cron expression.`,
    );
  }
  let total = 0;
  for (const mm of matches) {
    const value = parseInt(mm[1]!, 10);
    const unit = mm[2]!;
    const factor = SECONDS_PER_UNIT[unit];
    if (!factor) {
      throw new Error(`Unknown duration unit "${unit}" in "${original}".`);
    }
    total += value * factor;
  }
  return total;
}

/**
 * Best-effort conversion of a fixed-period duration into a 5-field cron
 * expression that croner understands.
 *
 * The cron grammar cannot express arbitrary periods (e.g. "every 47 seconds")
 * with second-level precision, so we approximate to the nearest sensible
 * unit. The tradeoff is acceptable for self-reminders: the user typed "5m" and
 * tolerates the cron form (slash-5 stars) rather than running exactly every
 * 300 000 ms.
 */
function secondsToCronExpr(seconds: number, original: string): string {
  // Sub-minute → use the 6-field form with seconds. croner supports "*/N * * * * *".
  if (seconds < 60) {
    return `*/${seconds} * * * * *`;
  }

  // Whole minutes
  if (seconds % 60 === 0 && seconds < 3600) {
    return `*/${seconds / 60} * * * *`;
  }

  // Whole hours
  if (seconds % 3600 === 0 && seconds < 86400) {
    const hours = seconds / 3600;
    return hours === 1 ? '0 * * * *' : `0 */${hours} * * *`;
  }

  // Whole days
  if (seconds % 86400 === 0) {
    const days = seconds / 86400;
    return days === 1 ? '0 0 * * *' : `0 0 */${days} * *`;
  }

  // Mixed: round down to the nearest whole minute.
  if (seconds < 3600) {
    const mins = Math.max(1, Math.floor(seconds / 60));
    return `*/${mins} * * * *`;
  }
  // For any longer mixed period (e.g. 1h30m), schedule on the hour every N hours,
  // rounded down. Better to fire slightly less often than to silently lose ticks.
  const hours = Math.max(1, Math.floor(seconds / 3600));
  if (hours >= 24) {
    const days = Math.max(1, Math.floor(hours / 24));
    return `0 0 */${days} * *`;
  }
  if (hours === 1) return '0 * * * *';
  return `0 */${hours} * * *`;
}

export interface ParsedTtl {
  /** Seconds until expiry. `null` means "never expires". */
  seconds: number | null;
  /** ISO-like local timestamp at which the reminder expires. `null` for never. */
  expiresAtMs: number | null;
}

/**
 * Parse a TTL string. Accepts the same duration grammar as {@link parseWatchInterval}
 * plus the literal `"never"`.
 *
 * Returns `null`-bearing fields for never; otherwise returns the absolute
 * expiry millis derived from `nowMs`.
 *
 * @throws Error if the TTL exceeds {@link MAX_SELF_REMINDER_TTL_SECONDS} or is malformed.
 */
export function parseSelfReminderTtl(input: string | undefined, nowMs: number): ParsedTtl {
  const raw = (input ?? '').trim().toLowerCase();
  if (!raw) {
    return {
      seconds: DEFAULT_SELF_REMINDER_TTL_SECONDS,
      expiresAtMs: nowMs + DEFAULT_SELF_REMINDER_TTL_SECONDS * 1000,
    };
  }
  if (raw === TTL_NEVER) {
    return { seconds: null, expiresAtMs: null };
  }
  const seconds = parseDurationSeconds(raw, input ?? raw);
  if (seconds < 1) {
    throw new Error(`TTL must be at least 1 second; got "${input}".`);
  }
  if (seconds > MAX_SELF_REMINDER_TTL_SECONDS) {
    throw new Error(
      `TTL must not exceed 30 days (${MAX_SELF_REMINDER_TTL_SECONDS} seconds); got "${input}".`,
    );
  }
  return { seconds, expiresAtMs: nowMs + seconds * 1000 };
}

/**
 * Append a self-cleanup snippet to a self-reminder prompt.
 *
 * The snippet instructs the receiving session to delete itself if the wall
 * clock has passed `expiry.atMs`. We rely on prompt discipline rather than a
 * server-side TTL field so that older daemons (which lack a TTL column) still
 * behave correctly when the prompt fires.
 *
 * Pass `expiry === null` to suppress the snippet (used for `--ttl never`).
 *
 * The `expiry.label` field is the local-time string the receiving session
 * sees inside the prompt body. Callers must format it via
 * `formatLocalDateTime(expiry.atMs)` before passing — this helper does NOT
 * fall back to `toISOString()` because emitting UTC ISO strings into prompts
 * violates AGENTS.md §1's "render local time at the edge" rule.
 */
export function appendTtlPromptSuffix(
  basePrompt: string,
  options: {
    /** When non-null, both ms and label are required (paired); null disables auto-expiry. */
    expiry: { atMs: number; label: string } | null;
    agentName: string;
    cronName: string;
    quietOnSkip: boolean;
  },
): string {
  const lines = [basePrompt.trimEnd()];
  if (options.expiry !== null) {
    lines.push(
      '',
      '---',
      `[self-reminder TTL] This reminder expires at ${options.expiry.label}.`,
      `If \`Date.now() > ${options.expiry.atMs}\`, your first action MUST be to delete this reminder and exit silently:`,
      `use the \`mavis\` tool — run \`cron list\` (agent_name: "${options.agentName}"), find the cron named "${options.cronName}", then run \`cron delete\` with its cron_id.`,
    );
  } else {
    lines.push(
      '',
      '---',
      '[self-reminder] No TTL — you are responsible for deleting this cron via the `mavis` tool (`cron list` → `cron delete`) when the reason is gone.',
    );
  }
  if (options.quietOnSkip) {
    lines.push(
      '',
      '[gate-discipline] If your guard condition is not met (CI still running, MR not merged, ' +
        'no new evidence), wrap a one-line status in `<mavis-progress>...</mavis-progress>` ' +
        'and exit. The progress tag lets the user glance at "still waiting" without ' +
        'lighting up an unread notification. Do NOT send IMs and do NOT write plain replies ' +
        'on skip ticks.',
    );
  }
  return lines.join('\n');
}

/**
 * Generate a short, human-friendly cron name when the caller did not supply one.
 *
 * Uses a 6-character hex token from a passed-in randomness source for testability.
 * The prefix doubles as a hint in the cron list ("watch-..." marks slash-created tasks).
 */
export function generateWatchCronName(prefix: string, randomHex6: string): string {
  if (!/^[0-9a-f]{6}$/i.test(randomHex6)) {
    throw new Error('randomHex6 must be a 6-character hex string');
  }
  return `${prefix}-${randomHex6.toLowerCase()}`;
}
