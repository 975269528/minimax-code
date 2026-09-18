import { open, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse } from 'node:path';

import { decode as decodeBmp } from 'bmp-js';
import { PNG } from 'pngjs';

import { imLogger } from '../common/im-logger.js';
import type { LocalMessageAttachment } from '../messages/input.js';
import { detectMediaFromBuffer } from './media-detector.js';

const SNIFF_BYTES = 8 * 1024;
const MAX_BMP_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BMP_DIMENSION = 8_192;
const MAX_BMP_PIXELS = 16_777_216;
const RENDERABLE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Normalize downloaded IM attachments without reading non-BMP files in full. */
export async function normalizeLocalInboundAttachments(
  attachments: LocalMessageAttachment[],
): Promise<LocalMessageAttachment[]> {
  const normalized: LocalMessageAttachment[] = [];
  // ponytail: sequential normalization bounds concurrent decode memory; parallelize only if inbound latency proves it matters.
  for (const attachment of attachments) {
    normalized.push(await normalizeAttachment(attachment));
  }
  return normalized;
}

async function normalizeAttachment(
  attachment: LocalMessageAttachment,
): Promise<LocalMessageAttachment> {
  if (attachment.error || !attachment.filePath) return attachment;

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(attachment.filePath, 'r');
    const fileSize = (await handle.stat()).size;
    const prefix = await readPrefix(handle, fileSize);
    const detected = detectMediaFromBuffer(prefix);

    if (detected?.mimeType === 'image/bmp') {
      return await convertBmp(attachment, handle, fileSize, prefix);
    }

    const media = isSvg(prefix) ? { mimeType: 'image/svg+xml', extension: 'svg' } : detected;
    if (!media || !isMultimodalMime(media.mimeType)) return attachment;

    const next = {
      ...attachment,
      type: RENDERABLE_IMAGE_MIME_TYPES.has(media.mimeType)
        ? ('image' as const)
        : ('file' as const),
      fileName: withExtension(attachment.fileName, attachment.filePath, media.extension),
      mimeType: media.mimeType,
    };
    if (
      next.type === attachment.type &&
      next.fileName === attachment.fileName &&
      next.mimeType === attachment.mimeType
    ) {
      return attachment;
    }
    imLogger.info(
      {
        scope: 'channel.inbound.media',
        outcome: 'metadata_updated',
        detectedMime: media.mimeType,
        type: next.type,
      },
      'Inbound attachment media metadata normalized',
    );
    return next;
  } catch (error) {
    imLogger.warn(
      {
        scope: 'channel.inbound.media',
        outcome: 'fail_open',
        reason: errorCode(error),
        originalMime: attachment.mimeType,
      },
      'Inbound attachment media normalization failed open',
    );
    return attachment;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readPrefix(
  handle: Awaited<ReturnType<typeof open>>,
  fileSize: number,
): Promise<Buffer> {
  const prefix = Buffer.alloc(Math.min(SNIFF_BYTES, Math.max(0, fileSize)));
  let offset = 0;
  while (offset < prefix.length) {
    const result = await handle.read(prefix, offset, prefix.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return prefix.subarray(0, offset);
}

async function convertBmp(
  attachment: LocalMessageAttachment,
  handle: Awaited<ReturnType<typeof open>>,
  fileSize: number,
  prefix: Buffer,
): Promise<LocalMessageAttachment> {
  const meta = validateBmp(prefix, fileSize);
  if (!meta.ok) {
    imLogger.warn(
      {
        scope: 'channel.inbound.media',
        outcome: 'fail_open',
        reason: meta.reason,
        originalMime: attachment.mimeType,
        fileSize,
      },
      'Inbound BMP attachment rejected during normalization',
    );
    return attachment;
  }

  const source = Buffer.alloc(fileSize);
  let offset = 0;
  while (offset < source.length) {
    const result = await handle.read(source, offset, source.length - offset, offset);
    if (result.bytesRead === 0) throw new Error('bmp_read_incomplete');
    offset += result.bytesRead;
  }
  const decoded = decodeBmp(source);
  if (decoded.width !== meta.width || Math.abs(decoded.height) !== meta.height) {
    throw new Error('bmp_dimensions_changed');
  }
  const rgba = Buffer.alloc(meta.pixels * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = decoded.data[i + 3]!;
    rgba[i + 1] = decoded.data[i + 2]!;
    rgba[i + 2] = decoded.data[i + 1]!;
    rgba[i + 3] = 0xff;
  }
  const pngBytes = PNG.sync.write({
    width: meta.width,
    height: meta.height,
    data: rgba,
  } as unknown as PNG);
  const outputPath = await writePngSibling(attachment.filePath, pngBytes);
  const next = {
    ...attachment,
    type: 'image' as const,
    filePath: outputPath,
    fileName: withExtension(attachment.fileName, attachment.filePath, 'png'),
    mimeType: 'image/png',
  };
  imLogger.info(
    {
      scope: 'channel.inbound.media',
      outcome: 'bmp_to_png',
      width: meta.width,
      height: meta.height,
      inputBytes: fileSize,
      outputBytes: pngBytes.length,
    },
    'Inbound BMP attachment converted to PNG',
  );
  return next;
}

async function writePngSibling(filePath: string, pngBytes: Buffer): Promise<string> {
  const parsed = parse(filePath);
  const stem = parsed.name || 'attachment';
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const outputPath = join(dirname(filePath), `${stem}${suffix ? `-${suffix}` : ''}.png`);
    try {
      await writeFile(outputPath, pngBytes, { flag: 'wx' });
      return outputPath;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
  }
  throw new Error('bmp_png_sibling_collision');
}

function validateBmp(
  header: Buffer,
  fileSize: number,
):
  | { ok: true; width: number; height: number; pixels: number; bitPP: number }
  | { ok: false; reason: string } {
  if (fileSize > MAX_BMP_FILE_BYTES) return { ok: false, reason: 'bmp_file_too_large' };
  if (fileSize < 54 || header.length < 54) return { ok: false, reason: 'bmp_header_truncated' };
  const declaredFileSize = header.readUInt32LE(2);
  const pixelOffset = header.readUInt32LE(10);
  const dibSize = header.readUInt32LE(14);
  const width = header.readUInt32LE(18);
  const signedHeight = header.readInt32LE(22);
  const planes = header.readUInt16LE(26);
  const bitPP = header.readUInt16LE(28);
  const compression = header.readUInt32LE(30);
  const colors = header.readUInt32LE(46);
  const height = Math.abs(signedHeight);
  if (
    dibSize !== 40 ||
    compression !== 0 ||
    planes !== 1 ||
    ![1, 4, 8, 16, 24, 32].includes(bitPP)
  ) {
    return { ok: false, reason: 'bmp_header_unsupported' };
  }
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_BMP_DIMENSION ||
    height > MAX_BMP_DIMENSION
  ) {
    return { ok: false, reason: 'bmp_dimensions_unsafe' };
  }
  const pixels = width * height;
  if (pixels > MAX_BMP_PIXELS) return { ok: false, reason: 'bmp_pixel_count_too_large' };
  const paletteEntries = bitPP < 15 ? (colors === 0 ? 1 << bitPP : colors) : 0;
  if (paletteEntries > (bitPP < 15 ? 1 << bitPP : 0)) {
    return { ok: false, reason: 'bmp_palette_unsupported' };
  }
  const expectedPixelOffset = 54 + paletteEntries * 4;
  if (pixelOffset !== expectedPixelOffset || pixelOffset >= fileSize) {
    return { ok: false, reason: 'bmp_pixel_offset_invalid' };
  }
  if (header.length < expectedPixelOffset) {
    return { ok: false, reason: 'bmp_palette_truncated' };
  }
  if (declaredFileSize > fileSize || (declaredFileSize > 0 && declaredFileSize < pixelOffset)) {
    return { ok: false, reason: 'bmp_file_size_invalid' };
  }
  const rowBytes = Math.ceil((width * bitPP) / 32) * 4;
  const pixelDataEnd = pixelOffset + rowBytes * height;
  if (
    !Number.isSafeInteger(pixelDataEnd) ||
    pixelDataEnd > fileSize ||
    (declaredFileSize > 0 && pixelDataEnd > declaredFileSize)
  ) {
    return { ok: false, reason: 'bmp_pixel_data_truncated' };
  }
  return { ok: true, width, height, pixels, bitPP };
}

function isMultimodalMime(mimeType: string): boolean {
  return (
    mimeType.startsWith('image/') || mimeType.startsWith('audio/') || mimeType.startsWith('video/')
  );
}

function isSvg(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const text = buffer
    .toString('utf8')
    .replace(/^\uFEFF/u, '')
    .trimStart();
  return /^(?:<\?xml[\s\S]*?\?>\s*)?<svg(?:\s|>|\/)/iu.test(text);
}

function withExtension(fileName: string, filePath: string, extension: string): string {
  const input = basename(fileName || basename(filePath) || 'attachment');
  const parsed = parse(input);
  return `${parsed.name || 'attachment'}.${extension}`;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'normalization_failed';
}
