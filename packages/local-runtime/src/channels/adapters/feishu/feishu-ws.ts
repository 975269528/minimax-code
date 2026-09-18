import { writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import type { ChannelInboundAttachmentRef, ChannelInboundEnvelope } from '../../envelope.js';
import type { LocalFeishuBindingRecord } from '../../feishu.js';
import type { LocalMessageAttachment, LocalMessageQuotedMessage } from '../../../messages/input.js';
import type { LocalChannelPreflightResult } from '../../infra.js';
import { buildReplyCard, buildThinkingCard } from './feishu-card.js';
import {
  isElectronNetFetchByteStringError,
  resolveInboundAttachments,
  type FeishuWsAttachmentDownloader,
} from './feishu-inbound-attachments.js';
import type { FeishuSender } from './feishu-sender.js';
import { imLogger as logger } from '../../../common/im-logger.js';

export type { FeishuWsAttachmentDownloader } from './feishu-inbound-attachments.js';

/**
 * Helper used by `FeishuPlatformAdapter.startWebSocket` to keep the adapter
 * file under the 500-line layout budget. Dynamically imports the Feishu SDK
 * (`@larksuiteoapi/node-sdk`), registers the `im.message.receive_v1` handler
 * via the SDK's `EventDispatcher`, and starts the supplied WS client.
 *
 * Inbound side-effects (best-effort, never blocks dispatch):
 *   1. Access-control preflight (when wired) against the normalized envelope.
 *   2. 👀 `OnIt` reaction on the inbound message id.
 *   3. Grey "🤔 Thinking…" placeholder card recorded in
 *      {@link FeishuPendingThinkingStore} so the outbound client can PATCH
 *      it into the final reply.
 *   4. Resolve `envelope.attachmentRefs` to local `LocalMessageAttachment[]`
 *      via the supplied `attachmentDownloader` (`messages/{id}/resources/{key}`).
 *      Multimodal inbound (image / file / audio / video) **must** go through
 *      this hop or the agent never sees the binary payload.
 *
 * Architecture-redline note: this helper does NOT bring back any IM Gateway
 * runtime. It is invoked from inside Local Runtime and only proxies the SDK
 * for receive-side decoding.
 */
export interface FeishuWsClientLike {
  start(input: { eventDispatcher?: unknown }): Promise<void> | void;
  close?(): Promise<void> | void;
}

/**
 * In-memory map `(chatId → { messageId, createdAtMs, inboundMessageId })` of
 * grey "Thinking…" cards the WS layer has rendered but the outbound client
 * has not patched yet. The host owns the map and shares it with both layers
 * so neither needs persistence.
 */
export interface FeishuPendingThinkingCard {
  messageId: string;
  createdAtMs: number;
  inboundMessageId?: string;
}

export type FeishuPendingThinkingStore = Map<string, FeishuPendingThinkingCard>;

/**
 * In-memory map `(inbound messageId → { reactionId, createdAtMs })` of 👀
 * `OnIt` ack reactions the WS layer has posted but the outbound side has not
 * revoked yet. The host owns the map and shares it with the WS dispatcher
 * (writer) and the outbound client / adapter (consumers via
 * {@link removeAckReaction}) so neither needs persistence. Entries older than
 * {@link PENDING_REACTION_TTL_MS} are swept opportunistically on insert —
 * a turn that never delivers a reply must not leak entries forever.
 */
export type FeishuPendingReactionStore = Map<string, { reactionId: string; createdAtMs: number }>;

/** Pending-ack entries older than this are swept (reply never delivered). */
const PENDING_REACTION_TTL_MS = 10 * 60_000;
const FEISHU_RESOURCE_ERROR_REPLY =
  '抱歉，这个文件暂时没能接收成功。请尝试将文件名中的中文改为英文或数字，保留扩展名后重新发送。';

/**
 * Revoke the 👀 `OnIt` inbound ack reaction after the final reply for
 * `inboundMessageId` has been delivered. Shared by the two completion-side
 * callers (`FeishuPlatformAdapter.sendMessage` and
 * `LocalFeishuChannelClient.deliver`) so the semantics stay identical:
 *
 *   - missing store / missing inbound id → no-op (nothing to revoke);
 *   - the entry is deleted from the store up-front (success or failure —
 *     a failed removal must not be retried on the next turn with a stale id);
 *   - the actual `remove` call is best-effort: failures are logged at warn
 *     (no message bodies) and never thrown, so a reaction outage can never
 *     break an already-delivered reply.
 */
export async function removeAckReaction(input: {
  store: FeishuPendingReactionStore | undefined;
  inboundMessageId: string | undefined;
  remove: (messageId: string, reactionId: string) => Promise<void>;
}): Promise<void> {
  const { store, inboundMessageId } = input;
  if (!store || !inboundMessageId) return;
  const entry = store.get(inboundMessageId);
  if (!entry) return;
  store.delete(inboundMessageId);
  try {
    await input.remove(inboundMessageId, entry.reactionId);
  } catch (err) {
    logger.warn(
      { messageId: inboundMessageId, err: err instanceof Error ? err.message : String(err) },
      'Feishu ack reaction removal failed',
    );
  }
}

export async function startFeishuEventDispatcher(input: {
  record: Pick<LocalFeishuBindingRecord, 'verificationToken' | 'encryptKey'>;
  clientFactory: () => Promise<FeishuWsClientLike>;
  /**
   * The `feishu:<agentName>` client id used for observability only. Pass
   * through so the low-level `Feishu WS client starting/started` log lines
   * are attributable to a specific agent in multi-agent deployments (before
   * this, both agents' logs were indistinguishable).
   */
  clientName?: string;
  normalizeInbound: (data: unknown) => Promise<ChannelInboundEnvelope>;
  dispatchInbound: (message: {
    ctx: ChannelInboundEnvelope['ctx'];
    text: string;
    eventId?: string;
    attachments?: LocalMessageAttachment[];
    quotedMessage?: LocalMessageQuotedMessage;
    preflight?: Extract<LocalChannelPreflightResult, { allowed: true }>['token'];
  }) => Promise<unknown>;
  /** Shared access-control gate run before any Feishu platform side effect. */
  preflightInbound?: (input: {
    ctx: ChannelInboundEnvelope['ctx'];
    text: string;
    eventId?: string;
  }) => Promise<LocalChannelPreflightResult>;
  sender?: FeishuSender;
  pendingThinkingStore?: FeishuPendingThinkingStore;
  /**
   * Optional shared store of pending 👀 `OnIt` ack reactions (keyed by
   * inbound messageId). When wired, the reaction id minted by `addReaction`
   * is recorded here so the outbound completion side can revoke the ack via
   * {@link removeAckReaction} once the final reply lands. Missing → the
   * reaction is posted fire-and-forget and never removed (legacy behaviour).
   */
  pendingReactionStore?: FeishuPendingReactionStore;
  botName?: string;
  /**
   * Optional downloader. When wired, image/file/audio/video refs from the
   * inbound envelope are resolved to local files before dispatch so the
   * agent actually receives the binary content. Missing → multimodal
   * inbound degrades to text-only placeholder (`[Image]` / `[File]`).
   */
  attachmentDownloader?: FeishuWsAttachmentDownloader;
  /**
   * Optional handler for Feishu `card.action.trigger` events. Card 2.0 form
   * submissions (questionnaires) arrive here — the handler decodes the
   * submit value and routes the answers back into the questionnaire
   * bridge. The return value is fed back to Feishu as the card-action
   * response (e.g. `{ toast: { type: 'success', content: '...' } }`); a
   * non-object result is normalised to `{}`. Errors are swallowed so the
   * WS dispatcher does not break on a single bad submit.
   */
  onCardAction?: (data: unknown) => Promise<unknown> | unknown;
}): Promise<FeishuWsClientLike> {
  const sdkSpecifier = '@larksuiteoapi/node-sdk';
  const sdk = (await import(sdkSpecifier)) as unknown as {
    EventDispatcher: new (params: { verificationToken?: string; encryptKey?: string }) => {
      register(handles: Record<string, (data: unknown) => Promise<unknown>>): unknown;
    };
  };
  const dispatcher = new sdk.EventDispatcher({
    ...(input.record.verificationToken
      ? { verificationToken: input.record.verificationToken }
      : {}),
    ...(input.record.encryptKey ? { encryptKey: input.record.encryptKey } : {}),
  });
  // Per-process dedup of `(eventId | messageId)` seen in the last DEDUP_TTL_MS.
  // Feishu WS occasionally redelivers the same `im.message.receive_v1` (we've
  // observed it after a slow turn) — without dedup we render a second grey
  // "Thinking…" card, which never gets patched because the runner short-circuits
  // the duplicated turn on `infra.handleInbound`'s own eventDedupCache.
  const seenKeys = new Map<string, number>();
  const DEDUP_TTL_MS = 60_000;
  dispatcher.register({
    'im.message.receive_v1': async (data: unknown) => {
      const envelope = await input.normalizeInbound(data);
      logger.info(
        {
          chatId: envelope.ctx.chatId,
          messageId: envelope.messageId ?? null,
          eventId: envelope.eventId ?? null,
          attachmentRefs: envelope.attachmentRefs?.length ?? 0,
        },
        'Feishu websocket message received',
      );
      // Dedup key: prefer eventId, fall back to messageId.
      const dedupKey = envelope.eventId ?? envelope.messageId;
      if (dedupKey) {
        const now = Date.now();
        // Sweep old entries cheaply.
        for (const [k, ts] of seenKeys) {
          if (now - ts > DEDUP_TTL_MS) seenKeys.delete(k);
        }
        if (seenKeys.has(dedupKey)) {
          logger.info({ dedupKey }, 'Feishu websocket duplicate message dropped');
          return;
        }
        seenKeys.set(dedupKey, now);
      }
      const text = ensureInboundText(envelope.text, envelope.attachmentRefs);
      const preflight = input.preflightInbound
        ? await input.preflightInbound({
            ctx: envelope.ctx,
            text,
            ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
          })
        : undefined;
      if (preflight && !preflight.allowed) return;
      let ackReactionId: string | undefined;
      let ackReactionPromise: Promise<void> | undefined;
      if (input.sender && envelope.messageId) {
        const ackMessageId = envelope.messageId;
        ackReactionPromise = input.sender
          .addReaction(ackMessageId, 'OnIt')
          .then((reactionId) => {
            ackReactionId = reactionId;
            const store = input.pendingReactionStore;
            if (!store || !reactionId) return;
            // Sweep entries whose reply never delivered (mirrors the
            // `seenKeys` sweep above) so the map cannot grow unbounded.
            const now = Date.now();
            for (const [k, entry] of store) {
              if (now - entry.createdAtMs > PENDING_REACTION_TTL_MS) store.delete(k);
            }
            store.set(ackMessageId, { reactionId, createdAtMs: now });
          })
          .catch((err) => {
            logger.warn(
              {
                chatId: envelope.ctx.chatId,
                err: err instanceof Error ? err.message : String(err),
              },
              'Feishu inbound ack reaction failed',
            );
          });
        void ackReactionPromise;
      }
      if (input.sender && input.pendingThinkingStore && envelope.ctx.chatId) {
        const chatId = envelope.ctx.chatId;
        const inboundMessageId = envelope.messageId;
        const existing = input.pendingThinkingStore.get(chatId);
        if (!existing) {
          try {
            const card = buildThinkingCard(input.botName);
            // Thread-aware: when the inbound message lived inside a Feishu
            // thread/topic, post the thinking card into that thread too, so the
            // later PATCH-into-final-reply also stays in-thread.
            const thread =
              envelope.ctx.threadId && inboundMessageId
                ? { replyToMessageId: inboundMessageId }
                : undefined;
            const result = await input.sender.sendCard(chatId, card, 'chat_id', thread);
            if (result?.messageId) {
              input.pendingThinkingStore.set(chatId, {
                messageId: result.messageId,
                createdAtMs: Date.now(),
                ...(inboundMessageId ? { inboundMessageId } : {}),
              });
            }
          } catch {
            /* swallow — thinking card is best-effort */
          }
        }
      }
      let attachments: LocalMessageAttachment[];
      try {
        attachments = await resolveInboundAttachments(envelope, input.attachmentDownloader);
      } catch (err) {
        if (!isElectronNetFetchByteStringError(err)) throw err;
        await handleFeishuResourceError({
          sender: input.sender,
          chatId: envelope.ctx.chatId,
          thread:
            envelope.ctx.threadId && envelope.messageId
              ? { replyToMessageId: envelope.messageId }
              : undefined,
          pendingThinkingStore: input.pendingThinkingStore,
          pendingReactionStore: input.pendingReactionStore,
          inboundMessageId: envelope.messageId,
          ackReactionPromise,
          ackReactionId: () => ackReactionId,
        });
        return;
      }
      await input.dispatchInbound({
        ctx: envelope.ctx,
        text,
        ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(envelope.quotedMessage ? { quotedMessage: envelope.quotedMessage } : {}),
        ...(preflight?.allowed ? { preflight: preflight.token } : {}),
      });
    },
    'card.action.trigger': async (data: unknown) => {
      logger.info({}, 'Feishu websocket card action triggered');
      if (!input.onCardAction) return {};
      try {
        const result = await input.onCardAction(data);
        return result && typeof result === 'object' ? result : {};
      } catch (err) {
        logger.warn({ err }, 'Feishu websocket card action handler failed');
        return {};
      }
    },
  });
  const client = await input.clientFactory();
  const logCtx = input.clientName ? { clientName: input.clientName } : {};
  logger.info(logCtx, 'Feishu WS client starting');
  await client.start({ eventDispatcher: dispatcher });
  logger.info(logCtx, 'Feishu WS client started');
  return client;
}

async function handleFeishuResourceError(input: {
  sender: FeishuSender | undefined;
  chatId: string;
  thread?: { replyToMessageId: string };
  pendingThinkingStore?: FeishuPendingThinkingStore;
  pendingReactionStore?: FeishuPendingReactionStore;
  inboundMessageId?: string;
  ackReactionPromise?: Promise<void>;
  ackReactionId: () => string | undefined;
}): Promise<void> {
  const { sender } = input;
  if (!sender) return;
  let replyDelivered = false;
  const pendingThinking = input.pendingThinkingStore?.get(input.chatId);
  if (pendingThinking) {
    input.pendingThinkingStore?.delete(input.chatId);
    try {
      await sender.patchCard(
        pendingThinking.messageId,
        buildReplyCard(FEISHU_RESOURCE_ERROR_REPLY),
      );
      replyDelivered = true;
    } catch {
      // Fall through to a text reply when the transient card can no longer be patched.
    }
  }
  if (!replyDelivered) {
    try {
      await sender.sendText(input.chatId, FEISHU_RESOURCE_ERROR_REPLY, 'chat_id', input.thread);
      replyDelivered = true;
    } catch (err) {
      logger.warn(
        {
          chatId: input.chatId,
          errorType: err instanceof Error ? err.name : typeof err,
        },
        'Feishu resource error reply failed',
      );
    }
  }
  await input.ackReactionPromise?.catch(() => undefined);
  const reactionId = input.ackReactionId();
  if (!reactionId || !input.inboundMessageId) return;
  if (input.pendingReactionStore?.has(input.inboundMessageId)) {
    await removeAckReaction({
      store: input.pendingReactionStore,
      inboundMessageId: input.inboundMessageId,
      remove: (messageId, currentReactionId) => sender.removeReaction(messageId, currentReactionId),
    });
    return;
  }
  try {
    await sender.removeReaction(input.inboundMessageId, reactionId);
  } catch (err) {
    logger.warn(
      {
        chatId: input.chatId,
        errorType: err instanceof Error ? err.name : typeof err,
      },
      'Feishu resource error ack cleanup failed',
    );
  }
}

function ensureInboundText(text: string, refs: ChannelInboundAttachmentRef[] | undefined): string {
  if (text.trim()) return text;
  if (!refs || refs.length === 0) return text;
  // Empty body + media-only message — feed the agent a stable placeholder so
  // it has *something* to react to. Mirrors historical `lark.ts` behaviour.
  const primary = refs[0]!;
  if (primary.type === 'image') return '[图片]';
  if (primary.type === 'audio') return '[语音]';
  if (primary.type === 'video') return '[视频]';
  return `[文件] ${primary.name ?? primary.key ?? ''}`.trim();
}

/**
 * Build a {@link FeishuWsAttachmentDownloader} backed by a {@link FeishuSender}.
 * Used by the host wiring to share one sender (token cache + retry policy)
 * between outbound delivery and inbound resource downloads. Writes the bytes
 * under `<dataDir>/tmp/im-attachments/feishu/<sessionId>/<safeName>` and
 * returns the resolved {@link LocalMessageAttachment}.
 *
 * Naming is best-effort: prefers `ref.name`, falls back to `<key><ext>` where
 * `<ext>` is inferred from the ref type (`.png` / `.opus` / `.mp4` / `.bin`).
 * Path separators in `ref.name` are scrubbed to keep the file scope-local.
 */
export function makeFeishuWsAttachmentDownloader(input: {
  /** Lazy sender provider — adapter creates the sender on demand. */
  senderProvider: () => Promise<FeishuSender>;
  dataDir: () => string;
}): FeishuWsAttachmentDownloader {
  return async ({ messageId, ref, sessionId }) => {
    const sender = await input.senderProvider();
    const type = ref.type;
    const buffer = await sender.downloadResource(messageId, ref.key, type);
    const fileName = sanitizeFileName(ref.name ?? `${ref.key}${defaultExt(type)}`, type);
    const dir = join(input.dataDir(), 'tmp', 'im-attachments', 'feishu', sanitizeScope(sessionId));
    await ensureDir(dir);
    const filePath = join(dir, `${messageId}_${fileName}`);
    await writeFile(filePath, buffer);
    return {
      type: type === 'image' ? 'image' : 'file',
      filePath,
      fileName,
      mimeType: ref.mimeType ?? defaultMime(type),
    };
  };
}

function sanitizeFileName(name: string, type: ChannelInboundAttachmentRef['type']): string {
  const cleaned = basename(name)
    .replace(/[/\\?%*:|"<>\s]/gu, '_')
    .slice(0, 120);
  if (cleaned && extname(cleaned)) return cleaned;
  return `${cleaned || 'attachment'}${defaultExt(type)}`;
}

function sanitizeScope(scope: string): string {
  return scope.replace(/[/\\?%*:|"<>\s]/gu, '_').slice(0, 120) || 'unknown';
}

function defaultExt(type: ChannelInboundAttachmentRef['type']): string {
  if (type === 'image') return '.png';
  if (type === 'audio') return '.opus';
  if (type === 'video') return '.mp4';
  return '.bin';
}

function defaultMime(type: ChannelInboundAttachmentRef['type']): string {
  if (type === 'image') return 'image/png';
  if (type === 'audio') return 'audio/opus';
  if (type === 'video') return 'video/mp4';
  return 'application/octet-stream';
}

async function ensureDir(dir: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
}
