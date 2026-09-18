import type { ChannelInboundAttachmentRef } from './envelope.js';

export function extractFeishuAttachmentRefs(
  body: Record<string, unknown>,
  messageType?: string,
  contentOverride?: unknown,
): ChannelInboundAttachmentRef[] {
  const refs: ChannelInboundAttachmentRef[] = [];
  const payload = isRecord(body.payload) ? body.payload : body;
  const event = isRecord(payload.event) ? payload.event : payload;
  const message = isRecord(event.message) ? event.message : event;
  const content = isRecord(contentOverride) ? contentOverride : safeJsonObject(message?.content);
  if (!content) return refs;

  const mt = (messageType ?? '').toLowerCase();
  const fallbackType = !mt ? inferContentType(content) : '';
  // Feishu's top-level video event is reported as `media` while still carrying
  // `file_key`. Post rich-text `tag=media` remains a generic file ref below.
  const effectiveType =
    mt === 'media' && typeof content.file_key === 'string' && content.file_key
      ? 'video'
      : mt || fallbackType;
  const single = singleResourceRef(effectiveType, content);
  if (single) return [single];
  if (effectiveType === 'post' || Array.isArray((content as Record<string, unknown>).content)) {
    return extractPostRefs(content);
  }
  return refs;
}

export function safeJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function inferContentType(content: Record<string, unknown>): string {
  if (typeof content.image_key === 'string' && content.image_key) return 'image';
  if (typeof content.file_key === 'string' && content.file_key) return 'file';
  return '';
}

function singleResourceRef(
  effectiveType: string,
  content: Record<string, unknown>,
): ChannelInboundAttachmentRef | undefined {
  if (effectiveType === 'image' && typeof content.image_key === 'string' && content.image_key) {
    return {
      type: 'image',
      key: content.image_key,
      name: typeof content.file_name === 'string' ? content.file_name : undefined,
    };
  }
  if (effectiveType === 'file' && typeof content.file_key === 'string' && content.file_key) {
    return {
      type: 'file',
      key: content.file_key,
      name: typeof content.file_name === 'string' ? content.file_name : undefined,
    };
  }
  if (effectiveType === 'audio' && typeof content.file_key === 'string' && content.file_key) {
    return {
      type: 'audio',
      key: content.file_key,
      name: typeof content.file_name === 'string' ? content.file_name : 'audio.opus',
    };
  }
  if (effectiveType === 'video' && typeof content.file_key === 'string' && content.file_key) {
    return {
      type: 'video',
      key: content.file_key,
      name: typeof content.file_name === 'string' ? content.file_name : 'video.mp4',
    };
  }
  return undefined;
}

function extractPostRefs(content: Record<string, unknown>): ChannelInboundAttachmentRef[] {
  const refs: ChannelInboundAttachmentRef[] = [];
  const postContent = (content.zh_cn ?? content.en_us ?? content) as Record<string, unknown>;
  const lines = Array.isArray(postContent.content) ? postContent.content : [];
  for (const line of lines) {
    if (!Array.isArray(line)) continue;
    for (const item of line) {
      if (!isRecord(item)) continue;
      if (item.tag === 'img' && typeof item.image_key === 'string' && item.image_key) {
        refs.push({ type: 'image', key: item.image_key });
      } else if (item.tag === 'media' && typeof item.file_key === 'string' && item.file_key) {
        refs.push({ type: 'file', key: item.file_key, name: item.file_name as string | undefined });
      }
    }
  }
  return refs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
