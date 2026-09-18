import { readFile } from 'node:fs/promises';

import { MIME_BY_EXTENSION, type OutboundMediaRef } from '@mavis/shared';

import { type RetryOptions, withRetry } from '../../attachment-retry.js';
import { imLogger as logger } from '../../../common/im-logger.js';
import { getFeishuUserDisplayName } from './feishu-user.js';

/**
 * Feishu / Lark **outbound** sender (MR-C §D3).
 *
 * Mirrors `TelegramSender` shape: raw `fetch` to the public open-apis
 * endpoints, an injectable `fetcher` for unit tests, and `withRetry` so a
 * 5xx / network blip self-heals while 4xx fails fast.
 *
 * Feishu's outbound surface differs from Telegram in two interesting ways:
 *
 *  - **Auth header**, not URL token. Every send call carries an
 *    `Authorization: Bearer <tenant_access_token>` header. The token is a
 *    short-lived (2h) secret minted by `/auth/v3/tenant_access_token/internal`
 *    and is cached here with a 60s safety window so we never hand out a
 *    nearly-expired token to a retry. Tokens are never logged.
 *
 *  - **Two-step media uploads**. Image / file / audio / video bytes are first
 *    uploaded to `/im/v1/images` or `/im/v1/files`, which returns an
 *    `image_key` / `file_key`. The actual message send (`/im/v1/messages`)
 *    then references that key in a JSON `content` payload (Feishu does NOT
 *    accept `multipart/form-data` on the send endpoint itself). The two-step
 *    flow is hidden behind {@link FeishuSender.sendMedia} — callers only see
 *    `(chatId, ref)` like the Telegram path.
 *
 * Interactive cards go through {@link FeishuSender.sendCard}, which uses the
 * exact same `/im/v1/messages` endpoint but with `msg_type: 'interactive'`
 * and a card payload assembled by `feishu-card.ts`. The sender itself stays
 * card-agnostic — it only knows the wire envelope.
 *
 * SECURITY: tenant_access_token, app_id, app_secret, and the response body
 * (which can echo a request) are NEVER logged. Errors surface only the HTTP
 * status + a stable code string.
 */

/** Feishu open-apis origin. */
export const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

/**
 * Receive-id type accepted by Feishu `/im/v1/messages?receive_id_type=...`.
 * The channel layer routes by `chat_id` for both p2p and group conversations,
 * so the sender always uses `'chat_id'` — adapters that need to send to a
 * specific `open_id` should add a new method rather than overloading this.
 */
type FeishuReceiveIdType = 'chat_id' | 'open_id' | 'union_id' | 'user_id' | 'email';

/**
 * Feishu's upload capability is selected from the final filename, not the
 * shared coarse media kind. The latter intentionally remains platform
 * agnostic so Telegram / WeChat keep their existing behavior.
 */
export interface FeishuUploadSpec {
  endpoint: 'images' | 'files';
  fileTypeField: 'image_type' | 'file_type';
  fileType: string;
  msgType: 'image' | 'file' | 'audio' | 'media';
  contentKey: 'image_key' | 'file_key';
}

const FEISHU_IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
  'ico',
  'tif',
  'tiff',
  'heic',
]);

const FEISHU_FILE_TYPE_BY_EXTENSION: Record<string, string> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  xls: 'xls',
  xlsx: 'xls',
  ppt: 'ppt',
  pptx: 'ppt',
};

const FEISHU_MIME_BY_EXTENSION: Record<string, string> = {
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  opus: 'audio/ogg',
};

const CANONICAL_EXTENSION_BY_MIME: Record<string, string> = {
  'text/html': 'html',
  'text/plain': 'txt',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
};

const FEISHU_GENERIC_MEDIA_TYPES = new Set(['image', 'audio', 'video', 'file', 'document']);

function extensionOf(value: string | undefined): string {
  if (!value) return '';
  const withoutQuery = value.trim().split(/[?#]/u)[0] ?? '';
  const lastSegment = withoutQuery.split(/[\\/]/u).at(-1) ?? '';
  const dot = lastSegment.lastIndexOf('.');
  if (dot < 0 || dot === lastSegment.length - 1) return '';
  return lastSegment.slice(dot + 1).toLowerCase();
}

function decodeUriComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizeBasename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withoutQuery = value.split(/[?#]/u)[0] ?? '';
  const lastSegment = withoutQuery
    .split(/[\\/]/u)
    .reverse()
    .find((segment) => segment.trim().length > 0);
  const sanitized = lastSegment
    ?.replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim()
    .replace(/[.]+$/u, '')
    .trim();
  if (!sanitized || sanitized === '.' || sanitized === '..') return undefined;
  return sanitized;
}

function sourceBasename(path: string): string | undefined {
  const trimmed = path.trim();
  let source = trimmed;
  if (/^(?:https?|file):\/\//iu.test(trimmed)) {
    try {
      source = new URL(trimmed).pathname;
    } catch {
      source = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '');
    }
  }
  return sanitizeBasename(decodeUriComponentSafely(source));
}

function typeExtension(type: string | undefined): string | undefined {
  const normalized = type?.trim().toLowerCase().replace(/^\./u, '');
  if (!normalized || FEISHU_GENERIC_MEDIA_TYPES.has(normalized)) return undefined;
  return Object.prototype.hasOwnProperty.call(MIME_BY_EXTENSION, normalized) ||
    Object.prototype.hasOwnProperty.call(FEISHU_MIME_BY_EXTENSION, normalized)
    ? normalized
    : undefined;
}

/** Resolve the safe Feishu transport filename without doing I/O. */
export function resolveFeishuUploadFileName(ref: OutboundMediaRef): string {
  const sourceName = sourceBasename(ref.path);
  const candidate =
    ref.nameSource === 'caption' || ref.nameSource === 'path'
      ? sourceName
      : (sanitizeBasename(ref.name) ?? sourceName);
  const baseName = candidate ?? 'attachment';
  if (extensionOf(baseName)) return baseName;

  const extension =
    extensionOf(sourceName) ||
    typeExtension(ref.type) ||
    CANONICAL_EXTENSION_BY_MIME[ref.mimeType?.trim().toLowerCase() ?? ''] ||
    'bin';
  return `${baseName}.${extension}`;
}

/** Resolve Blob MIME extension-first, with only Feishu-specific overrides. */
export function resolveFeishuUploadMimeType(ref: OutboundMediaRef, uploadFileName: string): string {
  const extension = extensionOf(uploadFileName);
  return (
    FEISHU_MIME_BY_EXTENSION[extension] ??
    MIME_BY_EXTENSION[extension] ??
    ref.mimeType?.trim().toLowerCase() ??
    'application/octet-stream'
  );
}

/** Resolve the exact Feishu upload endpoint/file type/message type whitelist. */
export function resolveFeishuUploadSpec(uploadFileName: string): FeishuUploadSpec {
  const extension = extensionOf(uploadFileName);
  if (FEISHU_IMAGE_EXTENSIONS.has(extension)) {
    return {
      endpoint: 'images',
      fileTypeField: 'image_type',
      fileType: 'message',
      msgType: 'image',
      contentKey: 'image_key',
    };
  }
  if (extension === 'opus') {
    return {
      endpoint: 'files',
      fileTypeField: 'file_type',
      fileType: 'opus',
      msgType: 'audio',
      contentKey: 'file_key',
    };
  }
  if (extension === 'mp4') {
    return {
      endpoint: 'files',
      fileTypeField: 'file_type',
      fileType: 'mp4',
      msgType: 'media',
      contentKey: 'file_key',
    };
  }
  return {
    endpoint: 'files',
    fileTypeField: 'file_type',
    fileType: FEISHU_FILE_TYPE_BY_EXTENSION[extension] ?? 'stream',
    msgType: 'file',
    contentKey: 'file_key',
  };
}

/**
 * Cached tenant_access_token. `expiresAtMs` is the absolute wall-clock at
 * which the token actually expires (NOT including the 60s safety window —
 * the freshness check applies the window on read).
 */
interface CachedTenantAccessToken {
  token: string;
  expiresAtMs: number;
}

export interface FeishuSenderOptions {
  fetcher?: typeof fetch;
  retry?: RetryOptions;
  nowMs?: () => number;
  /** Optional stable client identity used to correlate structured media logs. */
  clientName?: string;
  /**
   * Safety window (ms) for the tenant_access_token cache — the cached token
   * is considered stale this many ms before its real expiry, so a retry that
   * straddles the boundary still uses a guaranteed-valid token. Defaults to
   * 60s, matching the Feishu official recommendation.
   */
  tokenSafetyWindowMs?: number;
}

/**
 * Result type for {@link FeishuSender.sendText} / {@link FeishuSender.sendCard}.
 */
export interface FeishuSendResult {
  messageId: string;
}

export interface FeishuMessageSnapshot {
  messageId: string;
  messageType?: string;
  content?: unknown;
  senderId?: string;
  senderName?: string;
}

export interface FeishuBotIdentity {
  openId?: string;
  name?: string;
}

/**
 * Thread-reply option. When present, the send is routed through the Feishu
 * `reply` endpoint (`POST /im/v1/messages/:message_id/reply`) with
 * `reply_in_thread: true`, so the outbound message lands inside the same
 * thread/topic as `replyToMessageId` instead of the top-level conversation.
 */
export interface FeishuThreadReply {
  /** A message ID that lives inside the target thread (usually the inbound msg). */
  replyToMessageId: string;
}

type FeishuMediaLogOperation = 'upload' | 'message';
type FeishuMediaLogEvent = 'start' | 'success' | 'retry' | 'final_failure';

interface FeishuMediaLogMetadata {
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  fileType: string | null;
  msgType: string;
}

interface FeishuWireMetadata {
  httpStatus: number | null;
  feishuCode: number | null;
}

type RecordFeishuWireMetadata = (metadata: Partial<FeishuWireMetadata>) => void;

function operationPhase(operation: FeishuMediaLogOperation, event: FeishuMediaLogEvent): string {
  if (operation === 'upload') return `upload_${event}`;
  return `message_send_${event}`;
}

function errorHttpStatus(err: unknown): number | null {
  const status = (err as { httpStatus?: unknown })?.httpStatus;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

function errorFeishuCode(err: unknown): number | null {
  const code = (err as { feishuCode?: unknown })?.feishuCode;
  return typeof code === 'number' && Number.isFinite(code) ? code : null;
}

function errorRetryStatus(err: unknown): number | null {
  const status = (err as { status?: unknown })?.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

function responseFeishuCode(body: unknown): number | null {
  const code = (body as { code?: unknown })?.code;
  return typeof code === 'number' && Number.isFinite(code) ? code : null;
}

export class FeishuSender {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly fetcher: typeof fetch;
  private readonly retry: RetryOptions;
  private readonly nowMs: () => number;
  private readonly clientName: string | null;
  private readonly tokenSafetyWindowMs: number;
  private cachedToken: CachedTenantAccessToken | undefined;
  private readonly userNameCache = new Map<string, string>();
  /** Lifetime cache of the bot identity returned by `/bot/v3/info`. */
  private cachedBotIdentity: FeishuBotIdentity | null | undefined;

  constructor(appId: string, appSecret: string, options: FeishuSenderOptions = {}) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.fetcher = options.fetcher ?? fetch;
    this.retry = options.retry ?? {};
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.clientName = options.clientName?.trim() || null;
    this.tokenSafetyWindowMs = options.tokenSafetyWindowMs ?? 60_000;
  }

  /**
   * Send a plain-text message via `/im/v1/messages`. Blank text is a no-op —
   * Feishu rejects empty `content.text` and the adapter already records the
   * outbound entry locally.
   */
  async sendText(
    chatId: string,
    text: string,
    receiveIdType: FeishuReceiveIdType = 'chat_id',
    thread?: FeishuThreadReply,
  ): Promise<FeishuSendResult | undefined> {
    if (!text.trim()) return undefined;
    const content = JSON.stringify({ text });
    return this.sendMessage(chatId, 'text', content, receiveIdType, thread);
  }

  /**
   * Send an interactive card via `/im/v1/messages` with `msg_type:'interactive'`.
   * The `card` argument is the already-assembled Feishu card spec (see
   * {@link buildQuestionnaireCard} in `feishu-card.ts`); this method only
   * handles transport.
   */
  async sendCard(
    chatId: string,
    card: unknown,
    receiveIdType: FeishuReceiveIdType = 'chat_id',
    thread?: FeishuThreadReply,
  ): Promise<FeishuSendResult | undefined> {
    const content = JSON.stringify(card);
    return this.sendMessage(chatId, 'interactive', content, receiveIdType, thread);
  }

  /**
   * Send a single media attachment. The bytes are resolved (local path or
   * `http(s)://` URL), uploaded to the endpoint selected by the final filename
   * capability resolver to mint a key,
   * then a JSON `content` referencing that key is sent to `/im/v1/messages`.
   * `ref.caption` remains filename metadata and is not sent separately.
   */
  async sendMedia(
    chatId: string,
    ref: OutboundMediaRef,
    receiveIdType: FeishuReceiveIdType = 'chat_id',
    thread?: FeishuThreadReply,
  ): Promise<FeishuSendResult | undefined> {
    const uploadFileName = resolveFeishuUploadFileName(ref);
    const uploadMimeType = resolveFeishuUploadMimeType(ref, uploadFileName);
    const spec = resolveFeishuUploadSpec(uploadFileName);
    const buffer = await this.resolveBytes(ref.path);
    const logMetadata: FeishuMediaLogMetadata = {
      fileName: uploadFileName,
      mimeType: uploadMimeType,
      sizeBytes: buffer.byteLength,
      fileType: spec.fileType,
      msgType: spec.msgType,
    };

    // Step 1: upload to mint a key.
    const key = await this.withLoggedRetry({
      operation: 'upload',
      endpoint: `/im/v1/${spec.endpoint}`,
      chatId,
      metadata: logMetadata,
      run: async (recordWire) => {
        const token = await this.ensureToken();
        // Build a fresh FormData for every attempt. A retry must never reuse
        // a multipart body that an earlier fetch may already have consumed.
        const form = new FormData();
        form.set(spec.fileTypeField, spec.fileType);
        if (spec.endpoint === 'files') form.set('file_name', uploadFileName);
        form.set(
          spec.endpoint === 'images' ? 'image' : 'file',
          new Blob([buffer], { type: uploadMimeType }),
          uploadFileName,
        );
        const response = await this.fetcher(`${FEISHU_API_BASE}/im/v1/${spec.endpoint}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        const body = (await this.assertOkAndParse(response, `upload ${spec.endpoint}`)) as {
          code?: number;
          data?: { image_key?: string; file_key?: string };
        };
        recordWire({ httpStatus: response.status, feishuCode: responseFeishuCode(body) });
        const minted = body?.data?.[spec.contentKey];
        if (typeof minted !== 'string' || !minted) {
          throw withStatus(
            new Error(`feishu upload ${spec.endpoint} missing ${spec.contentKey}`),
            500,
          );
        }
        return minted;
      },
    });

    // Step 2: send the message referencing the minted key.
    const content = JSON.stringify({ [spec.contentKey]: key });
    const sent = await this.sendMessage(
      chatId,
      spec.msgType,
      content,
      receiveIdType,
      thread,
      logMetadata,
      true,
    );
    return sent;
  }

  /**
   * Post a Feishu reaction to a message — used as an inbound "message received" ack
   * (mirrors the historical `feat/im-genui-full-mr` `addReaction('OnIt')`
   * call). Best-effort: failure is swallowed by the caller so a reaction
   * outage never blocks the reply pipeline.
   *
   * `emojiType` is the Feishu emoji constant (e.g. `'OnIt'`, `'THUMBSUP'`,
   * `'DONE'`). The caller is responsible for the mapping.
   *
   * Returns the Feishu-assigned `reaction_id` so the caller can later revoke
   * the ack via {@link removeReaction} once the reply has been delivered.
   * `undefined` when the response omits the id (removal is then impossible —
   * the reaction simply stays, matching the historical behaviour).
   */
  async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    if (!messageId || !emojiType) return undefined;
    return withRetry(async () => {
      const token = await this.ensureToken();
      const response = await this.fetcher(
        `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'content-type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
        },
      );
      const body = (await this.assertOkAndParse(response, 'addReaction')) as {
        data?: { reaction_id?: string };
      };
      const reactionId = body?.data?.reaction_id;
      return typeof reactionId === 'string' && reactionId.length > 0 ? reactionId : undefined;
    }, this.retry);
  }

  /**
   * Revoke a reaction previously posted via {@link addReaction} — used to
   * withdraw the 👀 `OnIt` inbound ack once the final reply has actually been
   * delivered, so the reaction reads as "in progress" rather than lingering
   * forever. `reactionId` is the id minted by the add call. Best-effort like
   * add: callers swallow failures so a removal outage never blocks delivery.
   */
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    if (!messageId || !reactionId) return;
    await withRetry(async () => {
      const token = await this.ensureToken();
      const response = await this.fetcher(
        `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      await this.assertOkAndParse(response, 'removeReaction');
    }, this.retry);
  }

  /**
   * Patch an already-sent interactive card content in place. Used to morph
   * a transient "🤔 Thinking…" grey card into the final green reply card without
   * sending a second bubble (matches historical IM Gateway behaviour).
   */
  async patchCard(messageId: string, card: unknown): Promise<void> {
    if (!messageId) return;
    await withRetry(async () => {
      const token = await this.ensureToken();
      const response = await this.fetcher(
        `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'content-type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({ content: JSON.stringify(card) }),
        },
      );
      await this.assertOkAndParse(response, 'patchCard');
    }, this.retry);
  }

  /**
   * Force-evict the cached tenant_access_token. Adapters call this on bind /
   * unbind / credential rotation so a stale token never survives a re-bind.
   */
  invalidateToken(): void {
    this.cachedToken = undefined;
  }

  /**
   * Download a message resource (image / file / audio / video) referenced by
   * `messageId` + `fileKey` via the Feishu OpenAPI
   * `GET /im/v1/messages/{message_id}/resources/{file_key}` endpoint and
   * return the raw bytes. Mirrors the historical `feat/im-genui-full-mr`
   * `downloadMessageResource` helper.
   *
   * Why raw fetch (not the SDK):
   *   - The SDK response stream swallows the body, which kills MIME sniffing
   *     callers depend on.
   *   - Keeps this sender SDK-free for unit tests (the same `fetcher` stub
   *     covers token mint, send, and download).
   *
   * Behaviour:
   *   - `type='image'` hits the `?type=image` variant; everything else
   *     (file / audio / video) uses `?type=file` per Feishu's contract.
   *   - HTTP non-2xx and zero-byte body both throw — callers decide whether
   *     to mark the attachment as `download_failed`.
   *   - Goes through `withRetry` so a 5xx blip self-heals; 4xx fails fast.
   */
  async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file' | 'audio' | 'video' = 'file',
  ): Promise<Buffer> {
    if (!messageId) throw withStatus(new Error('downloadResource: messageId required'), 400);
    if (!fileKey) throw withStatus(new Error('downloadResource: fileKey required'), 400);
    return withRetry(async () => {
      const token = await this.ensureToken();
      const resourceType = type === 'image' ? 'image' : 'file';
      const url = new URL(
        `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`,
      );
      url.searchParams.set('type', resourceType);
      const response = await this.fetcher(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw withStatus(
          new Error(`feishu downloadResource HTTP ${response.status}`),
          response.status,
        );
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length === 0) {
        // Empty body = Feishu rejecting silently. Permanent at this messageId
        // even after retry — surface as 400 so withRetry stops.
        throw withStatus(new Error(`feishu downloadResource empty body`), 400);
      }
      return buffer;
    }, this.retry);
  }

  /**
   * Fetch a message snapshot by Feishu `message_id` so inbound thread/reply
   * events can include the original topic text as quoted context. The OpenAPI
   * response shape has drifted between SDK generations (`data.items[0]`,
   * `data.message`, or `data`), so parsing is intentionally tolerant.
   */
  async getMessage(messageId: string): Promise<FeishuMessageSnapshot | undefined> {
    const id = messageId.trim();
    if (!id) return undefined;
    return withRetry(async () => {
      const token = await this.ensureToken();
      const response = await this.fetcher(
        `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(id)}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const parsed = await this.assertOkAndParse(response, 'getMessage');
      return readFeishuMessageSnapshot(parsed, id);
    }, this.retry);
  }

  /**
   * Fetch the root (first) message of a Feishu thread/topic by its thread id
   * (`omt_…`). The inbound event only carries the thread id, which is NOT a
   * message id — so `GET /im/v1/messages/{id}` fails for it. Instead we list the
   * thread container ascending and take the first message as the topic root.
   */
  async getThreadRootMessage(threadId: string): Promise<FeishuMessageSnapshot | undefined> {
    const id = threadId.trim();
    if (!id) return undefined;
    return withRetry(async () => {
      const token = await this.ensureToken();
      const url = new URL(`${FEISHU_API_BASE}/im/v1/messages`);
      url.searchParams.set('container_id_type', 'thread');
      url.searchParams.set('container_id', id);
      url.searchParams.set('sort_type', 'ByCreateTimeAsc');
      url.searchParams.set('page_size', '1');
      const response = await this.fetcher(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const parsed = await this.assertOkAndParse(response, 'getThreadRootMessage');
      return readFeishuMessageSnapshot(parsed, id);
    }, this.retry);
  }

  async getUserDisplayName(openId: string): Promise<string | undefined> {
    return getFeishuUserDisplayName({
      openId,
      fetcher: this.fetcher,
      ensureToken: () => this.ensureToken(),
      assertOkAndParse: (response, method) => this.assertOkAndParse(response, method),
      cache: this.userNameCache,
    });
  }

  /**
   * Fetch the bot's own display name (Feishu app name) via `GET /bot/v3/info`.
   * This is the name the bot actually shows under in Feishu, as opposed to the
   * placeholder label stored at onboard time. Cached for the sender's lifetime;
   * returns `undefined` on any failure so callers can fall back gracefully.
   */
  async getBotName(): Promise<string | undefined> {
    return (await this.getBotIdentity())?.name;
  }

  async getBotIdentity(): Promise<FeishuBotIdentity | undefined> {
    if (this.cachedBotIdentity !== undefined) return this.cachedBotIdentity ?? undefined;
    let httpStatus: number | null = null;
    let feishuCode: number | null = null;
    try {
      const token = await this.ensureToken();
      const response = await this.fetcher(`${FEISHU_API_BASE}/bot/v3/info`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      httpStatus = response.status;
      const parsed = (await this.assertOkAndParse(response, 'getBotName')) as {
        code?: unknown;
        bot?: { app_name?: unknown; open_id?: unknown };
      };
      feishuCode = responseFeishuCode(parsed);
      const name = typeof parsed.bot?.app_name === 'string' ? parsed.bot.app_name.trim() : '';
      const openId = typeof parsed.bot?.open_id === 'string' ? parsed.bot.open_id.trim() : '';
      const identity = {
        ...(openId ? { openId } : {}),
        ...(name ? { name } : {}),
      };
      const hasIdentity = Boolean(name || openId);
      this.cachedBotIdentity = hasIdentity ? identity : null;
      if (hasIdentity) {
        logger.info(
          { operation: 'feishu_bot_identity', hasName: Boolean(name), hasOpenId: Boolean(openId) },
          'Feishu bot identity resolved',
        );
        return identity;
      }
      logger.warn(
        {
          operation: 'feishu_bot_identity',
          httpStatus,
          feishuCode,
          errorName: 'FeishuBotIdentityEmpty',
        },
        'Feishu bot identity was empty',
      );
      return undefined;
    } catch (error) {
      // Best-effort: cache the miss so we don't hammer the API on every poll.
      this.cachedBotIdentity = null;
      logger.warn(
        {
          operation: 'feishu_bot_identity',
          httpStatus: errorHttpStatus(error) ?? httpStatus,
          feishuCode: errorFeishuCode(error) ?? feishuCode,
          errorName: error instanceof Error && error.name ? error.name : typeof error,
        },
        'Feishu bot identity lookup failed',
      );
      return undefined;
    }
  }

  /** Retry wrapper for media upload and key-message lifecycle logs. */
  private async withLoggedRetry<T>(input: {
    operation: FeishuMediaLogOperation;
    endpoint: string;
    chatId: string;
    metadata: FeishuMediaLogMetadata;
    run: (recordWire: RecordFeishuWireMetadata) => Promise<T>;
  }): Promise<T> {
    let attemptNumber = 0;
    let attemptStartedAt = this.nowMs();
    let wireMetadata: FeishuWireMetadata = { httpStatus: null, feishuCode: null };
    const metadata = input.metadata;
    const log = (
      event: FeishuMediaLogEvent,
      attempt: number,
      durationMs: number,
      err?: unknown,
    ): void => {
      const httpStatus = errorHttpStatus(err) ?? wireMetadata.httpStatus;
      const feishuCode = errorFeishuCode(err) ?? wireMetadata.feishuCode;
      const fields = {
        phase: operationPhase(input.operation, event),
        endpoint: input.endpoint,
        fileType: metadata.fileType,
        msgType: metadata.msgType,
        fileName: metadata.fileName,
        sanitizedBasename: metadata.fileName,
        mimeType: metadata.mimeType,
        sizeBytes: metadata.sizeBytes,
        attempt,
        durationMs,
        httpStatus,
        feishuCode,
        retryStatus: err ? errorRetryStatus(err) : null,
        chatId: input.chatId,
        clientName: this.clientName,
      };
      const message = `Feishu outbound ${fields.phase}`;
      if (event === 'final_failure') {
        logger.error(fields, message);
      } else if (event === 'retry') {
        logger.warn(fields, message);
      } else {
        logger.info(fields, message);
      }
    };

    const callerOnAttemptFailed = this.retry.onAttemptFailed;
    return withRetry(
      async () => {
        attemptNumber += 1;
        wireMetadata = { httpStatus: null, feishuCode: null };
        attemptStartedAt = this.nowMs();
        log('start', attemptNumber, 0);
        const result = await input.run((next) => {
          wireMetadata = { ...wireMetadata, ...next };
        });
        log('success', attemptNumber, Math.max(0, this.nowMs() - attemptStartedAt));
        return result;
      },
      {
        ...this.retry,
        onAttemptFailed: (err, attempt, nextDelayMs) => {
          callerOnAttemptFailed?.(err, attempt, nextDelayMs);
          if (nextDelayMs !== null) {
            log('retry', attempt, Math.max(0, this.nowMs() - attemptStartedAt), err);
          }
        },
      },
      (err, attempt) => {
        log('final_failure', attempt, Math.max(0, this.nowMs() - attemptStartedAt), err);
      },
    );
  }

  private async sendMessage(
    receiveId: string,
    msgType: string,
    content: string,
    receiveIdType: FeishuReceiveIdType,
    thread?: FeishuThreadReply,
    metadata?: FeishuMediaLogMetadata,
    requireMessageId = false,
  ): Promise<FeishuSendResult | undefined> {
    // Thread-aware path: route through the `reply` endpoint with
    // `reply_in_thread: true` so the message lands inside the originating
    // thread/topic. The `receive_id` / `receive_id_type` pair is NOT sent to
    // the reply endpoint — the target is fixed by the anchor message ID.
    const run = async (
      recordWire: RecordFeishuWireMetadata = () => {},
    ): Promise<FeishuSendResult | undefined> => {
      const token = await this.ensureToken();
      let url: string;
      let body: string;
      if (thread?.replyToMessageId) {
        url = `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(
          thread.replyToMessageId,
        )}/reply`;
        body = JSON.stringify({ msg_type: msgType, content, reply_in_thread: true });
      } else {
        const messageUrl = new URL(`${FEISHU_API_BASE}/im/v1/messages`);
        messageUrl.searchParams.set('receive_id_type', receiveIdType);
        url = messageUrl.toString();
        body = JSON.stringify({ receive_id: receiveId, msg_type: msgType, content });
      }
      const response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body,
      });
      const parsed = (await this.assertOkAndParse(
        response,
        thread?.replyToMessageId ? 'replyMessage' : 'sendMessage',
      )) as {
        code?: number;
        data?: { message_id?: string };
      };
      recordWire({ httpStatus: response.status, feishuCode: responseFeishuCode(parsed) });
      const messageId = parsed?.data?.message_id;
      if (typeof messageId === 'string' && messageId.length > 0) return { messageId };
      if (requireMessageId) {
        throw withStatus(new Error('feishu message missing message_id'), 500);
      }
      return undefined;
    };
    if (!metadata) return withRetry(() => run(), this.retry);
    return this.withLoggedRetry({
      operation: 'message',
      endpoint: thread?.replyToMessageId ? '/im/v1/messages/reply' : '/im/v1/messages',
      chatId: receiveId,
      metadata,
      run,
    });
  }

  /** Resolve raw bytes for a media ref. `http(s)://` / `file://` / abs path only. */
  private async resolveBytes(path: string): Promise<Buffer> {
    if (/^https?:\/\//iu.test(path)) {
      const response = await this.fetcher(path, { method: 'GET' });
      if (!response.ok) {
        throw withStatus(new Error(`fetch media HTTP ${response.status}`), response.status);
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }
    let localPath = path;
    if (/^file:\/\//iu.test(localPath)) {
      localPath = decodeURIComponent(localPath.replace(/^file:\/\//iu, ''));
    }
    const schemeMatch = localPath.match(/^([a-z][a-z0-9+.-]*):\/\//iu);
    if (schemeMatch) {
      const scheme = (schemeMatch[1] ?? '').toLowerCase();
      if (scheme === 'sandbox' || scheme === 'sandbox-job') {
        throw withStatus(
          new Error('agent 引用 sandbox 文件但无解析器；请让 agent 调用图片生成工具返回 https URL'),
          400,
        );
      }
      throw withStatus(new Error(`unsupported media path scheme "${scheme}"`), 400);
    }
    return readFile(localPath);
  }

  /**
   * Return a non-stale tenant_access_token. Mints a new one when the cache
   * is empty or within the safety window of expiry.
   *
   * Feishu returns `{ code: 0, msg: 'success', tenant_access_token, expire }`
   * with `expire` in **seconds** (NOT ms). A non-zero `code` is a permanent
   * auth failure (bad credentials / disabled app); we surface it as a 401
   * so `withRetry` does not loop on it.
   */
  private async ensureToken(): Promise<string> {
    const now = this.nowMs();
    const cached = this.cachedToken;
    if (cached && cached.expiresAtMs - this.tokenSafetyWindowMs > now) {
      return cached.token;
    }
    const response = await this.fetcher(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    if (!response.ok) {
      throw withStatus(
        new Error(`feishu tenant_access_token HTTP ${response.status}`),
        response.status,
        undefined,
        response.status,
      );
    }
    const parsed = (await response.json().catch(() => undefined)) as
      | {
          code?: number;
          tenant_access_token?: string;
          expire?: number;
        }
      | undefined;
    if (!parsed || parsed.code !== 0) {
      throw withStatus(
        new Error(`feishu tenant_access_token rejected`),
        401,
        typeof parsed?.code === 'number' ? parsed.code : undefined,
        response.status,
      );
    }
    const token = parsed.tenant_access_token;
    const expire = parsed.expire;
    if (typeof token !== 'string' || !token || typeof expire !== 'number' || expire <= 0) {
      throw withStatus(new Error(`feishu tenant_access_token malformed`), 500);
    }
    this.cachedToken = { token, expiresAtMs: now + expire * 1000 };
    return token;
  }

  /**
   * Throw on a non-2xx Feishu response; otherwise parse JSON. The Feishu API
   * uses HTTP 200 + `code !== 0` for business failures, so we ALSO check
   * `code` here and map non-zero to the corresponding HTTP-ish status — 4xx
   * for auth/validation, 5xx for everything else — so `withRetry` classifies
   * permanent vs transient correctly.
   */
  private async assertOkAndParse(response: Response, method: string): Promise<unknown> {
    if (!response.ok) {
      throw withStatus(
        new Error(`feishu ${method} HTTP ${response.status}`),
        response.status,
        undefined,
        response.status,
      );
    }
    const parsed = (await response.json().catch(() => undefined)) as
      | { code?: number; msg?: string }
      | undefined;
    if (!parsed) {
      throw withStatus(
        new Error(`feishu ${method} non-json body`),
        500,
        undefined,
        response.status,
      );
    }
    if (parsed.code !== 0) {
      const status = mapFeishuCodeToStatus(parsed.code ?? -1);
      throw withStatus(
        new Error(`feishu ${method} code=${parsed.code}`),
        status,
        parsed.code,
        response.status,
      );
    }
    return parsed;
  }
}

/**
 * Reference: https://open.feishu.cn/document/server-docs/api-call-guide/server-api-error-code
 */
function mapFeishuCodeToStatus(code: number): number {
  // Known auth / validation buckets per Feishu docs.
  if (code === 99991661 || code === 99991663 || code === 99991664) return 401; // token expired/invalid
  if (code === 99991668 || code === 99991669) return 403; // permission denied
  if (code === 230001 || code === 230002 || code === 230006) return 400; // validation
  if (code === 230020 || code === 230032 || code === 230034) return 400; // bad receive_id
  return 500;
}

/** Attach safe HTTP/Feishu fields to an error without retaining raw responses. */
function withStatus(
  err: Error,
  status: number,
  feishuCode?: number,
  httpStatus?: number,
): Error & { status: number; httpStatus?: number; feishuCode?: number } {
  const typed = err as Error & { status: number; httpStatus?: number; feishuCode?: number };
  typed.status = status;
  if (httpStatus !== undefined) typed.httpStatus = httpStatus;
  if (feishuCode !== undefined) typed.feishuCode = feishuCode;
  return typed;
}

function readFeishuMessageSnapshot(
  parsed: unknown,
  fallbackMessageId: string,
): FeishuMessageSnapshot | undefined {
  const root = isRecord(parsed) ? parsed : undefined;
  const data = root && isRecord(root.data) ? root.data : undefined;
  const item =
    firstRecord(data?.items) ??
    (data && isRecord(data.message) ? data.message : undefined) ??
    (data && looksLikeMessage(data) ? data : undefined);
  if (!item) return undefined;

  const body = isRecord(item.body) ? item.body : undefined;
  const sender = isRecord(item.sender) ? item.sender : undefined;
  const senderIdRecord = sender && isRecord(sender.sender_id) ? sender.sender_id : undefined;
  const senderIdObject = sender && isRecord(sender.id) ? sender.id : undefined;

  const snapshot: FeishuMessageSnapshot = {
    messageId: readFirstString(item, ['message_id', 'messageId']) ?? fallbackMessageId,
  };
  const messageType = readFirstString(item, ['msg_type', 'msgType', 'message_type', 'messageType']);
  if (messageType) snapshot.messageType = messageType;
  const content = body && 'content' in body ? body.content : item.content;
  if (content !== undefined) snapshot.content = content;
  const senderId =
    (sender ? readFirstString(sender, ['id', 'open_id', 'user_id', 'union_id']) : undefined) ??
    (senderIdRecord
      ? readFirstString(senderIdRecord, ['open_id', 'user_id', 'union_id'])
      : undefined) ??
    (senderIdObject
      ? readFirstString(senderIdObject, ['open_id', 'user_id', 'union_id'])
      : undefined);
  if (senderId) snapshot.senderId = senderId;
  const senderName =
    readFirstString(item, ['senderName', 'sender_name']) ??
    (sender
      ? readFirstString(sender, ['senderName', 'sender_name', 'name', 'nickname'])
      : undefined);
  if (senderName) snapshot.senderName = senderName;
  return snapshot;
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find(isRecord);
}

function looksLikeMessage(value: Record<string, unknown>): boolean {
  return Boolean(
    readFirstString(value, ['message_id', 'messageId']) ||
    'body' in value ||
    'content' in value ||
    readFirstString(value, ['msg_type', 'msgType', 'message_type', 'messageType']),
  );
}

function readFirstString(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
