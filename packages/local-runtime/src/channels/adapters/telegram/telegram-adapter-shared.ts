/**
 * Shared types used by both `telegram-adapter.ts` and the poll wire.
 * Extracted to avoid a circular import between the adapter and the wire
 * (the adapter constructs the wire, the wire references this shape).
 */
import type { LocalMessageAttachment } from '../../../messages/input.js';
import type { LocalChannelPlatformAdapter } from '../../adapter.js';
import type { ChannelInboundAttachmentRef, ChannelInboundEnvelope } from '../../envelope.js';
import type { LocalChannelContext } from '../../infra.js';

/**
 * Minimal dispatchInbound input. Kept loose so the wire does not pull
 * the full {@link LocalChannelRunner} type — the production wiring binds
 * `runner.dispatchInbound.bind(runner)` here, which already satisfies
 * this shape.
 */
export interface ChannelInboundDispatchInput {
  ctx: LocalChannelContext;
  text: string;
  eventId?: string;
  attachments?: LocalMessageAttachment[];
  /**
   * Optional raw platform event (Bot API update, Feishu card-action
   * trigger). Forwarded to the runner so `tryHandleQuestionnaireReply`
   * adapters that need wire-level access (e.g. Telegram
   * callback_query.data) can short-circuit before the bridge.
   */
  raw?: unknown;
}

/**
 * Resolve every `envelope.attachmentRefs` entry to an absolute on-disk
 * file via the adapter's `downloadAttachmentToLocal`. Per-ref failures
 * degrade to a `download_failed` marker attachment so the rest of the
 * batch still reaches the agent. Returns `[]` when there are no refs or
 * the adapter does not implement `downloadAttachmentToLocal`.
 *
 * Lifted out of `telegram-adapter-routes.ts` so both the webhook route
 * and the long-poll wire dispatch the same multimodal pipeline (the
 * poll wire previously dropped attachments silently).
 */
export async function downloadAttachmentsForUnifiedInbound(
  adapter: LocalChannelPlatformAdapter,
  envelope: ChannelInboundEnvelope,
): Promise<LocalMessageAttachment[]> {
  const refs = envelope.attachmentRefs ?? [];
  if (refs.length === 0 || !adapter.downloadAttachmentToLocal) return [];
  const messageId = envelope.messageId ?? envelope.eventId;
  const sessionId = envelope.ctx.chatId || envelope.ctx.senderId || 'unknown';
  const settled = await Promise.allSettled(
    refs.map((ref) =>
      adapter.downloadAttachmentToLocal!({
        clientName: adapter.clientName,
        ref,
        ...(messageId ? { messageId } : {}),
        sessionId,
      }),
    ),
  );
  const out: LocalMessageAttachment[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const r = settled[i]!;
    const ref = refs[i]!;
    if (r.status === 'fulfilled') {
      out.push({
        type: r.value.type,
        filePath: r.value.filePath,
        fileName: r.value.fileName,
        mimeType: r.value.mimeType,
        ...(r.value.error ? { error: r.value.error } : {}),
      });
    } else {
      out.push({
        type: ref.type === 'image' ? 'image' : 'file',
        filePath: '',
        fileName: ref.name ?? ref.key ?? 'attachment',
        mimeType: ref.mimeType ?? 'application/octet-stream',
        error: 'download_failed',
      });
    }
  }
  return out;
}

/**
 * Inject a short Chinese placeholder text when an inbound message has only
 * attachments and no body text — keeps the agent loop's text-first
 * assumptions intact ("the user sent something" instead of an empty turn).
 */
export function ensureUnifiedInboundText(
  text: string,
  refs: ChannelInboundAttachmentRef[] | undefined,
): string {
  if (text.trim()) return text;
  if (!refs || refs.length === 0) return text;
  const primary = refs[0]!;
  if (primary.type === 'image') return '[图片]';
  if (primary.type === 'audio') return '[语音]';
  if (primary.type === 'video') return '[视频]';
  return `[文件] ${primary.name ?? primary.key ?? ''}`.trim();
}
