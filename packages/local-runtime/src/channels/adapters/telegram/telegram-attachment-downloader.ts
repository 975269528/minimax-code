import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import type { ChannelInboundAttachmentRef } from '../../envelope.js';
import type { LocalMessageAttachment } from '../../../messages/input.js';
import {
  type RetryOptions,
  type DeadLetterRefKind,
  type LocalDeadLetterStore,
  makeDeadLetterCallback,
  withRetry,
} from '../../attachment-retry.js';
import { imLogger as logger } from '../../../common/im-logger.js';
import {
  detectMediaFromBuffer,
  hasValidIsoBmffFileTypeBox,
  type DetectedMedia,
} from '../../media-detector.js';

export { detectMediaFromBuffer } from '../../media-detector.js';
export type { DetectedMedia } from '../../media-detector.js';

/**
 * Telegram inbound attachment types we handle. The platform surfaces the same
 * `file_id` payload under six distinct `message.*` keys; we map each one to a
 * platform-neutral attachment category so downstream agents do not need to
 * know about Telegram's split.
 */
export type TelegramAttachmentKind = 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'sticker';

/**
 * Catalogue entry that pairs the platform-side kind with the runner-level
 * attachment category and a fallback MIME hint used when magic-byte sniffing
 * returns `undefined`.
 */
interface TelegramKindSpec {
  readonly category: 'image' | 'file' | 'audio' | 'video';
  readonly fallback: { mimeType: string; extension: string };
}

const TELEGRAM_KIND_SPECS: Record<TelegramAttachmentKind, TelegramKindSpec> = {
  photo: { category: 'image', fallback: { mimeType: 'image/jpeg', extension: 'jpg' } },
  document: {
    category: 'file',
    fallback: { mimeType: 'application/octet-stream', extension: 'bin' },
  },
  voice: { category: 'audio', fallback: { mimeType: 'audio/ogg', extension: 'ogg' } },
  audio: { category: 'audio', fallback: { mimeType: 'audio/mpeg', extension: 'mp3' } },
  video: { category: 'video', fallback: { mimeType: 'video/mp4', extension: 'mp4' } },
  sticker: { category: 'image', fallback: { mimeType: 'image/webp', extension: 'webp' } },
};

/** Pick a MIME / extension pair from the buffer, falling back to a kind-specific default. */
export function detectMediaOrFallback(buffer: Buffer, kind: TelegramAttachmentKind): DetectedMedia {
  const detected = detectMediaFromBuffer(buffer);
  if (detected) return detected;
  if (hasValidIsoBmffFileTypeBox(buffer)) {
    return { mimeType: 'application/octet-stream', extension: 'bin' };
  }
  return TELEGRAM_KIND_SPECS[kind].fallback;
}

/**
 * Convert a Telegram kind spec into the runner-level `LocalMessageAttachment.type`.
 * Image-bearing kinds (photo, sticker) map to `'image'`; everything else falls
 * back to `'file'` per the `LocalMessageAttachment` type union.
 */
export function categoryForKind(kind: TelegramAttachmentKind): 'image' | 'file' {
  const category = TELEGRAM_KIND_SPECS[kind].category;
  return category === 'image' ? 'image' : 'file';
}

/**
 * Pick the largest-size variant out of a Telegram `message.photo` array. The
 * Bot API delivers photos as a sorted array of `PhotoSize` objects; the last
 * entry has the highest `width`/`height`/`file_size`.
 */
export function pickLargestPhoto<T extends { file_id?: string }>(
  photo: T[] | undefined,
): T | undefined {
  if (!Array.isArray(photo) || photo.length === 0) return undefined;
  return photo[photo.length - 1];
}

export interface TelegramAttachmentDownloaderOptions {
  botToken: string;
  dataDir: () => string;
  /**
   * Override the Telegram `getFile` + file download HTTP transport. Defaults
   * to the global `fetch` (Node 18+). Tests inject a stub.
   */
  fetcher?: typeof fetch;
  /**
   * Override the random id generator. The default uses `crypto.randomBytes`
   * to produce a 6-character base64url token — same shape as P1-B's Feishu
   * downloader so cleanup tooling can rely on the file-name pattern.
   */
  makeId?: () => string;
  /**
   * Override the clock used in `downloads` debug messages. Defaults to
   * `Date.now`. Tests can pin time for deterministic output.
   */
  nowMs?: () => number;
  /**
   * Override the directory scope under `<dataDir>/tmp/im-attachments/`.
   * Defaults to `'pending'` — picked up by the inbound handler in
   * `LocalTelegramChannelApi` which renames the directory once a session
   * id is known. Tests inject their own scope to avoid cross-test bleed.
   *
   * NOTE: P1-B Feishu uses `sessionId` as the scope, but the Telegram
   * inbound handler resolves the session *after* downloading (see
   * `LocalChannelRunner.dispatchInbound` → `infra.handleInbound` →
   * `routeResolver.resolve`). We therefore download to a stable scope
   * keyed by the `clientName` so multiple inbound messages for the same
   * agent coalesce into the same directory; the eventual session id is
   * available when P1-E sweeps the directory at session close.
   */
  scopeDirName?: string;
  /**
   * Retry configuration (P2-B). Defaults to `{ maxAttempts: 3, backoffMs: [500, 1500, 5000] }`.
   * Retry network interruptions, 5xx, and timeouts; treat HTTP 4xx as permanent. Tests can disable
   * retries with `{ maxAttempts: 1 }` or speed them up with `{ backoffMs: [0, 0] }`.
   */
  retry?: RetryOptions;
  /**
   * Dead-letter queue (P2-B). After all retries fail, record failure context in
   * `<dataDir>/tmp/im-attachments/dead-letter/{ts}-telegram-{kind}.json`. Optional: without it,
   * resolve an attachment with `error` without writing to disk.
   *
   * The caller (inbound handler) injects `sessionId` and `messageId` through `withDownloadContext`,
   * because Telegram downloads precede session resolution and these fields are not yet known when
   * `downloadAttachment` is called.
   */
  deadLetterStore?: LocalDeadLetterStore;
}

/**
 * Runtime context for one download, set by the inbound handler through `withDownloadContext` before
 * `downloadAttachment`. Telegram downloads precede session resolution, so sessionId/messageId are
 * unavailable during downloader construction; pass them as context variables to the dead-letter
 * callback.
 */
export interface TelegramDownloadContext {
  sessionId?: string;
  messageId?: string;
}

interface TelegramGetFileResponse {
  ok: boolean;
  result?: {
    file_id?: string;
    file_unique_id?: string;
    file_size?: number;
    file_path?: string;
  };
  description?: string;
}

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * Telegram inbound attachment downloader (P1-C, scheme §4.5).
 *
 * Two-step download protocol (per Telegram Bot API docs):
 *   1. `GET /bot{token}/getFile?file_id={file_id}` → returns `file_path`.
 *   2. `GET /file/bot{token}/{file_path}` → binary blob.
 *
 * Failures (non-2xx HTTP, empty body, missing `file_path`) resolve the
 * returned `Promise<LocalMessageAttachment>` with an `error` field rather
 * than rejecting — the inbound handler treats each attachment as
 * best-effort and never blocks the parent message on a failed download.
 */
export class TelegramAttachmentDownloader {
  private readonly botToken: string;
  private readonly dataDir: () => string;
  private readonly fetcher: typeof fetch;
  private readonly makeId: () => string;
  private readonly nowMs: () => number;
  private readonly scopeDirName: string;
  private readonly retry: RetryOptions;
  private readonly deadLetterStore: LocalDeadLetterStore | undefined;
  /** Runtime context set by the caller (inbound handler) before downloadAttachment. */
  private currentContext: TelegramDownloadContext | undefined;

  constructor(options: TelegramAttachmentDownloaderOptions) {
    this.botToken = options.botToken;
    this.dataDir = options.dataDir;
    this.fetcher = options.fetcher ?? fetch;
    const defaultMakeId = (): string => randomBytes(4).toString('base64url').slice(0, 6);
    this.makeId = options.makeId ?? defaultMakeId;
    this.nowMs = options.nowMs ?? Date.now;
    this.scopeDirName = options.scopeDirName ?? 'pending';
    this.retry = options.retry ?? {};
    this.deadLetterStore = options.deadLetterStore;
  }

  /**
   * Set this download's runtime context (sessionId / messageId) for dead-letter records. Callers
   * **must** invoke this before `downloadAttachment`; otherwise DLQ fields remain empty strings
   * ("sessionId=unknown") without affecting the main flow.
   *
   * Downloader instances are long-lived and reused by inbound handlers, so reset context for every
   * inbound call. Recommended at the inbound entry point:
   *
   *   await downloader.withDownloadContext({ sessionId, messageId }, async () => {
   *     const attachments = await Promise.all(refs.map((r) => downloader.downloadAttachment(kind, r)));
   *   });
   */
  async withDownloadContext<T>(ctx: TelegramDownloadContext, fn: () => Promise<T>): Promise<T> {
    const prev = this.currentContext;
    this.currentContext = ctx;
    try {
      return await fn();
    } finally {
      this.currentContext = prev;
    }
  }

  /**
   * Download a single Telegram attachment (any of the six supported kinds). Returns a
   * `LocalMessageAttachment` with `filePath` set on success or `error: 'download_failed'` on
   * failure. Never throws.
   *
   * P2-B: Network interruptions / HTTP 5xx / timeouts retry automatically according to `retry`
   * (default three attempts with [500, 1500, 5000] ms backoff). Treat 4xx and protocol errors
   * (malformed getFile body, empty body) as permanent. After retries fail, record context in
   * `deadLetterStore` if configured, then still resolve an attachment with `error` without blocking
   * the main flow.
   */
  async downloadAttachment(
    kind: TelegramAttachmentKind,
    ref: ChannelInboundAttachmentRef,
  ): Promise<LocalMessageAttachment> {
    const trace = (message: string): void => {
      logger.info(
        { operation: 'telegram_attachment_download', message },
        'Telegram attachment trace',
      );
    };

    const fileId = ref.key;
    if (!fileId) {
      // Missing file_id is a permanent protocol error; do not retry or add it to DLQ unless the caller catches it manually.
      return failedAttachment(kind, ref, 'download_failed: missing file_id', trace);
    }

    let buffer: Buffer;
    try {
      buffer = await withRetry(
        () => this.fetchBuffer(ref, trace),
        this.retry,
        this.makeOnDeadLetter(kind, ref, trace),
      );
    } catch (err) {
      // withRetry has thrown the final failure. Both permanent errors and exhausted retries
      // use the same failedAttachment path; onDeadLetter has already recorded the DLQ entry.
      return failedAttachment(kind, ref, `download_failed: ${errorMessage(err)}`, trace);
    }

    const detected = detectMediaOrFallback(buffer, kind);
    const filename = this.deriveFilename(ref, detected.extension);
    const fullPath = join(this.attachmentDir(), filename);

    try {
      await mkdir(this.attachmentDir(), { recursive: true });
      await writeFile(fullPath, buffer);
    } catch (err) {
      // Disk-write failures usually indicate full disks or permissions; do not retry, but record in DLQ for diagnosis.
      const reason = `cannot persist: ${errorMessage(err)}`;
      this.fireDeadLetter(kind, ref, reason, trace);
      return failedAttachment(kind, ref, `download_failed: ${reason}`, trace);
    }

    trace(
      `downloaded kind=${kind} fileId=${fileId} bytes=${buffer.length} mimeType=${detected.mimeType} filePath=${fullPath}`,
    );

    return {
      type: categoryForKind(kind),
      filePath: fullPath,
      fileName: filename,
      mimeType: detected.mimeType,
    };
  }

  /**
   * Build this download's dead-letter callback. Capture Telegram-specific kind / ref fields outside
   * the callback and read sessionId/messageId from `currentContext`, which stays unchanged during
   * retries.
   */
  private makeOnDeadLetter(
    kind: TelegramAttachmentKind,
    ref: ChannelInboundAttachmentRef,
    trace: (msg: string) => void,
  ): ReturnType<typeof makeDeadLetterCallback> | undefined {
    if (!this.deadLetterStore) return undefined;
    const refKind = mapTelegramKindToDlqRefKind(kind);
    const ctx = this.currentContext;
    const cb = makeDeadLetterCallback(this.deadLetterStore, {
      platform: 'telegram',
      sessionId: ctx?.sessionId ?? '',
      messageId: ctx?.messageId ?? '',
      refKind,
      refKey: ref.key,
    });
    return (err, attempt, chain) => {
      trace(`dead-letter ${kind} ${ref.key} after ${attempt} attempt(s): ${errorMessage(err)}`);
      return cb(err, attempt, chain);
    };
  }

  /**
   * Fallback for non-retry paths that still need DLQ records (disk-write / protocol errors). Store
   * `finalError` as a single-element errorChain to match the retry path's structure.
   */
  private fireDeadLetter(
    kind: TelegramAttachmentKind,
    ref: ChannelInboundAttachmentRef,
    reason: string,
    trace: (msg: string) => void,
  ): void {
    if (!this.deadLetterStore) return;
    const refKind = mapTelegramKindToDlqRefKind(kind);
    const ctx = this.currentContext;
    void this.deadLetterStore
      .record({
        ts: this.nowMs(),
        platform: 'telegram',
        sessionId: ctx?.sessionId ?? '',
        messageId: ctx?.messageId ?? '',
        refKind,
        refKey: ref.key,
        errorChain: [{ attempt: 1, message: reason }],
        finalError: reason,
      })
      .catch(() => {
        /* `record` is already fire-and-forget. */
      });
    trace(`dead-letter ${kind} ${ref.key}: ${reason}`);
  }

  /**
   * Internal fetch step: HTTP calls and body parsing only, **no** persistence. Thrown errors must
   * expose recognizable status / message fields for `withRetry`:
   * - fetcher rejection (network error): Retryable by default.
   * - HTTP 5xx: Retryable by default.
   * - HTTP 4xx: Permanent; expose `status` so withRetry recognizes it.
   * - JSON parse failure / missing file_path / empty body: Permanent.
   */
  private async fetchBuffer(
    ref: ChannelInboundAttachmentRef,
    trace: (msg: string) => void,
  ): Promise<Buffer> {
    const fileId = ref.key;
    let getFileResponse: Response;
    try {
      getFileResponse = await this.fetcher(
        `${TELEGRAM_API_BASE}/bot${this.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
        { method: 'GET' },
      );
    } catch (err) {
      throw wrapWithHttpStatus(err, 0);
    }

    if (!getFileResponse.ok) {
      // Expose status to withRetry so it can identify permanent 4xx errors.
      const status = getFileResponse.status;
      try {
        await getFileResponse.text();
      } catch {
        /* ignore */
      }
      const err = new Error(`getFile HTTP ${status} ${getFileResponse.statusText}`) as Error & {
        status: number;
      };
      err.status = status;
      throw err;
    }

    const getFileData = (await getFileResponse.json().catch(() => undefined)) as
      | TelegramGetFileResponse
      | undefined;
    const filePath = getFileData?.result?.file_path;
    if (!getFileData?.ok || !filePath) {
      // Protocol error: Bot API ok=false or missing file_path; retrying is pointless.
      throw new Error(
        `getFile returned no file_path (${getFileData?.description ?? 'malformed response'})`,
      );
    }

    let downloadResponse: Response;
    try {
      downloadResponse = await this.fetcher(
        `${TELEGRAM_API_BASE}/file/bot${this.botToken}/${filePath}`,
        { method: 'GET' },
      );
    } catch (err) {
      throw wrapWithHttpStatus(err, 0);
    }

    if (!downloadResponse.ok) {
      const status = downloadResponse.status;
      try {
        await downloadResponse.text();
      } catch {
        /* ignore */
      }
      const err = new Error(`file HTTP ${status} ${downloadResponse.statusText}`) as Error & {
        status: number;
      };
      err.status = status;
      throw err;
    }

    const arrayBuffer = await downloadResponse.arrayBuffer().catch(() => null);
    if (!arrayBuffer) {
      // arrayBuffer() rejection usually indicates a decoding error and is not retryable.
      throw new Error('empty body (arrayBuffer() rejected)');
    }
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length === 0) {
      // HTTP 200 with an empty body is usually not a transient network failure; retries are unlikely to help.
      throw new Error('empty body');
    }

    trace(`fetched ${fileId} (${buffer.length} bytes)`);
    return buffer;
  }

  /**
   * Convenience wrapper: download a batch of refs concurrently. Each download
   * is independent — a single failure does not affect the others.
   */
  async downloadAll(
    items: Array<{ kind: TelegramAttachmentKind; ref: ChannelInboundAttachmentRef }>,
  ): Promise<LocalMessageAttachment[]> {
    return Promise.all(items.map((item) => this.downloadAttachment(item.kind, item.ref)));
  }

  /** Resolve the directory used to persist downloaded attachments. */
  attachmentDir(): string {
    return join(this.dataDir(), 'tmp', 'im-attachments', this.scopeDirName);
  }

  /**
   * Compose the on-disk filename for a download. We honour a caller-provided
   * `name` when it carries an extension (e.g. `report.pdf`); otherwise we
   * fall back to `{id}.{ext}`. The id is the same 6-char base64url token the
   * Feishu downloader emits, which keeps cleanup tooling uniform.
   */
  private deriveFilename(ref: ChannelInboundAttachmentRef, ext: string): string {
    if (ref.name && extname(ref.name)) {
      // Strip path components — the platform-supplied name is treated as
      // opaque, never as a relative path.
      const base = ref.name.replace(/^.*[\\/]/u, '');
      if (base) return base;
    }
    return `${this.makeId()}.${ext}`;
  }
}

function failedAttachment(
  kind: TelegramAttachmentKind,
  ref: ChannelInboundAttachmentRef,
  reason: string,
  trace: (msg: string) => void,
): LocalMessageAttachment {
  trace(`failed ${kind} ${ref.key}: ${reason}`);
  const fallback = TELEGRAM_KIND_SPECS[kind].fallback;
  return {
    type: categoryForKind(kind),
    filePath: '',
    fileName: ref.name ?? `${kind}-${ref.key.slice(0, 6) || 'unknown'}`,
    mimeType: fallback.mimeType,
    error: reason,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wrap a fetcher rejection with the status just set. `fetch` itself does not reject with status
 * (available only when `response.ok === false`); this preserves the message and gives `withRetry` a
 * clear network-error signal: no status → default non-4xx handling → retryable by default.
 */
function wrapWithHttpStatus(err: unknown, _status: number): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(msg);
}

/**
 * Map Telegram's six kinds to four DLQ refKinds (image / file / audio / video): sticker / photo →
 * image, voice / audio → audio, video → video, document → file.
 */
function mapTelegramKindToDlqRefKind(kind: TelegramAttachmentKind): DeadLetterRefKind {
  switch (kind) {
    case 'photo':
    case 'sticker':
      return 'image';
    case 'voice':
    case 'audio':
      return 'voice';
    case 'video':
      return 'video';
    case 'document':
    default:
      return 'file';
  }
}
