export interface ImageDimensions {
  width: number;
  height: number;
}

export const IMAGE_DIMENSION_HEADER_BYTES = 96 * 1024;

const MAX_MEDIA_DIMENSION = 1_000_000;

function normalizeDimensions(width: number, height: number): ImageDimensions | undefined {
  if (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_MEDIA_DIMENSION &&
    height <= MAX_MEDIA_DIMENSION
  ) {
    return { width, height };
  }
  return undefined;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string | undefined {
  if (offset < 0 || length < 0 || bytes.byteLength < offset + length) return undefined;
  let value = '';
  for (let index = offset; index < offset + length; index += 1) {
    value += String.fromCharCode(bytes[index] as number);
  }
  return value;
}

function readUint16(bytes: Uint8Array, offset: number, littleEndian: boolean): number | undefined {
  if (offset < 0 || bytes.byteLength < offset + 2) return undefined;
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, littleEndian);
}

function readUint24LE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || bytes.byteLength < offset + 3) return undefined;
  return (
    (bytes[offset] as number) |
    ((bytes[offset + 1] as number) << 8) |
    ((bytes[offset + 2] as number) << 16)
  );
}

function readUint32BE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || bytes.byteLength < offset + 4) return undefined;
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

function parsePng(bytes: Uint8Array): ImageDimensions | undefined {
  if (
    bytes.byteLength < 24 ||
    readAscii(bytes, 0, 8) !== '\u0089PNG\r\n\u001a\n' ||
    readAscii(bytes, 12, 4) !== 'IHDR'
  ) {
    return undefined;
  }
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  return width !== undefined && height !== undefined
    ? normalizeDimensions(width, height)
    : undefined;
}

function parseGif(bytes: Uint8Array): ImageDimensions | undefined {
  const signature = readAscii(bytes, 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return undefined;
  const width = readUint16(bytes, 6, true);
  const height = readUint16(bytes, 8, true);
  return width !== undefined && height !== undefined
    ? normalizeDimensions(width, height)
    : undefined;
}

function parseWebp(bytes: Uint8Array): ImageDimensions | undefined {
  if (
    bytes.byteLength < 30 ||
    readAscii(bytes, 0, 4) !== 'RIFF' ||
    readAscii(bytes, 8, 4) !== 'WEBP'
  ) {
    return undefined;
  }
  const format = readAscii(bytes, 12, 4);
  if (format === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined;
    const encodedWidth = readUint16(bytes, 26, true);
    const encodedHeight = readUint16(bytes, 28, true);
    return encodedWidth !== undefined && encodedHeight !== undefined
      ? normalizeDimensions(encodedWidth & 0x3fff, encodedHeight & 0x3fff)
      : undefined;
  }
  if (format === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined;
    const b0 = bytes[21] as number;
    const b1 = bytes[22] as number;
    const b2 = bytes[23] as number;
    const b3 = bytes[24] as number;
    return normalizeDimensions(
      1 + (((b1 & 0x3f) << 8) | b0),
      1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    );
  }
  if (format === 'VP8X') {
    const encodedWidth = readUint24LE(bytes, 24);
    const encodedHeight = readUint24LE(bytes, 27);
    return encodedWidth !== undefined && encodedHeight !== undefined
      ? normalizeDimensions(1 + encodedWidth, 1 + encodedHeight)
      : undefined;
  }
  return undefined;
}

const JPEG_STANDALONE_MARKERS = new Set([
  0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9,
]);

function isJpegSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function parseJpeg(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  for (
    let iterations = 0;
    offset + 4 <= bytes.byteLength && iterations < bytes.byteLength;
    iterations += 1
  ) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] as number;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (JPEG_STANDALONE_MARKERS.has(marker)) {
      offset += 2;
      continue;
    }
    const length = readUint16(bytes, offset + 2, false);
    if (length === undefined || length < 2) return undefined;
    if (isJpegSofMarker(marker)) {
      const height = readUint16(bytes, offset + 5, false);
      const width = readUint16(bytes, offset + 7, false);
      return width !== undefined && height !== undefined
        ? normalizeDimensions(width, height)
        : undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

/** Parse PNG, JPEG, GIF, or WebP dimensions from a bounded file prefix. */
export function parseImageDimensionsFromBytes(bytes: Uint8Array): ImageDimensions | undefined {
  return parsePng(bytes) ?? parseJpeg(bytes) ?? parseGif(bytes) ?? parseWebp(bytes);
}
