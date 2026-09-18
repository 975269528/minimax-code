import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { OutboundMediaRef } from '@mavis/shared';

import { type RetryOptions, withRetry } from '../../attachment-retry.js';
import type { TelegramInlineKeyboardMarkup } from './telegram-keyboard.js';

/**
 * Telegram **outbound** sender (§4.4 O4).
 *
 * Until now the daemon-local Telegram channel was 100 % mock: outbound replies
 * were only appended to the YAML history store, never delivered to Telegram.
 * This module is the first real Bot API send path inside the local runtime —
 * it covers plain text plus the four outbound media kinds the agent can emit
 * (`image` / `video` / `audio` / `file`).
 *
 * Transport protocol (per Telegram Bot API):
 *   - text  → `POST /bot{token}/sendMessage` with JSON `{ chat_id, text }`.
 *   - media → `POST /bot{token}/<method>` with `multipart/form-data` carrying
 *     `chat_id`, the file field, and an optional `caption`.
 *
 * The file bytes are resolved on our side: a local absolute path is read from
 * disk, an `http(s)://` URL is fetched. We upload the bytes directly rather
 * than handing Telegram a URL so the sender works for sandbox-local artefacts
 * the public Telegram servers cannot reach.
 *
 * Reliability mirrors the inbound downloader (`local-telegram-attachment-
 * downloader.ts`): every network call is wrapped in {@link withRetry} so a
 * transient 5xx / network blip self-heals, while an HTTP 4xx is a permanent
 * failure that fails fast.
 *
 * SECURITY: the request URL embeds the bot token, and the multipart body
 * embeds the file bytes — neither is ever logged here. Errors surface only the
 * HTTP status. Callers (the channel client) must keep the same discipline.
 */

/** Telegram Bot API origin. Mirrors the inbound downloader's constant. */
export const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * Map an {@link OutboundMediaRef.kind} to the Telegram `send*` method and the
 * multipart field name Telegram expects the file under.
 */
const KIND_TO_METHOD: Record<OutboundMediaRef['kind'], { method: string; field: string }> = {
  image: { method: 'sendPhoto', field: 'photo' },
  video: { method: 'sendVideo', field: 'video' },
  audio: { method: 'sendAudio', field: 'audio' },
  file: { method: 'sendDocument', field: 'document' },
};

export interface TelegramSenderOptions {
  /**
   * Override the HTTP transport. Defaults to the global `fetch` (Node 20+,
   * which also supplies `FormData` / `Blob`). Tests inject a stub to assert
   * the request shape without real network I/O.
   */
  fetcher?: typeof fetch;
  /**
   * Retry policy for transient failures. Defaults to the shared default
   * (`{ maxAttempts: 3, backoffMs: [500, 1500, 5000] }`). 5xx / network →
   * retry; 4xx → permanent. Tests pass `{ maxAttempts: 1 }` to disable or
   * `{ backoffMs: [0, 0] }` to speed retries up.
   */
  retry?: RetryOptions;
}

export interface TelegramSentTextResult {
  messageId: number;
}

export class TelegramSender {
  private readonly botToken: string;
  private readonly fetcher: typeof fetch;
  private readonly retry: RetryOptions;

  constructor(botToken: string, options: TelegramSenderOptions = {}) {
    this.botToken = botToken;
    this.fetcher = options.fetcher ?? fetch;
    this.retry = options.retry ?? {};
  }

  /**
   * Send a plain-text message via `sendMessage`. No `parse_mode` is set so the
   * text is delivered verbatim (no Markdown / HTML escaping surprises).
   *
   * Blank text is a no-op — Telegram rejects empty `text`, and the caller
   * already records the (possibly empty) reply in the outbound history store.
   *
   * The optional {@link TelegramInlineKeyboardMarkup} attaches an inline
   * keyboard to the message (used by MR-E1 to render permission cards). The
   * markup is forwarded as `reply_markup` per Bot API spec; passing
   * `undefined` keeps the legacy text-only behaviour unchanged.
   */
  async sendText(
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
    messageThreadId?: string,
  ): Promise<TelegramSentTextResult | undefined> {
    if (!text.trim()) return undefined;
    return withRetry(async () => {
      const body: Record<string, unknown> = { chat_id: chatId, text };
      if (replyMarkup) body.reply_markup = replyMarkup;
      // Forum topic reply: Telegram routes the message into the topic when
      // `message_thread_id` is set. Absent → message lands in the General
      // (top-level) chat, preserving the legacy behaviour.
      const threadId = toMessageThreadId(messageThreadId);
      if (threadId !== undefined) body.message_thread_id = threadId;
      const response = await this.fetcher(this.endpoint('sendMessage'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      this.assertOk(response, 'sendMessage');
      return readTelegramMessageId(response);
    }, this.retry);
  }

  /**
   * Acknowledge a Telegram inline-keyboard click via `answerCallbackQuery`.
   * Without this, the clicked button keeps spinning until Telegram times out
   * the callback. Optional `text` appears as Telegram's lightweight toast.
   */
  async answerCallbackQuery(
    callbackQueryId: string,
    options: { text?: string; showAlert?: boolean } = {},
  ): Promise<void> {
    await withRetry(async () => {
      const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
      if (options.text) body.text = options.text;
      if (options.showAlert !== undefined) body.show_alert = options.showAlert;
      const response = await this.fetcher(this.endpoint('answerCallbackQuery'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      this.assertOk(response, 'answerCallbackQuery');
    }, this.retry);
  }

  /** Edit a previously sent text message and, optionally, replace its keyboard. */
  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<void> {
    await withRetry(async () => {
      const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
      if (replyMarkup) body.reply_markup = replyMarkup;
      const response = await this.fetcher(this.endpoint('editMessageText'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      this.assertOk(response, 'editMessageText');
    }, this.retry);
  }

  /**
   * Send a chat action (e.g. "typing") via `sendChatAction`. Telegram shows the
   * action for ~5s then auto-clears, so the caller re-sends on a timer for the
   * duration of a turn. Best-effort: wrapped in withRetry like the other sends;
   * the token is in the URL and is never logged.
   */
  async sendChatAction(chatId: string, action = 'typing'): Promise<void> {
    await withRetry(async () => {
      const response = await this.fetcher(this.endpoint('sendChatAction'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action }),
      });
      this.assertOk(response, 'sendChatAction');
    }, this.retry);
  }

  /**
   * Send a single media attachment. The bytes are resolved first (local path
   * or `http(s)://`), then uploaded as `multipart/form-data` to the per-kind
   * `send*` method.
   */
  async sendMedia(chatId: string, ref: OutboundMediaRef, messageThreadId?: string): Promise<void> {
    const { method, field } = KIND_TO_METHOD[ref.kind];
    const buffer = await this.resolveBytes(ref.path);
    const fileName = ref.name || basename(ref.path) || 'attachment';

    await withRetry(async () => {
      const form = new FormData();
      form.set('chat_id', chatId);
      const threadId = toMessageThreadId(messageThreadId);
      if (threadId !== undefined) form.set('message_thread_id', String(threadId));
      form.set(field, new Blob([buffer]), fileName);
      if (ref.caption) form.set('caption', ref.caption);
      const response = await this.fetcher(this.endpoint(method), {
        method: 'POST',
        body: form,
      });
      this.assertOk(response, method);
    }, this.retry);
  }

  /**
   * Resolve the raw bytes behind a media ref. `http(s)://` URLs are fetched;
   * everything else is treated as a local filesystem path and read directly.
   * Never logs the path contents.
   */
  private async resolveBytes(path: string): Promise<Buffer> {
    if (/^https?:\/\//iu.test(path)) {
      const response = await this.fetcher(path, { method: 'GET' });
      if (!response.ok) {
        throw withStatus(new Error(`fetch media HTTP ${response.status}`), response.status);
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }
    return readFile(path);
  }

  /** Compose a Bot API endpoint URL. Contains the token — never log this. */
  private endpoint(method: string): string {
    return `${TELEGRAM_API_BASE}/bot${this.botToken}/${method}`;
  }

  /**
   * Throw on a non-2xx Telegram response. The thrown error carries `status` so
   * {@link withRetry} can tell a transient 5xx (retry) from a permanent 4xx
   * (fail fast). The response body is drained but NOT surfaced — it can echo
   * back request content.
   */
  private assertOk(response: Response, method: string): void {
    if (response.ok) return;
    throw withStatus(new Error(`telegram ${method} HTTP ${response.status}`), response.status);
  }
}

/** Attach an HTTP `status` to an error so `withRetry` can classify it. */
function withStatus(err: Error, status: number): Error & { status: number } {
  const typed = err as Error & { status: number };
  typed.status = status;
  return typed;
}

/**
 * Coerce an inbound thread id into the numeric `message_thread_id` Telegram's
 * Bot API expects. `ChannelContext.threadId` is a string (unified across
 * platforms); Telegram forum topic ids are integers. Returns `undefined` for
 * empty / non-numeric input so callers simply omit the field.
 */
function toMessageThreadId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function readTelegramMessageId(
  response: Response,
): Promise<TelegramSentTextResult | undefined> {
  const json = (await response.json().catch(() => undefined)) as unknown;
  if (!isRecord(json) || !isRecord(json.result)) return undefined;
  const messageId = json.result.message_id;
  if (typeof messageId !== 'number' || !Number.isFinite(messageId)) return undefined;
  return { messageId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
