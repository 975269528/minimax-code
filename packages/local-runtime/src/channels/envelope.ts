import type { LocalChannelContext } from './infra.js';
import type { LocalMessageQuotedMessage } from '../messages/input.js';

/**
 * Platform-agnostic inbound attachment reference emitted by an SDK
 * `onEvent` callback. The reference carries the platform-specific resource
 * key (Telegram `file_id`, Feishu `file_key`/`image_key`, WeChat CDN key),
 * NOT a local file path. The SDK adapter is responsible for resolving the
 * reference to a `LocalMessageAttachment` (with a `filePath`) before the
 * runner dispatches the inbound. See D1.
 */
export interface ChannelInboundAttachmentRef {
  type: 'image' | 'file' | 'audio' | 'video';
  /**
   * Platform-specific resource identifier. Stable for the lifetime of the
   * message; safe to pass to the platform's `download*` API.
   */
  key: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

/**
 * Unified inbound envelope produced by platform `parse*` functions. All
 * three platforms (Telegram / Feishu / WeChat) emit the same shape so the
 * runner does not need platform-specific dispatch.
 *
 * The envelope intentionally separates `attachmentRefs` (platform-side,
 * resolved later by the SDK adapter) from `quotedMessage` (already text,
 * never needs a download).
 */
export interface ChannelInboundEnvelope {
  ctx: LocalChannelContext;
  text: string;
  /**
   * Platform attachment references. Empty for text-only messages. Each ref
   * must be resolved to a `LocalMessageAttachment` (with a `filePath`) by
   * the SDK adapter's `onEvent` callback *before* `dispatchInbound` is
   * called. Best-effort: a failed download drops that ref from the dispatch
   * — it does not block the message.
   */
  attachmentRefs: ChannelInboundAttachmentRef[];
  /** Quoted / replied-to message context. */
  quotedMessage?: LocalMessageQuotedMessage;
  /**
   * Platform-specific event id. Used by `checkChannelAccess` to dedup
   * replays via the `${platform}:${clientName}:${eventId}` cache. Optional
   * — a missing id simply skips the dedup layer.
   *
   * Source field by platform:
   * - Telegram: `update_id` (getUpdates offset)
   * - Feishu: `event_id` / `message_id`
   * - WeChat: `message_id` / `client_id`
   */
  eventId?: string;
  /**
   * Platform message id, distinct from {@link eventId}. Needed when an
   * attachment download is keyed by the message rather than the event:
   * Feishu's resource API (`im/v1/messages/{message_id}/resources`) requires
   * `message_id`, NOT `event_id`. Optional — only set by platforms whose
   * resource fetch needs it; downloaders fall back to {@link eventId}.
   */
  messageId?: string;
}
