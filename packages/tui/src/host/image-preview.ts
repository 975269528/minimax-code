import { Worker } from 'node:worker_threads';
import { open } from 'node:fs/promises';
import { getImageDimensions, type ImageDimensions } from '../tui/engine/public.js';

export interface TuiImagePreviewData {
  readonly dimensions?: ImageDimensions;
  readonly png?: string;
}

/** Preview limits are independent of admission/send limits; originals are never changed. */
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
const MAX_PREVIEW_PIXELS = 25_000_000;

export async function loadTuiImagePreview(
  filePath: string,
  mimeType: string,
  signal: AbortSignal,
): Promise<TuiImagePreviewData> {
  const file = await open(filePath, 'r');
  let bytes: Buffer;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0 || info.size > MAX_PREVIEW_BYTES) return {};
    // Bounded even if the file grows between stat and read.
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    bytes = buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
  signal.throwIfAborted();
  const dimensions = getImageDimensions(bytes.toString('base64'), mimeType) ?? undefined;
  if (!dimensions || dimensions.widthPx * dimensions.heightPx > MAX_PREVIEW_PIXELS) {
    return { dimensions };
  }
  // Kitty accepts PNG payloads. Force non-PNGs through the existing worker-backed
  // decoder/resizer, whose first encoding candidate is PNG, instead of sending JPEG as PNG.
  const maxWidth = mimeType === 'image/png' ? 960 : Math.min(960, dimensions.widthPx - 1);
  if (maxWidth < 1) return { dimensions };
  try {
    const png = await preparePreviewInWorker(bytes, mimeType, maxWidth, signal);
    return { dimensions, png };
  } catch {
    signal.throwIfAborted();
    return { dimensions };
  }
}

async function preparePreviewInWorker(
  bytes: Uint8Array,
  mimeType: string,
  maxWidth: number,
  signal: AbortSignal,
): Promise<string | undefined> {
  signal.throwIfAborted();
  const worker = new Worker(
    new URL(
      import.meta.url.endsWith('.ts') ? './image-preview-worker.ts' : './image-preview-worker.js',
      import.meta.url,
    ),
    { workerData: { bytes, mimeType, maxWidth } },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      abort = () => reject(new Error('Image preview cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      timer = setTimeout(() => reject(new Error('Image preview timed out')), 5_000);
      worker.once('message', (result: unknown) =>
        resolve(typeof result === 'string' ? result : undefined),
      );
      worker.once('error', reject);
      worker.once('exit', () => resolve(undefined));
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
    await worker.terminate();
  }
}
