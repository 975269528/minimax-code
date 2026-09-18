/** MIME / extension pairs detected from downloaded bytes. */
export interface DetectedMedia {
  mimeType: string;
  extension: string;
}

/** Whether the buffer starts with one complete, structurally valid FileTypeBox. */
export function hasValidIsoBmffFileTypeBox(buffer: Buffer): boolean {
  return readIsoBmffBrands(buffer) !== undefined;
}

/**
 * Sniff common binary signatures. Callers should treat an absent result as an
 * opaque file; documents and archives must keep their platform metadata.
 */
export function detectMediaFromBuffer(buffer: Buffer): DetectedMedia | undefined {
  if (!buffer || buffer.length < 4) return undefined;

  // --- Images ---
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x39 || buffer[4] === 0x37) &&
    buffer[5] === 0x61
  ) {
    return { mimeType: 'image/gif', extension: 'gif' };
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  if (buffer.length >= 2 && buffer.toString('ascii', 0, 2) === 'BM') {
    return { mimeType: 'image/bmp', extension: 'bmp' };
  }

  // --- Audio ---
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') {
    return { mimeType: 'audio/ogg', extension: 'ogg' };
  }
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'fLaC') {
    return { mimeType: 'audio/flac', extension: 'flac' };
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return { mimeType: 'audio/wav', extension: 'wav' };
  }
  if (buffer.length >= 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return { mimeType: 'audio/mpeg', extension: 'mp3' };
  }

  const ftypBrands = readIsoBmffBrands(buffer);
  if (ftypBrands) {
    const brands = new Set(ftypBrands);
    if (brands.has('avif') || brands.has('avis')) {
      return { mimeType: 'image/avif', extension: 'avif' };
    }
    if (brands.has('heic') || brands.has('heix') || brands.has('heim') || brands.has('heis')) {
      return { mimeType: 'image/heic', extension: 'heic' };
    }
    if (brands.has('mif1')) {
      return { mimeType: 'image/heif', extension: 'heif' };
    }
    if (brands.has('mp41') || brands.has('mp42')) {
      return { mimeType: 'video/mp4', extension: 'mp4' };
    }
    if (brands.has('qt  ')) {
      return { mimeType: 'video/quicktime', extension: 'mov' };
    }
    return undefined;
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return { mimeType: 'video/webm', extension: 'webm' };
  }

  // --- Documents / archives ---
  if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') {
    return { mimeType: 'application/pdf', extension: 'pdf' };
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  ) {
    return { mimeType: 'application/zip', extension: 'zip' };
  }

  return undefined;
}

function readIsoBmffBrands(buffer: Buffer): string[] | undefined {
  if (buffer.length < 16 || buffer.toString('ascii', 4, 8) !== 'ftyp') return undefined;
  const boxSize = buffer.readUInt32BE(0);
  if (boxSize < 16 || boxSize > buffer.length || (boxSize - 16) % 4 !== 0) return undefined;

  const brands = [buffer.toString('ascii', 8, 12)];
  for (let offset = 16; offset < boxSize; offset += 4) {
    brands.push(buffer.toString('ascii', offset, offset + 4));
  }
  return brands;
}
