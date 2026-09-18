import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DataDirInput } from '../persistence/layout/v2-paths.js';
import { imLogger as logger } from '../common/im-logger.js';

/**
 * Inbound IM attachment download retries + dead-letter queue (P2-B, scheme §5.2).
 *
 * Downloads for Feishu / Telegram / WeChat iLink have two independent reliability mechanisms:
 * 1. **Retries** (`withRetry`): Wrap one download with exponential backoff, defaulting to three
 *   attempts with 500/1500/5000 ms delays. HTTP 4xx errors are permanent; retry network
 *   interruptions, 5xx, and timeouts so transient failures recover without manual intervention.
 * 2. **Dead-letter queue** (`LocalDeadLetterStore`): After retries fail, write platform / session /
 *   message / error chain / final error to
 *   `<dataDir>/tmp/im-attachments/dead-letter/{ts}-{platform}-{refKind}.json`. This directory is
 *   **excluded** from `LocalAttachmentCleanup` and retained for diagnosis. `record()` is
 *   fire-and-forget: write failures are logged, never thrown, so DLQ failures cannot block message
 *   dispatch.
 *
 * All three downloaders share this retry + DLQ contract, while each owns its HTTP endpoints,
 * authentication, and AES decryption.
 */

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/**
 * Retry controls.
 *
 * - `maxAttempts`: Total attempts, including the initial one; defaults to 3.
 * - `backoffMs`: Delays before retries in milliseconds; length should be >= `maxAttempts - 1`.
 *   Defaults to `[500, 1500, 5000]`, covering interruptions within 8 seconds.
 * - `retryableErrors`: Allowlist of retryable patterns matched as case-insensitive substrings of
 *   `err.message` or `err.code`. Default `undefined` means all errors except 4xx are retryable.
 * - `isPermanentError`: Optional custom classifier; true means no retry (e.g. business errors such
 *   as 401/403/404). Defaults to HTTP 4xx detection.
 */
export interface RetryOptions {
  maxAttempts?: number;
  backoffMs?: number[];
  /**
   * Error-keyword allowlist: a match in either `err.message` or `err.code` makes the error
   * retryable. If omitted, retry non-4xx errors by default.
   */
  retryableErrors?: string[];
  /** Custom permanent-error classifier; true stops retries. */
  isPermanentError?: (err: unknown) => boolean;
  /** Inject a sleep function for tests; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Inject a clock for tests, affecting only logs and event chains; defaults to `Date.now`. */
  nowMs?: () => number;
  /**
   * Per-failure callback for logging / metrics; does not affect retry decisions. `attempt` starts
   * at 1.
   */
  onAttemptFailed?: (err: unknown, attempt: number, nextDelayMs: number | null) => void;
}

const DEFAULT_BACKOFF_MS = [500, 1500, 5000];

/**
 * Determine whether an error is retryable:
 * - Custom `isPermanentError` matches → false.
 * - Nonempty `retryableErrors`: A case-insensitive keyword matches `err.message` or `err.code` →
 *   true; otherwise false.
 * - No `retryableErrors`: HTTP 4xx → false; everything else (5xx, network, unknown) → true.
 */
function isRetryableError(
  err: unknown,
  opts: Required<Pick<RetryOptions, 'retryableErrors' | 'isPermanentError'>>,
): boolean {
  if (opts.isPermanentError(err)) return false;
  if (opts.retryableErrors && opts.retryableErrors.length > 0) {
    return matchesAnyKeyword(err, opts.retryableErrors);
  }
  return !isLikely4xxHttpError(err);
}

function matchesAnyKeyword(err: unknown, keywords: string[]): boolean {
  const haystacks: string[] = [];
  if (err instanceof Error) haystacks.push(err.message);
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string') haystacks.push(code);
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number' || typeof status === 'string') haystacks.push(String(status));
  const statusCode = (err as { statusCode?: unknown })?.statusCode;
  if (typeof statusCode === 'number' || typeof statusCode === 'string') {
    haystacks.push(String(statusCode));
  }
  for (const kw of keywords) {
    const needle = kw.toLowerCase();
    for (const hay of haystacks) {
      if (hay.toLowerCase().includes(needle)) return true;
    }
  }
  return false;
}

/**
 * Heuristically identify HTTP 4xx errors (business failures that should not retry). Inspect only
 * `status` / `statusCode`, not message text, to avoid false matches such as "5xx in body".
 */
function isLikely4xxHttpError(err: unknown): boolean {
  const status = readNumericStatus(err);
  if (status === null) return false;
  return status >= 400 && status < 500;
}

function readNumericStatus(err: unknown): number | null {
  const candidates = [
    (err as { status?: unknown })?.status,
    (err as { statusCode?: unknown })?.statusCode,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c >= 100 && c < 1000) {
      return c;
    }
    if (typeof c === 'string') {
      const n = Number(c);
      if (Number.isFinite(n) && n >= 100 && n < 1000) return n;
    }
  }
  return null;
}

/**
 * Package an error into a structured record for DLQ persistence and logs.
 */
export interface RetryAttemptRecord {
  attempt: number;
  message: string;
  code?: string;
  status?: number;
}

/**
 * Final-result callback signature for `withRetry`. `attempt` is one-based and equals `maxAttempts`
 * on the last failed attempt.
 */
export type OnDeadLetterCallback = (
  err: unknown,
  attempt: number,
  chain: RetryAttemptRecord[],
) => void | Promise<void>;

/**
 * Wrap a Promise-returning download function with exponential-backoff retries.
 *
 * - `fn` resolves: Return its result.
 * - `fn` rejects: Classify retryability.
 *   - Permanent: Throw immediately as the final failure.
 *   - Retryable, below limit: Wait `backoffMs[attempt-1]`, then retry.
 *   - Retryable, at limit: Call `onDeadLetter` if supplied, then throw.
 *
 * Exceptions from `onDeadLetter` **never** propagate: swallow and log them, honoring the
 * fire-and-forget requirement that DLQ failures cannot block the main flow.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
  onDeadLetter?: OnDeadLetterCallback,
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep: (ms: number) => Promise<void> =
    opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowMs = opts.nowMs ?? Date.now;

  const chain: RetryAttemptRecord[] = [];
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      chain.push(toAttemptRecord(err, attempt));

      const retryable = isRetryableError(err, {
        retryableErrors: opts.retryableErrors ?? [],
        isPermanentError: opts.isPermanentError ?? (() => false),
      });

      const hasMoreAttempts = attempt < maxAttempts;
      const nextDelayMs =
        hasMoreAttempts && retryable ? (backoff[attempt - 1] ?? backoff.at(-1)!) : null;

      opts.onAttemptFailed?.(err, attempt, nextDelayMs);

      if (!retryable || !hasMoreAttempts) {
        // Terminal condition: permanent error or exhausted attempts.
        if (onDeadLetter) {
          try {
            await onDeadLetter(err, attempt, chain);
          } catch (dlqErr) {
            // DLQ callback failures must never block the main flow; log only.
            logger.error(
              { err: dlqErr, attempt, ts: nowMs() },
              'Attachment dead-letter callback failed',
            );
          }
        }
        throw err;
      }

      // Retryable with attempts remaining: back off and continue.
      if (typeof nextDelayMs === 'number' && nextDelayMs > 0) {
        await sleep(nextDelayMs);
      }
    }
  }

  // Defensive: unreachable in theory because the loop returns or throws; throw again as a safeguard.
  // eslint-disable-next-line @typescript-eslint/no-throw-literal
  throw lastErr;
}

function toAttemptRecord(err: unknown, attempt: number): RetryAttemptRecord {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown })?.code;
  const status = readNumericStatus(err) ?? undefined;
  return {
    attempt,
    message,
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof status === 'number' ? { status } : {}),
  };
}

// ---------------------------------------------------------------------------
// Dead-letter queue
// ---------------------------------------------------------------------------

export type DeadLetterPlatform = 'feishu' | 'telegram' | 'wechat';
export type DeadLetterRefKind = 'image' | 'file' | 'video' | 'voice';

/**
 * Dead-letter record for an inbound attachment download that still failed after retries.
 *
 * - `ts`: Persistence timestamp in milliseconds, used for filename sorting and `since` filtering.
 * - `platform` / `refKind`: Platform and kind for filtering.
 * - `sessionId` / `messageId`: Locate the original conversation and message context.
 * - `refKey`: Platform opaque id (Feishu fileKey / Telegram file_id / WeChat encrypt_query_param).
 * - `errorChain`: Snapshot of each failure (attempt / message / code / status), helping compare
 *   first and final failures.
 * - `finalError`: Final failure message.
 */
export interface DeadLetterEntry {
  ts: number;
  platform: DeadLetterPlatform;
  sessionId: string;
  messageId: string;
  refKind: DeadLetterRefKind;
  refKey: string;
  errorChain: RetryAttemptRecord[];
  finalError: string;
}

export interface LocalDeadLetterStoreOptions {
  dataDir: DataDirInput;
  /** Custom clock; defaults to `Date.now`. */
  nowMs?: () => number;
  /** Custom logger; defaults to the local-runtime logger facade. */
  logger?: LocalDeadLetterLogger;
}

export interface LocalDeadLetterLogger {
  error(message: string, err?: unknown): void;
}

export interface DeadLetterListFilter {
  sessionId?: string;
  platform?: DeadLetterPlatform;
  /** Return only records with ts >= since. */
  since?: number;
}

/**
 * Dead-letter queue persistence.
 *
 * - `record(entry)`: Write
 *   `<dataDir>/tmp/im-attachments/dead-letter/{ts}-{platform}-{refKind}.json`. Swallow and log all
 *   mkdir / writeFile / JSON.stringify failures. This directory is **excluded** from
 *   `LocalAttachmentCleanup` so failure records remain available for diagnosis.
 * - `list(filter)`: Return all dead-letter records newest first, optionally filtered by sessionId /
 *   platform / since.
 */
export class LocalDeadLetterStore {
  private readonly dataDir: () => string;
  private readonly nowMs: () => number;
  private readonly logger: LocalDeadLetterLogger;

  constructor(options: LocalDeadLetterStoreOptions) {
    this.dataDir =
      typeof options.dataDir === 'function'
        ? (options.dataDir as () => string)
        : () => options.dataDir as string;
    this.nowMs = options.nowMs ?? Date.now;
    this.logger = options.logger ?? consoleDeadLetterLogger();
  }

  /** Dead-letter root directory: same root as the attachment scratch area, but a separate path. */
  deadLetterDir(): string {
    return join(this.dataDir(), 'tmp', 'im-attachments', 'dead-letter');
  }

  /**
   * Write one dead-letter record. **Never throw on any failure** (fire-and-forget):
   * - mkdir failure → log error and return.
   * - JSON.stringify failure (unlikely, but possible with cycles) → log error and return.
   * - writeFile failure (full disk / permissions) → log error and return.
   * This contract prevents DLQ failures from blocking message dispatch.
   */
  async record(entry: Omit<DeadLetterEntry, 'ts'> & { ts?: number }): Promise<void> {
    const ts = entry.ts ?? this.nowMs();
    const full: DeadLetterEntry = { ...entry, ts };
    const dir = this.deadLetterDir();
    const filename = composeDeadLetterFilename(full);
    const fullPath = join(dir, filename);

    try {
      await mkdir(dir, { recursive: true });
      const json = JSON.stringify(full, null, 2);
      await writeFile(fullPath, json, 'utf8');
    } catch (err) {
      this.logger.error(
        `[attachment-retry] ${ts} failed to persist dead-letter for ${entry.platform}/${entry.refKind} (sessionId=${entry.sessionId}, messageId=${entry.messageId})`,
        err,
      );
      // Best-effort cleanup: remove zero-byte files left by failed writes to avoid confusing later scans.
      try {
        await rm(fullPath, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Return all dead-letter records by descending ts, optionally filtering by sessionId / platform /
   * since. Skip and log corrupt JSON files without throwing.
   */
  async list(filter: DeadLetterListFilter = {}): Promise<DeadLetterEntry[]> {
    const dir = this.deadLetterDir();
    let files: string[];
    try {
      const entries = await readdir(dir);
      files = entries.filter((f) => f.endsWith('.json'));
    } catch (err) {
      // Missing directory means no records yet.
      const code = (err as { code?: string })?.code;
      if (code === 'ENOENT') return [];
      this.logger.error(`[attachment-retry] cannot list dead-letter dir ${dir}`, err);
      return [];
    }

    const results: DeadLetterEntry[] = [];
    for (const file of files) {
      const fullPath = join(dir, file);
      try {
        const raw = await (await import('node:fs/promises')).readFile(fullPath, 'utf8');
        const parsed = JSON.parse(raw) as DeadLetterEntry;
        if (!parsed || typeof parsed !== 'object') continue;
        if (!matchesFilter(parsed, filter)) continue;
        results.push(parsed);
      } catch (err) {
        this.logger.error(`[attachment-retry] failed to parse dead-letter file ${fullPath}`, err);
      }
    }

    results.sort((a, b) => b.ts - a.ts);
    return results;
  }
}

function matchesFilter(entry: DeadLetterEntry, filter: DeadLetterListFilter): boolean {
  if (filter.sessionId && entry.sessionId !== filter.sessionId) return false;
  if (filter.platform && entry.platform !== filter.platform) return false;
  if (typeof filter.since === 'number' && entry.ts < filter.since) return false;
  return true;
}

function composeDeadLetterFilename(entry: DeadLetterEntry): string {
  const safeKey = entry.refKey.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 32) || 'unknown';
  return `${entry.ts}-${entry.platform}-${entry.refKind}-${safeKey}.json`;
}

function consoleDeadLetterLogger(): LocalDeadLetterLogger {
  return {
    error: (message, err) => {
      logger.error({ err, message }, 'Attachment dead-letter store failed');
    },
  };
}

// ---------------------------------------------------------------------------
// Downloader-side helpers
// ---------------------------------------------------------------------------

/**
 * Build a callback for a download that succeeded but should still be recorded in the dead-letter
 * queue.
 *
 * Wrap `LocalDeadLetterStore.record` and the retry chain, capturing required DLQ fields (platform /
 * sessionId / messageId / refKind / refKey) outside the callback. Downloaders only need `const
 * onDead = makeDeadLetterCallback(store, ...)`, then `withRetry(fn, retryOpts, onDead)`.
 *
 * The returned callback **swallows** errors from `record` without duplicate logging, since
 * `withRetry` already provides a fallback.
 */
export function makeDeadLetterCallback(
  store: LocalDeadLetterStore | undefined,
  meta: Omit<DeadLetterEntry, 'ts' | 'errorChain' | 'finalError'>,
): OnDeadLetterCallback {
  if (!store) {
    return () => {
      /* no DLQ configured — silent */
    };
  }
  return (err, _attempt, chain) => {
    const finalError = err instanceof Error ? err.message : String(err);
    return Promise.resolve(
      store.record({
        ...meta,
        errorChain: chain,
        finalError,
      }),
    ).catch(() => {
      /* `record` is already fire-and-forget; swallowing again here is defensive. */
    });
  };
}
