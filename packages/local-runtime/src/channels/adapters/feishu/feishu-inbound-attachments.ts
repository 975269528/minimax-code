import type { ChannelInboundAttachmentRef, ChannelInboundEnvelope } from '../../envelope.js';
import type { LocalMessageAttachment } from '../../../messages/input.js';

const ELECTRON_NET_FETCH_BYTESTRING_CODE = 'ELECTRON_NET_FETCH_BYTESTRING';

/**
 * Resolves a Feishu attachment ref to a local file. Mirrors
 * {@link FeishuAttachmentDownloader} from `feishu.ts` but takes refs straight
 * from the envelope so the WS path can plug in the same downloader the
 * webhook path uses.
 */
export type FeishuWsAttachmentDownloader = (input: {
  messageId: string;
  ref: ChannelInboundAttachmentRef;
  sessionId: string;
}) => Promise<LocalMessageAttachment>;

export async function resolveInboundAttachments(
  envelope: ChannelInboundEnvelope,
  downloader: FeishuWsAttachmentDownloader | undefined,
): Promise<LocalMessageAttachment[]> {
  const refs = envelope.attachmentRefs ?? [];
  if (refs.length === 0 || !downloader) return [];
  const messageId = envelope.messageId ?? envelope.eventId ?? '';
  if (!messageId) return [];
  const sessionId = envelope.ctx.chatId || envelope.ctx.senderId || 'unknown';
  const settled = await Promise.allSettled(
    refs.map((ref) => downloader({ messageId, ref, sessionId })),
  );
  const out: LocalMessageAttachment[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const result = settled[i]!;
    const ref = refs[i]!;
    if (result.status === 'fulfilled') {
      out.push(result.value);
    } else {
      if (isElectronNetFetchByteStringError(result.reason)) throw result.reason;
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

export function isElectronNetFetchByteStringError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === ELECTRON_NET_FETCH_BYTESTRING_CODE
  );
}
