import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';

import type {
  HtmlPreviewLeaseError,
  ResolvedHtmlPreviewResource,
  WorkspaceHtmlPreviewResourceResult,
} from './contracts.js';
import { resolveWorkspacePath } from './operations/workspace-path.js';

// Stream HTML larger than 8 MiB to avoid buffering oversized documents for the selection bridge.
const HTML_PREVIEW_INJECTABLE_MAX_BYTES = 8 * 1024 * 1024;

const HTML_PREVIEW_MIME_TYPES = new Map<string, string>([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.otf', 'font/otf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.wav', 'audio/wav'],
  ['.webm', 'video/webm'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.xml', 'application/xml; charset=utf-8'],
]);

const HTML_DOCUMENT_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

export async function resolveContainedHtmlPreviewFile(
  rootDir: string,
  childPath: string,
): Promise<string | null> {
  if (!childPath || isAbsolute(childPath) || /[\0\r\n]/u.test(childPath)) return null;
  const absolutePath = await resolveWorkspacePath(rootDir, childPath);
  if (!absolutePath) return null;
  try {
    return (await stat(absolutePath)).isFile() ? absolutePath : null;
  } catch {
    return null;
  }
}

export async function resolveWorkspaceHtmlPreviewResource(
  rootDir: string,
  resourcePath: string,
): Promise<ResolvedHtmlPreviewResource | HtmlPreviewLeaseError> {
  const absolutePath = await resolveContainedHtmlPreviewFile(rootDir, resourcePath);
  if (!absolutePath) {
    return { ok: false, status: 404, error: 'Preview resource not found', code: 'NOT_FOUND' };
  }
  const contentType = HTML_PREVIEW_MIME_TYPES.get(extname(absolutePath).toLowerCase());
  if (!contentType) {
    return {
      ok: false,
      status: 415,
      error: 'Preview resource type is not supported',
      code: 'UNSUPPORTED',
    };
  }
  return { ok: true, absolutePath, contentType };
}

export async function readWorkspaceHtmlPreviewResource(
  resource: ResolvedHtmlPreviewResource,
  rangeHeader: string | null,
  bridgeScriptTag?: string,
): Promise<WorkspaceHtmlPreviewResourceResult> {
  const { absolutePath, contentType } = resource;
  const info = await stat(absolutePath);
  if (
    bridgeScriptTag &&
    contentType.startsWith('text/html') &&
    info.size <= HTML_PREVIEW_INJECTABLE_MAX_BYTES
  ) {
    return {
      ok: true,
      body: injectBeforeBodyEnd(await readFile(absolutePath, 'utf8'), bridgeScriptTag),
      status: 200,
      headers: resourceHeaders(contentType),
    };
  }
  return streamResource(resource, rangeHeader, info.size);
}

function streamResource(
  resource: ResolvedHtmlPreviewResource,
  rangeHeader: string | null,
  size: number,
): WorkspaceHtmlPreviewResourceResult {
  const range = parseRange(rangeHeader, size);
  if (rangeHeader && !range) {
    return {
      ok: true,
      body: null,
      status: 416,
      headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
    };
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const body =
    size === 0
      ? null
      : (Readable.toWeb(
          createReadStream(resource.absolutePath, { start, end }),
        ) as ReadableStream<Uint8Array>);
  return {
    ok: true,
    body,
    status: range ? 206 : 200,
    headers: {
      ...resourceHeaders(resource.contentType),
      'Accept-Ranges': 'bytes',
      'Content-Length': String(Math.max(0, end - start + 1)),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    },
  };
}

function resourceHeaders(contentType: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, no-store',
    'Content-Type': contentType,
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    ...(contentType.startsWith('text/html')
      ? { 'Content-Security-Policy': HTML_DOCUMENT_CSP }
      : {}),
  };
}

function injectBeforeBodyEnd(document: string, scriptTag: string): string {
  if (/<\/body>/iu.test(document)) return document.replace(/<\/body>/iu, `${scriptTag}</body>`);
  return `${document}${scriptTag}`;
}

function parseRange(value: string | null, size: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || size <= 0) return null;
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (startText) return parseExplicitRange(startText, endText, size);
  const suffixLength = Number(endText);
  if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
  return { start: Math.max(0, size - suffixLength), end: size - 1 };
}

function parseExplicitRange(
  startText: string,
  endText: string,
  size: number,
): { start: number; end: number } | null {
  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}
