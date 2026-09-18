import { basename, extname } from 'node:path';

import type { AgentMessage } from '@mavis/agent-core/protocol/agent-message';
import type { MultimodalAttachmentCapabilities } from '@mavis/agent-tools';
import { resolveNativeImageMime } from './native-image-mime.js';
import { resolveNativeVideoMime } from './user-media.js';

export {
  LOCAL_USER_IMAGE_MAX_BASE64_BODY_BYTES,
  loadUserImages,
  loadUserImagesForMessages,
  loadUserMediaCandidatesForMessages,
  maxModelImageBytesForBatch,
  type LocalUserMediaCandidate,
} from './user-media.js';

const TEXT_ATTACHMENT_MIME_PREFIXES = ['text/'];
const TEXT_ATTACHMENT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/javascript',
  'application/typescript',
  'image/svg+xml',
]);
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.tsv',
  '.xml',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.css',
  '.html',
  '.log',
  '.svg',
]);

export interface LocalMessageAttachment {
  type: 'file' | 'image';
  filePath: string;
  fileName: string;
  mimeType: string;
  desktopPath?: string;
  dataUrl?: string;
  assetId?: string;
  /**
   * Download failure marker. When set, `filePath` may be empty (or
   * point to a placeholder); downstream code should treat the
   * attachment as a text-only marker instead of fetching bytes from
   * disk. Per-platform sentinel values:
   *   - 'iLink_api_pending'  — WeChat iLink protocol not yet confirmed (P1-D)
   *   - 'download_failed'    — platform SDK rejected the download (P1-B / P1-C)
   */
  error?: string;
}

/** Quoted message context for IM reply-in-thread. */
export interface LocalMessageQuotedMessage {
  /** Text content of the quoted message. */
  text: string;
  /** Display name of the quoted message sender (if available). */
  senderName?: string;
}

/** Channel origin metadata attached to IM-sourced messages. */
export interface LocalMessageChannelContext {
  platform: string;
  chatType: string;
  chatId: string;
  senderId: string;
  clientName: string;
  /**
   * Thread/topic the inbound message lived in (Telegram forum topic /
   * Feishu thread). Present only for genuinely threaded messages; used to
   * route turn-scoped outbound (e.g. permission cards) back into the thread.
   */
  threadId?: string;
  sourceMessageId?: string;
  contextToken?: string;
}

export interface LocalMessageInput {
  content: string;
  attachments: LocalMessageAttachment[];
  queueItemId?: string;
  /** Optional protocol source for history-only synthetic user messages (e.g. cron reports). */
  source?: string;
  /** Optional structured origin metadata forwarded to UI renderers. */
  origin?: unknown;
  /** Present when the user replied to a specific message in an IM channel. */
  quotedMessage?: LocalMessageQuotedMessage;
  /** Present when the message originated from an IM channel (feishu/telegram/wechat). */
  channelContext?: LocalMessageChannelContext;
}

export function readLocalMessageInputs(data: Record<string, unknown>): LocalMessageInput[] {
  const primary: LocalMessageInput = {
    content: readString(data, 'content') ?? '',
    attachments: readAttachments(data),
    ...(readFirstString(data, ['queueItemId', 'queue_item_id'])
      ? { queueItemId: readFirstString(data, ['queueItemId', 'queue_item_id']) }
      : {}),
    ...readOptionalProtocolMetadata(data),
    ...readOptionalQuotedMessage(data),
    ...readOptionalChannelContext(data),
  };
  const queuedMessages = readQueuedLocalMessages(data);
  if (primary.content.length > 0 || primary.attachments.length > 0 || queuedMessages.length === 0) {
    return [primary, ...queuedMessages];
  }
  return queuedMessages;
}

export function buildLocalPromptText(messages: LocalMessageInput[]): string {
  if (messages.length === 1) {
    const message = messages[0];
    const raw = message?.content ?? '';
    const withQuote = prependQuotedContext(raw, message?.quotedMessage);
    return prependCronTaskContext(withQuote, message);
  }

  const renderedMessages = messages.map((message, index) => {
    const label = index === 0 ? 'User message 1' : `Queued user message ${index + 1}`;
    const withQuote = prependQuotedContext(message.content, message.quotedMessage);
    const withSourceContext = prependCronTaskContext(withQuote, message);
    return [`${label}:`, withSourceContext].join('\n');
  });

  return [
    'The user sent these local queued messages as one ordered batch. Process them in order.',
    '',
    ...renderedMessages,
  ].join('\n\n');
}

function prependCronTaskContext(text: string, message: LocalMessageInput | undefined): string {
  return message?.source === 'cron' ? `[System CronTask]\n${text}` : text;
}

export function buildLocalAttachmentSystemReminder(input: {
  messages: LocalMessageInput[];
  capabilities: MultimodalAttachmentCapabilities | undefined;
  inlinedMediaFilePaths?: ReadonlySet<string>;
}): string {
  const lines: string[] = [];
  for (const [messageIndex, message] of input.messages.entries()) {
    for (const attachment of message.attachments) {
      const block = renderAttachmentReminderEntry({
        attachment,
        messageIndex,
        capabilities: input.capabilities,
        inlinedMediaFilePaths: input.inlinedMediaFilePaths,
      });
      if (block) lines.push(block);
    }
  }
  if (lines.length === 0) return '';
  return [
    '<system-reminder>',
    'The user provided local attachments for this turn. Use the file paths below whenever a tool or file read needs the attachment bytes. Do not guess attachment filenames.',
    "When an attachment also includes desktop_path, that is the user's original source location before asset registration. Use it when the request refers to the original file or folder.",
    'Text attachments are not inlined into this prompt; read the file path if you need their contents.',
    ...lines,
    '</system-reminder>',
  ].join('\n');
}

export function toAgentMessageAttachments(
  attachments: LocalMessageAttachment[],
): NonNullable<AgentMessage['attachments']> {
  return attachments.map((attachment) => ({
    type: attachment.type,
    file_path: attachment.filePath,
    file_name: attachment.fileName,
    mime_type: attachment.mimeType,
    ...(attachment.desktopPath ? { desktop_path: attachment.desktopPath } : {}),
    ...(attachment.dataUrl ? { data_url: attachment.dataUrl } : {}),
    ...(attachment.assetId ? { asset_id: attachment.assetId } : {}),
  }));
}

function readQueuedLocalMessages(data: Record<string, unknown>): LocalMessageInput[] {
  const raw = data.queuedMessages;
  if (!Array.isArray(raw)) return [];
  const messages: LocalMessageInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const message: LocalMessageInput = {
      content: readString(obj, 'content') ?? '',
      attachments: readAttachments(obj),
      ...(readFirstString(obj, ['queueItemId', 'queue_item_id'])
        ? { queueItemId: readFirstString(obj, ['queueItemId', 'queue_item_id']) }
        : {}),
      ...readOptionalProtocolMetadata(obj),
    };
    if (message.content.length === 0 && message.attachments.length === 0) continue;
    messages.push(message);
  }
  return messages;
}

function readAttachments(data: Record<string, unknown>): LocalMessageAttachment[] {
  const raw = data.attachments;
  if (!Array.isArray(raw)) return [];
  const attachments: LocalMessageAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const rawType = obj.type;
    const filePath = readFirstString(obj, ['filePath', 'file_path']);
    const desktopPath = readFirstString(obj, ['desktopPath', 'desktop_path']);
    const dataUrl = readFirstString(obj, ['dataUrl', 'data_url', 'previewUrl', 'preview_url']);
    const assetId = readFirstString(obj, ['assetId', 'asset_id']);
    const mimeType = readFirstString(obj, ['mimeType', 'mime_type']) ?? '';
    const resolvedFilePath = filePath ?? desktopPath;
    const type: 'file' | 'image' =
      rawType === 'image' || mimeType.startsWith('image/') ? 'image' : 'file';
    const fileName =
      readFirstString(obj, ['fileName', 'file_name']) ??
      (resolvedFilePath ? basename(resolvedFilePath) : 'attachment');
    if (!resolvedFilePath && !dataUrl) continue;
    attachments.push({
      type,
      filePath: resolvedFilePath ?? '',
      fileName,
      mimeType,
      ...(desktopPath ? { desktopPath } : {}),
      ...(dataUrl ? { dataUrl } : {}),
      ...(assetId ? { assetId } : {}),
    });
  }
  return attachments;
}

function renderAttachmentReminderEntry(input: {
  attachment: LocalMessageAttachment;
  messageIndex: number;
  capabilities: MultimodalAttachmentCapabilities | undefined;
  inlinedMediaFilePaths?: ReadonlySet<string>;
}): string | undefined {
  const { attachment, capabilities, inlinedMediaFilePaths, messageIndex } = input;
  const referencePath = attachment.filePath;
  if (!referencePath) return undefined;
  const nativeImageMime = resolveNativeImageMime(attachment);
  const nativeVideoMime = resolveNativeVideoMime(attachment);
  const mediaKind = nativeImageMime ? 'image' : nativeVideoMime ? 'video' : undefined;
  const textKind = isTextAttachment(attachment);
  const inlined =
    !!mediaKind &&
    !!attachment.filePath &&
    inlinedMediaFilePaths?.has(attachment.filePath) === true;
  const attrs = [
    `name="${escapeAttachmentAttr(attachment.fileName)}"`,
    `mime="${escapeAttachmentAttr(nativeImageMime || nativeVideoMime || attachment.mimeType || 'application/octet-stream')}"`,
    `path="${escapeAttachmentAttr(referencePath)}"`,
    attachment.desktopPath ? `desktop_path="${escapeAttachmentAttr(attachment.desktopPath)}"` : '',
    `message_index="${messageIndex + 1}"`,
    attachment.assetId ? `asset_id="${escapeAttachmentAttr(attachment.assetId)}"` : '',
    mediaKind ? `kind="${mediaKind}"` : textKind ? 'kind="text"' : 'kind="file"',
    mediaKind ? `inline="${inlined ? 'true' : 'false'}"` : 'inline="false"',
  ].filter(Boolean);
  const description = renderAttachmentReminderDescription({
    mediaKind,
    textKind,
    inlined,
    capabilities,
  });
  return [`<attachment ${attrs.join(' ')}>`, description, '</attachment>'].join('\n');
}

function renderAttachmentReminderDescription(input: {
  mediaKind: 'image' | 'video' | undefined;
  textKind: boolean;
  inlined: boolean;
  capabilities: MultimodalAttachmentCapabilities | undefined;
}): string {
  if (input.mediaKind) {
    if (input.inlined) {
      return `This ${input.mediaKind} attachment has already been provided inline to the current model. Use the path only when a file-based tool needs the local file.`;
    }
    const supports =
      input.mediaKind === 'image'
        ? input.capabilities?.support_image === true
        : input.capabilities?.support_video === true;
    return supports
      ? `This ${input.mediaKind} attachment was not provided inline for this turn. Use the path when you need to inspect it or pass it to a tool.`
      : `The current model cannot read this ${input.mediaKind} inline. Use the path with an appropriate file/tool workflow when you need its contents.`;
  }
  if (input.textKind) {
    return 'This text attachment is available as a local file. Its contents are not inlined into the prompt; read the path before using or summarizing it.';
  }
  return 'This attachment is available as a local file. Use the path when file access is needed.';
}

export function isTextAttachment(attachment: LocalMessageAttachment): boolean {
  const mimeType = attachment.mimeType.toLowerCase();
  if (TEXT_ATTACHMENT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) return true;
  if (TEXT_ATTACHMENT_MIME_TYPES.has(mimeType)) return true;
  return TEXT_ATTACHMENT_EXTENSIONS.has(
    extname(attachment.fileName || attachment.filePath).toLowerCase(),
  );
}

function escapeAttachmentAttr(value: string): string {
  return value.replace(/[&"<]/g, (char) => {
    if (char === '&') return '&amp;';
    if (char === '"') return '&quot;';
    return '&lt;';
  });
}

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readFirstString(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function readFirstPresent(data: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(data, key)) return data[key];
  }
  return undefined;
}

/**
 * Prepend quoted-message context to the user's text when the inbound message
 * is a reply to a previous message in an IM channel.
 */
function prependQuotedContext(
  content: string,
  quoted: LocalMessageQuotedMessage | undefined,
): string {
  if (!quoted?.text) return content;
  const attribution = quoted.senderName
    ? `[User replied to a message from ${quoted.senderName}]:`
    : '[User replied to a previous message]:';
  const quotedBlock = quoted.text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return [attribution, quotedBlock, '', content].join('\n');
}

/**
 * Read optional `quotedMessage` from an inbound body. Returns a spread-able
 * object so the caller can merge it into LocalMessageInput with `...`.
 */
function readOptionalQuotedMessage(
  data: Record<string, unknown>,
): { quotedMessage: LocalMessageQuotedMessage } | Record<string, never> {
  const raw = data.quotedMessage ?? data.quoted_message;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const text = readFirstString(obj, ['text', 'content']);
  if (!text) return {};
  return {
    quotedMessage: {
      text,
      ...(readFirstString(obj, ['senderName', 'sender_name'])
        ? { senderName: readFirstString(obj, ['senderName', 'sender_name']) }
        : {}),
    },
  };
}

function readOptionalProtocolMetadata(
  data: Record<string, unknown>,
): Pick<LocalMessageInput, 'source' | 'origin'> {
  const source = readFirstString(data, ['source']);
  const origin = readFirstPresent(data, ['origin', 'originJson', 'origin_json']);
  return {
    ...(source ? { source } : {}),
    ...(origin !== undefined ? { origin } : {}),
  };
}

/**
 * Read optional `channelContext` from an inbound body.
 */
function readOptionalChannelContext(
  data: Record<string, unknown>,
): { channelContext: LocalMessageChannelContext } | Record<string, never> {
  const raw = data.channelContext ?? data.channel_context;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const platform = readFirstString(obj, ['platform']);
  const chatType = readFirstString(obj, ['chatType', 'chat_type']);
  const chatId = readFirstString(obj, ['chatId', 'chat_id']);
  const senderId = readFirstString(obj, ['senderId', 'sender_id']);
  const clientName = readFirstString(obj, ['clientName', 'client_name']);
  const threadId = readFirstString(obj, ['threadId', 'thread_id']);
  const sourceMessageId = readFirstString(obj, ['sourceMessageId', 'source_message_id']);
  const contextToken = readFirstString(obj, ['contextToken', 'context_token']);
  if (!platform || !chatId || !senderId) return {};
  return {
    channelContext: {
      platform,
      chatType: chatType ?? 'private',
      chatId,
      senderId,
      clientName: clientName ?? '',
      ...(threadId ? { threadId } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
      ...(contextToken ? { contextToken } : {}),
    },
  };
}
