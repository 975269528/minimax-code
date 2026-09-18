/**
 * WeChat inbound attachment helpers — split out from `wechat-adapter.ts` so
 * the adapter file stays within the 500-line layout budget. The functions
 * here are pure: they translate an iLink inbound JSON body into the
 * platform-agnostic `ChannelInboundAttachmentRef` shape the channel runner
 * consumes, and provide the two-way encode/decode of the composite
 * `aesKey|encryptedQueryParam` slot that `ChannelInboundAttachmentRef.key`
 * transports for WeChat media.
 *
 * The pair is exposed so the adapter (outbound `downloadAttachment`) can
 * reverse the encoding without re-implementing it.
 */
import type { ChannelInboundAttachmentRef } from '../../envelope.js';

const TEXT_KEY_DELIMITER = '|';

/**
 * Extract attachment refs from an iLink inbound message. Each ref carries
 * `encryptedQueryParam` + `aesKey` joined with `|` so the platform-agnostic
 * `ChannelInboundAttachmentRef.key` slot transports both halves.
 */
export function extractWeChatAttachmentRefs(
  body: Record<string, unknown>,
): ChannelInboundAttachmentRef[] {
  const payload = isRecord(body['payload']) ? body['payload'] : body;
  const event = isRecord(payload['event']) ? payload['event'] : payload;
  const message = firstRecord(event, ['message', 'msg']) ?? event;
  if (!isRecord(message)) return [];
  const items = Array.isArray(message['item_list'])
    ? message['item_list']
    : Array.isArray(message['items'])
      ? message['items']
      : [];
  const refs: ChannelInboundAttachmentRef[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const type = item['type'];
    if (type === 2 || type === 'image') refs.push(refFromMedia(item, 'image'));
    else if (type === 3 || type === 'voice') refs.push(refFromMedia(item, 'audio'));
    else if (type === 4 || type === 'file') refs.push(refFromMedia(item, 'file'));
    else if (type === 5 || type === 'video') refs.push(refFromMedia(item, 'video'));
  }
  return refs.filter((ref): ref is ChannelInboundAttachmentRef => Boolean(ref?.key));
}

export function encodeAttachmentKey(parts: {
  encryptedQueryParam: string;
  aesKey: string;
}): string {
  return `${parts.aesKey}${TEXT_KEY_DELIMITER}${parts.encryptedQueryParam}`;
}

export function decodeAttachmentKey(key: string): {
  aesKey: string;
  encryptedQueryParam: string;
} {
  const idx = key.indexOf(TEXT_KEY_DELIMITER);
  if (idx < 0) return { aesKey: '', encryptedQueryParam: key };
  return {
    aesKey: key.slice(0, idx),
    encryptedQueryParam: key.slice(idx + 1),
  };
}

/**
 * Load a media file (or `data:` URL) into a `Buffer`. The adapter calls this
 * once per outbound media item before handing the bytes to the SDK uploader.
 */
export async function readMediaBuffer(path: string): Promise<Buffer> {
  if (path.startsWith('data:')) {
    const base64 = path.split(',', 2)[1] ?? '';
    return Buffer.from(base64, 'base64');
  }
  const { readFile } = await import('node:fs/promises');
  return readFile(path);
}

export function extractFileName(path: string): string {
  if (path.startsWith('data:')) return 'media';
  const parts = path.split(/[\\/]/u);
  return parts[parts.length - 1] ?? 'media';
}

export function guessMimeFromKind(kind: string | undefined): string {
  switch (kind) {
    case 'image':
      return 'image/png';
    case 'video':
      return 'video/mp4';
    case 'audio':
      return 'audio/ogg';
    default:
      return 'application/octet-stream';
  }
}

// --- internal helpers --------------------------------------------------------

function refFromMedia(
  item: Record<string, unknown>,
  type: 'image' | 'audio' | 'file' | 'video',
): ChannelInboundAttachmentRef {
  const subitem = isRecord(item['image_item'])
    ? item['image_item']
    : isRecord(item['voice_item'])
      ? item['voice_item']
      : isRecord(item['file_item'])
        ? item['file_item']
        : isRecord(item['video_item'])
          ? item['video_item']
          : item;
  const media = isRecord(subitem['media']) ? subitem['media'] : undefined;
  const encryptedQueryParam = readString(media ?? {}, ['encrypt_query_param']) ?? '';
  // iLink ships two aes-key flavours:
  //   - `image_item.aeskey`  — hex string of the raw 16-byte key
  //   - `*.media.aes_key`    — base64 of the raw 16 bytes (file / voice / video)
  // The CDN download helper (`parseAesKey`) expects base64, so normalise the
  // hex flavour to base64 here. Without this, image inbound fails with
  // `aes_key must decode to 16 raw bytes or 32-char hex string, got 24 bytes`
  // when the hex string is mis-interpreted as base64 (parity with historical
  // `imGateway/platforms/wechat.ts` which did the exact same conversion).
  const rawAesHex = readString(subitem, ['aeskey']);
  const rawAesB64 = readString(media ?? {}, ['aes_key']);
  let aesKey = '';
  if (rawAesHex && /^[0-9a-fA-F]{32}$/.test(rawAesHex)) {
    aesKey = Buffer.from(rawAesHex, 'hex').toString('base64');
  } else if (rawAesB64) {
    aesKey = rawAesB64;
  } else if (rawAesHex) {
    // Unexpected encoding — pass through; parseAesKey will throw clearly.
    aesKey = rawAesHex;
  }
  const key = encodeAttachmentKey({ encryptedQueryParam, aesKey });
  const ref: ChannelInboundAttachmentRef = { type, key };
  const name = readString(subitem, ['file_name']);
  if (name) ref.name = name;
  const size = readNumber(subitem, ['mid_size', 'video_size', 'len']);
  if (size !== undefined) ref.size = size;
  return ref;
}

function readString(raw: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!raw) return undefined;
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readNumber(raw: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function firstRecord(
  raw: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | undefined {
  for (const key of keys) {
    if (isRecord(raw[key])) return raw[key] as Record<string, unknown>;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
