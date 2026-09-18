import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  MatrixMediaError,
  type MatrixMediaClient,
  type MatrixUploadOptions,
} from '../cloud/matrix-tools/index.js';
import { DesktopMatrixClient } from './matrix-client.js';

export const MATRIX_INLINE_LIMIT_BYTES = 600 * 1024;
export const MATRIX_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

const GET_UPLOAD_URL_PATH = '/mavis/api/v1/mcp/get_upload_url';
const DEFAULT_UPLOAD_TIMEOUT_MS = 1_500_000;

interface GetUploadURLResponse {
  code?: number;
  message?: string;
  put_url?: string;
  cdn_url?: string;
  oss_key?: string;
  content_type?: string;
  expires_in?: number;
  error?: string;
}

export class DesktopMatrixMediaClient implements MatrixMediaClient {
  constructor(private readonly client: DesktopMatrixClient) {}

  async uploadFile(localPath: string, options: MatrixUploadOptions = {}) {
    let stats;
    try {
      stats = await stat(localPath);
    } catch (err) {
      throw new MatrixMediaError('file_not_found', `Input file does not exist: ${localPath}`, err);
    }
    if (!stats.isFile()) {
      throw new MatrixMediaError('file_not_found', `Input path is not a file: ${localPath}`);
    }
    if (stats.size > MATRIX_MAX_UPLOAD_BYTES) {
      throw new MatrixMediaError(
        'file_too_large',
        `${basename(localPath)} is ${formatBytesMiB(stats.size)}, above the Matrix upload limit of ${formatBytesMiB(
          MATRIX_MAX_UPLOAD_BYTES,
        )}.`,
      );
    }

    const filename = sanitizeFilename(options.filename ?? basename(localPath));
    const mimeType = options.mimeType ?? guessMimeType(filename);
    if (!options.forceRemoteUrl && stats.size <= MATRIX_INLINE_LIMIT_BYTES) {
      const inlineData = (await readFile(localPath)).toString('base64');
      return {
        ossKey: '',
        inlineData,
        mimeType,
        bytes: stats.size,
      };
    }

    const presigned = (await this.client.postGatewayJson(
      GET_UPLOAD_URL_PATH,
      {
        filename,
        mime_type: mimeType,
        ...(options.ttlSeconds !== undefined ? { ttl_seconds: options.ttlSeconds } : {}),
        ...(options.category !== undefined ? { category: options.category } : {}),
        size_bytes: stats.size,
      },
      undefined,
      DEFAULT_UPLOAD_TIMEOUT_MS,
    )) as GetUploadURLResponse;

    if ((presigned.code ?? 0) !== 0 || !presigned.put_url || !presigned.cdn_url) {
      const detail = presigned.error || presigned.message || 'no put_url returned';
      throw new MatrixMediaError(
        'upload_failed',
        `Matrix get_upload_url failed: code=${presigned.code ?? 'unknown'} ${detail}`,
      );
    }

    const sentMime = presigned.content_type || mimeType;
    const body = Readable.toWeb(createReadStream(localPath)) as unknown as RequestInit['body'];
    try {
      await this.client.putBytes(
        presigned.put_url,
        body,
        {
          'Content-Type': sentMime,
          'Content-Length': String(stats.size),
        },
        undefined,
        DEFAULT_UPLOAD_TIMEOUT_MS,
      );
    } catch (err) {
      throw new MatrixMediaError('upload_failed', describe(err), err);
    }

    return {
      ossKey: presigned.oss_key ?? '',
      signedUrl: presigned.cdn_url,
      mimeType: sentMime,
      bytes: stats.size,
    };
  }

  async downloadToFile(
    url: string,
    localPath: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ bytes: number }> {
    let stream;
    try {
      stream = await this.client.getStream(url, options?.signal, options?.timeoutMs);
    } catch (err) {
      throw toDownloadError(err);
    }

    try {
      await mkdir(dirname(localPath), { recursive: true });
      await pipeline(
        Readable.fromWeb(stream.body as unknown as import('node:stream/web').ReadableStream),
        createWriteStream(localPath),
      );
      const written = await stat(localPath);
      return { bytes: written.size };
    } catch (err) {
      if (options?.signal?.aborted) {
        throw new MatrixMediaError('aborted', 'Matrix download aborted', err);
      }
      throw new MatrixMediaError('write_failed', describe(err), err);
    } finally {
      stream.dispose();
    }
  }
}

export function guessMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export function sanitizeFilename(name: string): string {
  if (!name) return 'file';
  const idx = name.lastIndexOf('.');
  let stem: string;
  let ext: string;
  if (idx <= 0 || idx === name.length - 1) {
    stem = sanitizeChars(name);
    ext = '';
  } else {
    stem = sanitizeChars(name.slice(0, idx));
    ext = sanitizeChars(name.slice(idx + 1));
  }
  if (!stem) stem = 'file';
  if (idx > 0 && idx < name.length - 1) {
    if (!ext) ext = 'bin';
    return `${stem}.${ext}`;
  }
  return stem;
}

function sanitizeChars(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/gu, '_');
}

function formatBytesMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function toDownloadError(err: unknown): MatrixMediaError {
  if (err instanceof MatrixMediaError) return err;
  if (err instanceof Error && err.name === 'AbortError') {
    return new MatrixMediaError('aborted', 'Matrix download aborted', err);
  }
  return new MatrixMediaError('download_failed', describe(err), err);
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  return String(err);
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.zip': 'application/zip',
};
