import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { PNG } from 'pngjs';

import {
  buildCompressedModelImageFromFile,
  decodeDataUrl,
} from '../utils/model-image-preprocess.js';

const DEFAULT_THUMBNAIL_MAX_EDGE = 512;
const THUMBNAIL_MAX_OUTPUT_BYTES = 1024 * 1024;
const THUMBNAIL_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const THUMBNAIL_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const THUMBNAIL_EDGE_TIERS = [256, 512, 1024] as const;
const THUMBNAIL_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

interface ThumbnailCacheEntry {
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly bytes: Buffer;
  readonly mimeType: ThumbnailMimeType;
}

type ThumbnailMimeType = 'image/jpeg' | 'image/png';

export type WorkspaceFileThumbnailResult =
  | { ok: true; bytes: Buffer; mimeType: ThumbnailMimeType; cache: 'hit' | 'miss' }
  | {
      ok: false;
      status: 413 | 415 | 422;
      error: string;
      code: 'THUMBNAIL_SOURCE_TOO_LARGE' | 'THUMBNAIL_UNSUPPORTED' | 'THUMBNAIL_INVALID';
    };

const thumbnailCache = new Map<string, ThumbnailCacheEntry>();
let thumbnailCacheBytes = 0;

export function normalizeThumbnailMaxEdge(value: string | null): number {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_THUMBNAIL_MAX_EDGE;
  return THUMBNAIL_EDGE_TIERS.find((tier) => requested <= tier) ?? 1024;
}

function cacheGet(key: string): ThumbnailCacheEntry | undefined {
  const entry = thumbnailCache.get(key);
  if (!entry) return undefined;
  thumbnailCache.delete(key);
  thumbnailCache.set(key, entry);
  return entry;
}

function cacheSet(
  key: string,
  sourcePath: string,
  sourceRevision: string,
  bytes: Buffer,
  mimeType: ThumbnailMimeType,
): void {
  for (const [existingKey, entry] of thumbnailCache) {
    if (entry.sourcePath !== sourcePath || entry.sourceRevision === sourceRevision) continue;
    thumbnailCache.delete(existingKey);
    thumbnailCacheBytes -= entry.bytes.byteLength;
  }

  if (bytes.byteLength > THUMBNAIL_CACHE_MAX_BYTES) return;
  while (
    thumbnailCache.size > 0 &&
    thumbnailCacheBytes + bytes.byteLength > THUMBNAIL_CACHE_MAX_BYTES
  ) {
    const oldestKey = thumbnailCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = thumbnailCache.get(oldestKey);
    thumbnailCache.delete(oldestKey);
    thumbnailCacheBytes -= oldest?.bytes.byteLength ?? 0;
  }
  thumbnailCache.set(key, { sourcePath, sourceRevision, bytes, mimeType });
  thumbnailCacheBytes += bytes.byteLength;
}

function boundedPngSize(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return { width, height };
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function clampPixel(value: number, maximum: number): number {
  return Math.max(0, Math.min(maximum, value));
}

function pixelChannel(data: Buffer, offset: number): number {
  return data[offset] ?? 0;
}

function resizePng(source: PNG, width: number, height: number): PNG {
  if (source.width === width && source.height === height) return source;
  const output = new PNG({ width, height });
  const xScale = source.width / width;
  const yScale = source.height / height;

  for (let y = 0; y < height; y += 1) {
    const sourceY = (y + 0.5) * yScale - 0.5;
    const y0 = clampPixel(Math.floor(sourceY), source.height - 1);
    const y1 = clampPixel(y0 + 1, source.height - 1);
    const yWeight = sourceY - Math.floor(sourceY);

    for (let x = 0; x < width; x += 1) {
      const sourceX = (x + 0.5) * xScale - 0.5;
      const x0 = clampPixel(Math.floor(sourceX), source.width - 1);
      const x1 = clampPixel(x0 + 1, source.width - 1);
      const xWeight = sourceX - Math.floor(sourceX);
      const samples = [
        { offset: (y0 * source.width + x0) * 4, weight: (1 - xWeight) * (1 - yWeight) },
        { offset: (y0 * source.width + x1) * 4, weight: xWeight * (1 - yWeight) },
        { offset: (y1 * source.width + x0) * 4, weight: (1 - xWeight) * yWeight },
        { offset: (y1 * source.width + x1) * 4, weight: xWeight * yWeight },
      ];
      const outputOffset = (y * width + x) * 4;
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;

      for (const sample of samples) {
        const sampleAlpha = pixelChannel(source.data, sample.offset + 3);
        const weightedAlpha = sampleAlpha * sample.weight;
        alpha += weightedAlpha;
        red += pixelChannel(source.data, sample.offset) * weightedAlpha;
        green += pixelChannel(source.data, sample.offset + 1) * weightedAlpha;
        blue += pixelChannel(source.data, sample.offset + 2) * weightedAlpha;
      }

      output.data[outputOffset] = alpha > 0 ? Math.round(red / alpha) : 0;
      output.data[outputOffset + 1] = alpha > 0 ? Math.round(green / alpha) : 0;
      output.data[outputOffset + 2] = alpha > 0 ? Math.round(blue / alpha) : 0;
      output.data[outputOffset + 3] = Math.round(alpha);
    }
  }

  return output;
}

function encodePngWithinLimit(source: PNG, maxEdge: number): Buffer | null {
  const initialSize = boundedPngSize(source.width, source.height, maxEdge);
  let current = resizePng(source, initialSize.width, initialSize.height);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const encoded = PNG.sync.write(current, {
      colorType: 6,
      inputColorType: 6,
      inputHasAlpha: true,
      deflateLevel: 9,
    });
    if (encoded.byteLength <= THUMBNAIL_MAX_OUTPUT_BYTES) return encoded;
    const longEdge = Math.max(current.width, current.height);
    if (longEdge <= 64) return null;
    const ratio = Math.max(0.5, Math.sqrt(THUMBNAIL_MAX_OUTPUT_BYTES / encoded.byteLength) * 0.95);
    const nextWidth = Math.max(1, Math.round(current.width * ratio));
    const nextHeight = Math.max(1, Math.round(current.height * ratio));
    if (nextWidth === current.width && nextHeight === current.height) return null;
    current = resizePng(current, nextWidth, nextHeight);
  }

  return null;
}

function isPngBuffer(buffer: Buffer): boolean {
  return (
    buffer.byteLength >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
}

export async function buildWorkspaceFileThumbnail(
  absolutePath: string,
  maxEdge: number,
  preserveAlpha = false,
): Promise<WorkspaceFileThumbnailResult> {
  const extension = extname(absolutePath).toLowerCase();
  if (!THUMBNAIL_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      status: 415,
      error: 'Thumbnail format is not supported',
      code: 'THUMBNAIL_UNSUPPORTED',
    };
  }

  const sourceInfo = await stat(absolutePath);
  if (!sourceInfo.isFile()) {
    return {
      ok: false,
      status: 422,
      error: 'Thumbnail source is not a file',
      code: 'THUMBNAIL_INVALID',
    };
  }
  if (sourceInfo.size > THUMBNAIL_MAX_SOURCE_BYTES) {
    return {
      ok: false,
      status: 413,
      error: 'Thumbnail source is too large',
      code: 'THUMBNAIL_SOURCE_TOO_LARGE',
    };
  }

  const sourceRevision = `${sourceInfo.size}\0${sourceInfo.mtimeMs}`;
  const cacheKey = `${absolutePath}\0${sourceRevision}\0${maxEdge}\0${preserveAlpha ? 'alpha' : 'opaque'}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return { ok: true, bytes: cached.bytes, mimeType: cached.mimeType, cache: 'hit' };
  }

  try {
    if (preserveAlpha && extension === '.png') {
      const sourceBytes = await readFile(absolutePath);
      if (isPngBuffer(sourceBytes)) {
        const source = PNG.sync.read(sourceBytes);
        const bytes = encodePngWithinLimit(source, maxEdge);
        if (!bytes) throw new Error('PNG thumbnail exceeds output limit');
        cacheSet(cacheKey, absolutePath, sourceRevision, bytes, 'image/png');
        return { ok: true, bytes, mimeType: 'image/png', cache: 'miss' };
      }
    }
    const compressed = await buildCompressedModelImageFromFile(absolutePath, undefined, {
      maxBytes: THUMBNAIL_MAX_OUTPUT_BYTES,
      maxEdgePx: maxEdge,
    });
    const decoded = compressed ? decodeDataUrl(compressed.filePart.url) : null;
    if (!decoded || decoded.mimeType !== 'image/jpeg') {
      return {
        ok: false,
        status: 422,
        error: 'Thumbnail source could not be decoded',
        code: 'THUMBNAIL_INVALID',
      };
    }
    cacheSet(cacheKey, absolutePath, sourceRevision, decoded.buffer, 'image/jpeg');
    return { ok: true, bytes: decoded.buffer, mimeType: 'image/jpeg', cache: 'miss' };
  } catch {
    return {
      ok: false,
      status: 422,
      error: 'Thumbnail source could not be decoded',
      code: 'THUMBNAIL_INVALID',
    };
  }
}

export function resetWorkspaceFileThumbnailCache(): void {
  thumbnailCache.clear();
  thumbnailCacheBytes = 0;
}
