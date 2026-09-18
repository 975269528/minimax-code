import { createHash, randomUUID } from 'node:crypto';

import { json, readFirstString } from '../api/http-helpers.js';
import type { LocalMessageAttachment, LocalMessageQuotedMessage } from '../messages/input.js';
import type {
  LocalChannelContext,
  LocalChannelSlashCommand,
  LocalChannelSlashCommandName,
} from './infra.js';
import type { ChannelPlatform } from './route-api.js';

/**
 * Single source of truth for the local-runtime IM slash commands. The parser
 * allowlist, the `LocalChannelSlashCommandName` union (`infra.ts`) and the
 * `handleSlashCommand` dispatch registry all derive from this constant so a
 * new command is added in exactly one place. `/pin` is intentionally NOT
 * listed — the slash command was retired (see
 * knowledge/proposals/im-slash-compact-command.md §2.1). The historical
 * `bindingStore.pin()` storage API and `SessionStrategy='pin'` value remain
 * only to read old data; routing treats them as the normal Root strategy.
 *
 * `/btw` is intentionally hidden this iteration — it is NOT a supported command
 * for now. The parser therefore treats `/btw …` as an ordinary message (returns
 * undefined → normal enqueue → LLM), same as retired `/pin`. The handler code
 * (`handleBtwCommand`) is kept dormant in `infra.ts` so it can be restored in a
 * single line next iteration: add `'btw'` back here + re-add the `btw:` entry to
 * the `handleSlashCommand` registry.
 */
export const LOCAL_CHANNEL_SLASH_COMMANDS = ['new', 'clear', 'stop', 'compact'] as const;

export function parseLocalChannelSlashCommand(text: string): LocalChannelSlashCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return undefined;
  // Tolerate an optional `@botusername` suffix on the command token. Telegram
  // appends it to every command sent in a group chat (`/new@mybot`); Bot API
  // documents commands as `/command@botusername`. Stripping it here keeps slash
  // parsing consistent across all IM platforms and independent of whether the
  // adapter knows the bot's own @-handle.
  const match = trimmed.match(/^\/([a-z][\w-]*)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/iu);
  if (!match) return undefined;
  const raw = match[1]?.toLowerCase();
  const args = match[2]?.trim() ?? '';
  if (raw && (LOCAL_CHANNEL_SLASH_COMMANDS as readonly string[]).includes(raw)) {
    return { name: raw as LocalChannelSlashCommandName, args };
  }
  return undefined;
}

export function buildLocalChannelBindingKey(ctx: LocalChannelContext): string {
  return [
    ctx.platform,
    ctx.clientName,
    ctx.chatId,
    ctx.senderId,
    ctx.threadId ?? '',
    ctx.lane ?? 'interactive',
  ]
    .map((part) => encodeURIComponent(part))
    .join(':');
}

/**
 * Makes a Conversation mutation receipt key from the transport identity that
 * scopes an inbound event. Platform event ids are not globally unique across
 * channel clients or chats, while direct callers may have no event id at all.
 */
export function buildLocalChannelInboundRequestId(
  ctx: LocalChannelContext,
  eventId?: string,
): string {
  const sourceId = eventId?.trim() || ctx.sourceMessageId?.trim();
  if (!sourceId) return `channel-inbound:${randomUUID()}`;
  return ['channel-inbound', ctx.platform, ctx.clientName, ctx.chatId, sourceId]
    .map((part) => encodeURIComponent(part))
    .join(':');
}

/**
 * Stable correlation key for persistent IM observability. The underlying
 * receipt id includes transport identifiers and must remain private to the
 * mutation protocol, so logs record only this hash.
 */
export function buildLocalChannelInboundRequestKey(
  ctx: LocalChannelContext,
  eventId?: string,
): string {
  return hashLocalChannelRequestId(buildLocalChannelInboundRequestId(ctx, eventId));
}

export function hashLocalChannelRequestId(requestId: string): string {
  return createHash('sha256').update(requestId, 'utf8').digest('hex');
}

export function readChannelContext(
  body: Record<string, unknown>,
): { ctx: LocalChannelContext } | { error: Response } {
  const platform = normalizePlatform(readFirstString(body, ['platform']));
  const chatType = readFirstString(body, ['chatType', 'chat_type']) ?? 'private';
  const chatId = readFirstString(body, ['chatId', 'chat_id', 'channelId', 'channel_id']);
  const senderId = readFirstString(body, ['senderId', 'sender_id', 'userId', 'user_id']);
  if (!platform || !chatId || !senderId) {
    return {
      error: json(
        { error: 'platform, chatId, and senderId are required', code: 'VALIDATION_ERROR' },
        { status: 400 },
      ),
    };
  }
  return {
    ctx: {
      platform,
      chatType,
      chatId,
      senderId,
      clientName: readFirstString(body, ['clientName', 'client_name']) ?? '',
      ...(readFirstString(body, ['threadId', 'thread_id'])
        ? { threadId: readFirstString(body, ['threadId', 'thread_id']) }
        : {}),
      ...(readFirstString(body, ['lane']) ? { lane: readFirstString(body, ['lane']) } : {}),
      hasMention: body.hasMention === true || body.mentioned === true,
    },
  };
}

export function readOptionalInboundExtras(body: Record<string, unknown>): {
  attachments?: LocalMessageAttachment[];
  quotedMessage?: LocalMessageQuotedMessage;
  eventId?: string;
} {
  return {
    ...(Array.isArray(body.attachments) && body.attachments.length > 0
      ? { attachments: readAttachments(body.attachments) }
      : {}),
    ...(hasQuotedMessage(body) ? { quotedMessage: readQuotedMessage(body) } : {}),
    ...(hasEventId(body) ? { eventId: readEventId(body) } : {}),
  };
}

function readAttachments(raw: unknown[]): LocalMessageAttachment[] {
  const result: LocalMessageAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const filePath = readFirstString(obj, ['filePath', 'file_path']);
    const dataUrl = readFirstString(obj, ['dataUrl', 'data_url']);
    if (!filePath && !dataUrl) continue;
    const mimeType = readFirstString(obj, ['mimeType', 'mime_type']) ?? '';
    const type: 'file' | 'image' =
      obj.type === 'image' || mimeType.startsWith('image/') ? 'image' : 'file';
    const fileName =
      readFirstString(obj, ['fileName', 'file_name']) ??
      (filePath ? (filePath.split('/').pop() ?? 'attachment') : 'attachment');
    const assetId = readFirstString(obj, ['assetId', 'asset_id']);
    result.push({
      type,
      filePath: filePath ?? '',
      fileName,
      mimeType,
      ...(dataUrl ? { dataUrl } : {}),
      ...(assetId ? { assetId } : {}),
    });
  }
  return result;
}

function hasQuotedMessage(body: Record<string, unknown>): boolean {
  const raw = body.quotedMessage ?? body.quoted_message;
  return Boolean(raw && typeof raw === 'object' && !Array.isArray(raw));
}

function readQuotedMessage(body: Record<string, unknown>): LocalMessageQuotedMessage | undefined {
  const raw = body.quotedMessage ?? body.quoted_message;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const text = readFirstString(obj, ['text', 'content']);
  if (!text) return undefined;
  return {
    text,
    ...(readFirstString(obj, ['senderName', 'sender_name'])
      ? { senderName: readFirstString(obj, ['senderName', 'sender_name']) as string }
      : {}),
  };
}

function hasEventId(body: Record<string, unknown>): boolean {
  return Boolean(readEventId(body));
}

function readEventId(body: Record<string, unknown>): string | undefined {
  return readFirstString(body, [
    'eventId',
    'event_id',
    'updateId',
    'update_id',
    'messageId',
    'message_id',
  ]);
}

function normalizePlatform(value: string | undefined): ChannelPlatform | undefined {
  if (value === 'feishu' || value === 'telegram' || value === 'wechat') return value;
  return undefined;
}
