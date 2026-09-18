import { open, type FileHandle } from 'node:fs/promises';

interface IsoBox {
  readonly type: string;
  readonly start: number;
  readonly size: number;
  readonly headerSize: number;
}

/** Read the movie-header duration from an MP4/MOV file without decoding media bytes. */
export async function readIsoBmffDurationSeconds(filePath: string): Promise<number | undefined> {
  const handle = await open(filePath, 'r');
  try {
    const fileSize = (await handle.stat()).size;
    for await (const box of boxes(handle, 0, fileSize)) {
      if (box.type !== 'moov') continue;
      const contentStart = box.start + box.headerSize;
      const contentEnd = box.start + box.size;
      for await (const child of boxes(handle, contentStart, contentEnd)) {
        if (child.type === 'mvhd') return readMovieHeaderDuration(handle, child);
      }
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

async function* boxes(handle: FileHandle, start: number, end: number): AsyncGenerator<IsoBox> {
  let position = start;
  while (position + 8 <= end) {
    const base = await readExact(handle, position, 8);
    const size32 = base.readUInt32BE(0);
    const type = base.toString('ascii', 4, 8);
    let headerSize = 8;
    let size: number;
    if (size32 === 1) {
      const extended = await readExact(handle, position + 8, 8);
      const extendedSize = extended.readBigUInt64BE(0);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return;
      size = Number(extendedSize);
      headerSize = 16;
    } else {
      size = size32 === 0 ? end - position : size32;
    }
    if (size < headerSize || position + size > end) return;
    yield { type, start: position, size, headerSize };
    position += size;
  }
}

async function readMovieHeaderDuration(
  handle: FileHandle,
  box: IsoBox,
): Promise<number | undefined> {
  const payloadSize = box.size - box.headerSize;
  if (payloadSize < 20) return undefined;
  const payload = await readExact(handle, box.start + box.headerSize, Math.min(payloadSize, 32));
  const version = payload.readUInt8(0);
  if (version === 0 && payload.length >= 20) {
    return seconds(payload.readUInt32BE(12), BigInt(payload.readUInt32BE(16)));
  }
  if (version === 1 && payload.length >= 32) {
    return seconds(payload.readUInt32BE(20), payload.readBigUInt64BE(24));
  }
  return undefined;
}

function seconds(timescale: number, duration: bigint): number | undefined {
  if (timescale <= 0) return undefined;
  const value = Number(duration) / timescale;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function readExact(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error('Unexpected end of ISO BMFF file');
  return buffer;
}
