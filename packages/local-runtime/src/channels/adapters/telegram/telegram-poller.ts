/**
 * Telegram Bot API long-poll loop.
 *
 * Bot API `getUpdates` is the only inbound mechanism that works for a
 * desktop client without exposing a public webhook URL (the dual mechanism,
 * `setWebhook`, requires HTTPS reachable from telegram.org). We long-poll
 * with `timeout=25` so each call holds the connection up to 25s server-side
 * before responding, then immediately re-issue with the new offset.
 *
 * Design mirrors the historical iLink monitor in
 * `apps/electron/main/modules/imGateway/wechat-sdk/ilink-monitor.ts` ported
 * to the Telegram Bot API surface:
 *   - EventEmitter so the adapter wires `on('message', ...)` symmetrically
 *     with WeChat (`WeChatMonitorHandle`).
 *   - start() / stop() / isRunning() lifecycle; start() is idempotent.
 *   - AbortController for graceful shutdown; in-flight fetch is aborted.
 *   - Persistent `offset` cursor (the next update_id we have NOT yet seen).
 *
 * Error handling:
 *   - 401 (token invalid)  → emit('error', TELEGRAM_TOKEN_INVALID) + stop()
 *   - 409 (conflict)       → classify by Bot API `description`, then back off
 *                            and RETRY (never fatal — a 409 is transient):
 *                              · "...webhook is active / is currently set" →
 *                                best-effort `deleteWebhook`, then retry
 *                                (TELEGRAM_WEBHOOK_CONFLICT)
 *                              · "terminated by other getUpdates request" →
 *                                another consumer / a stale long-poll from a
 *                                previous instance is still held server-side;
 *                                back off and retry once it clears
 *                                (TELEGRAM_POLL_CONFLICT)
 *                            Permanently stopping on a single transient 409
 *                            silently kills inbound after any network flap or
 *                            brief restart overlap, so we keep the loop alive.
 *   - 429 (rate limit)     → respect `retry_after`, then continue
 *   - network / 5xx        → exponential backoff (2s, 4s, 8s, capped 30s),
 *                            up to MAX_CONSECUTIVE_FAILURES before
 *                            emit('error') + back to retry
 *
 * No platform adapter imports — keeps the poller usable from any module
 * without dragging the LocalTelegramChannelAdapter into the import graph.
 */
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LONG_POLL_TIMEOUT_SECONDS = 25;
const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const RATE_LIMIT_FALLBACK_MS = 5_000;

const TELEGRAM_API_HOST = 'https://api.telegram.org';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TelegramPollerEvents {
  /** A raw Bot API `Update` object. The adapter is responsible for parsing. */
  update: [update: Record<string, unknown>];
  /** Aggregate error event. The adapter logs; severity already classified. */
  error: [err: TelegramPollerError];
  /** Lifecycle: 'starting' | 'polling' | 'backoff' | 'stopped'. */
  status: [status: TelegramPollerStatus];
}

export type TelegramPollerStatus = 'starting' | 'polling' | 'backoff' | 'stopped';

export type TelegramPollerErrorKind =
  | 'TELEGRAM_TOKEN_INVALID'
  | 'TELEGRAM_WEBHOOK_CONFLICT'
  | 'TELEGRAM_POLL_CONFLICT'
  | 'TELEGRAM_RATE_LIMITED'
  | 'TELEGRAM_NETWORK_ERROR'
  | 'TELEGRAM_SERVER_ERROR';

export class TelegramPollerError extends Error {
  readonly kind: TelegramPollerErrorKind;
  readonly retryable: boolean;
  constructor(kind: TelegramPollerErrorKind, message: string, retryable: boolean) {
    super(message);
    this.name = 'TelegramPollerError';
    this.kind = kind;
    this.retryable = retryable;
  }
}

export interface TelegramPollerOptions {
  botToken: string;
  /** Initial offset (next update_id). Defaults to 0 = "from latest pending". */
  initialOffset?: number;
  /** Allowed update types (Bot API `allowed_updates` param). */
  allowedUpdates?: string[];
  /** Injected for tests; defaults to global `fetch`. */
  fetcher?: typeof fetch;
  /** Injected for tests; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Override host for tests. */
  apiHost?: string;
}

// ---------------------------------------------------------------------------
// TelegramPoller
// ---------------------------------------------------------------------------

export class TelegramPoller extends EventEmitter<TelegramPollerEvents> {
  private readonly options: Required<
    Omit<TelegramPollerOptions, 'initialOffset' | 'allowedUpdates'>
  > & {
    initialOffset: number;
    allowedUpdates: string[];
  };
  private offset: number;
  private running = false;
  private abortController: AbortController = new AbortController();
  private consecutiveFailures = 0;

  constructor(options: TelegramPollerOptions) {
    super();
    this.options = {
      botToken: options.botToken,
      initialOffset: options.initialOffset ?? 0,
      allowedUpdates: options.allowedUpdates ?? [
        'message',
        'edited_message',
        'channel_post',
        'callback_query',
      ],
      fetcher: options.fetcher ?? fetch,
      sleep: options.sleep ?? defaultSleep,
      apiHost: options.apiHost ?? TELEGRAM_API_HOST,
    };
    this.offset = this.options.initialOffset;
  }

  /** Current update_id offset (for persistence). */
  getOffset(): number {
    return this.offset;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Start the long-poll loop. Idempotent. The loop runs detached — callers
   * do NOT await this method. Stop with `stop()`.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    this.emit('status', 'starting');
    void this.loop().catch((err) => {
      this.emit(
        'error',
        new TelegramPollerError(
          'TELEGRAM_NETWORK_ERROR',
          `poll loop crashed: ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
      );
      this.running = false;
      this.emit('status', 'stopped');
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.abortController.abort();
    this.emit('status', 'stopped');
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  private async loop(): Promise<void> {
    while (this.running) {
      const url = this.buildGetUpdatesUrl();
      let response: Response;
      try {
        this.emit('status', 'polling');
        response = await this.options.fetcher(url, {
          method: 'GET',
          signal: this.abortController.signal,
        });
      } catch (err) {
        if (!this.running) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        await this.handleNetworkError(err);
        continue;
      }
      if (!response.ok) {
        const handled = await this.handleErrorResponse(response);
        if (handled === 'fatal') {
          this.running = false;
          this.emit('status', 'stopped');
          return;
        }
        continue;
      }
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        result?: unknown[];
        description?: string;
      } | null;
      if (!body || body.ok !== true || !Array.isArray(body.result)) {
        await this.handleNetworkError(new Error('malformed getUpdates response'));
        continue;
      }
      this.consecutiveFailures = 0;
      for (const update of body.result) {
        if (!isRecord(update)) continue;
        const updateId = typeof update.update_id === 'number' ? update.update_id : undefined;
        if (updateId !== undefined && updateId >= this.offset) {
          this.offset = updateId + 1;
        }
        try {
          this.emit('update', update);
        } catch (err) {
          // Listener threw — log + continue, do not bring down the loop.
          this.emit(
            'error',
            new TelegramPollerError(
              'TELEGRAM_NETWORK_ERROR',
              `update listener threw: ${err instanceof Error ? err.message : String(err)}`,
              true,
            ),
          );
        }
      }
    }
  }

  private buildGetUpdatesUrl(): string {
    const params = new URLSearchParams();
    params.set('timeout', String(LONG_POLL_TIMEOUT_SECONDS));
    if (this.offset > 0) params.set('offset', String(this.offset));
    if (this.options.allowedUpdates.length > 0) {
      params.set('allowed_updates', JSON.stringify(this.options.allowedUpdates));
    }
    return `${this.options.apiHost}/bot${this.options.botToken}/getUpdates?${params.toString()}`;
  }

  private async handleErrorResponse(response: Response): Promise<'fatal' | 'retry'> {
    if (response.status === 401) {
      this.emit(
        'error',
        new TelegramPollerError(
          'TELEGRAM_TOKEN_INVALID',
          'getUpdates returned 401: bot token is invalid',
          false,
        ),
      );
      return 'fatal';
    }
    if (response.status === 409) {
      // A 409 is transient in practice and must NOT permanently stop the
      // poller. Two distinct causes share this status; classify by the Bot
      // API `description` so the log is honest and the recovery is correct.
      const description = await readDescription(response);
      const webhookActive = /webhook/i.test(description);
      if (webhookActive) {
        // A webhook is set on the bot — long-polling is blocked until it is
        // cleared. Clear it ourselves (best-effort) so the next getUpdates
        // can succeed instead of waiting for out-of-band intervention.
        await this.tryDeleteWebhook();
      }
      this.consecutiveFailures += 1;
      this.emit(
        'error',
        new TelegramPollerError(
          webhookActive ? 'TELEGRAM_WEBHOOK_CONFLICT' : 'TELEGRAM_POLL_CONFLICT',
          webhookActive
            ? `getUpdates returned 409 (webhook active): ${description || 'a webhook is currently set'}; attempted deleteWebhook, will retry`
            : `getUpdates returned 409 (conflict): ${description || 'terminated by other getUpdates request'}; another consumer or a stale long-poll is active, will retry`,
          true,
        ),
      );
      await this.backoffOnce();
      return 'retry';
    }
    if (response.status === 429) {
      const body = (await response.json().catch(() => null)) as {
        parameters?: { retry_after?: number };
      } | null;
      const retryAfterMs = (body?.parameters?.retry_after ?? 5) * 1000;
      this.emit(
        'error',
        new TelegramPollerError(
          'TELEGRAM_RATE_LIMITED',
          `getUpdates rate limited, retry_after=${retryAfterMs}ms`,
          true,
        ),
      );
      this.emit('status', 'backoff');
      await this.options.sleep(retryAfterMs || RATE_LIMIT_FALLBACK_MS);
      return 'retry';
    }
    this.emit(
      'error',
      new TelegramPollerError(
        'TELEGRAM_SERVER_ERROR',
        `getUpdates returned ${response.status}`,
        true,
      ),
    );
    await this.backoffOnce();
    return 'retry';
  }

  private async handleNetworkError(err: unknown): Promise<void> {
    this.consecutiveFailures += 1;
    this.emit(
      'error',
      new TelegramPollerError(
        'TELEGRAM_NETWORK_ERROR',
        `getUpdates network error: ${err instanceof Error ? err.message : String(err)}`,
        true,
      ),
    );
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      // Stay running but back off hard to give the network time to recover.
      this.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
    }
    await this.backoffOnce();
  }

  private async backoffOnce(): Promise<void> {
    this.emit('status', 'backoff');
    const exp = BACKOFF_MIN_MS * 2 ** Math.min(this.consecutiveFailures, 4);
    const wait = Math.min(exp, BACKOFF_MAX_MS);
    await this.options.sleep(wait);
  }

  /**
   * Best-effort `deleteWebhook` so a webhook-induced 409 self-heals on the
   * next getUpdates. Never throws — failure is surfaced by the subsequent
   * retry hitting 409 again and backing off further.
   */
  private async tryDeleteWebhook(): Promise<void> {
    try {
      await this.options.fetcher(
        `${this.options.apiHost}/bot${this.options.botToken}/deleteWebhook`,
        { method: 'GET', signal: this.abortController.signal },
      );
    } catch {
      // Swallow: the loop will retry getUpdates and back off if still blocked.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the Bot API `description` field from an error response, best-effort. */
async function readDescription(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { description?: string } | null;
  return typeof body?.description === 'string' ? body.description : '';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}
