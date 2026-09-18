import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';

import JSZip from 'jszip';

import { LocalMatrixClient } from '../matrix/local-matrix-client.js';
import type { LocalRuntimeAuthContext } from '../runtime/model-resolver.js';
import type { LocalRuntimeRoutingContext } from '../runtime/routing-headers.js';
import { LocalWebsiteManagementClient } from './local-website-management-client.js';

/**
 * Materializes retained deployed-site source before model execution. Only the owner API may
 * supply the signed download URL, which must never enter prompts or logs.
 */

export const DEPLOYED_WEBSITE_SOURCE_MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
export const DEPLOYED_WEBSITE_SOURCE_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
export const DEPLOYED_WEBSITE_SOURCE_MAX_FILES = 5_000;

const DEPLOYED_WEBSITE_CONTEXT_RE =
  /<deployed-website-context\b[^>]*>([\s\S]*?)<\/deployed-website-context>/gu;
const DEPLOYED_WEBSITE_SOURCE_ROOT = 'deployed-website-sources';
const ARCHIVE_TOO_LARGE_MESSAGE = 'Website source archive is too large.';
const SAFE_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,127}$/u;

export interface DeployedWebsiteSourceOwnerClient {
  getProjectSourceDownloadUrl(
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export interface DeployedWebsiteSourceDownloadClient {
  getStream(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ body: ReadableStream<Uint8Array>; contentLength?: number; dispose(): void }>;
}

interface DeployedWebsiteContext {
  node_id: string;
  site_name: string;
  site_url?: string;
}

/** Fails closed before the model sees a turn, validating the archive into a local source path. */
export async function prepareDeployedWebsiteEditSources(input: {
  content: string;
  workspaceDir: string;
  ownerClient: DeployedWebsiteSourceOwnerClient;
  downloadClient?: DeployedWebsiteSourceDownloadClient;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<string> {
  const matches = [...input.content.matchAll(DEPLOYED_WEBSITE_CONTEXT_RE)];
  if (matches.length === 0) return input.content;

  const extractionRoot = await ensureExtractionRoot(input.workspaceDir);
  let cursor = 0;
  let prepared = '';
  for (const match of matches) {
    const index = match.index ?? 0;
    const context = parseContext(match[1] ?? '');
    const sourcePath = await materializeSource({ ...input, context, extractionRoot });
    prepared += input.content.slice(cursor, index);
    prepared += `<deployed-website-context>\n${JSON.stringify({
      ...context,
      source_path: sourcePath,
    })}\n</deployed-website-context>`;
    cursor = index + match[0].length;
  }
  return `${prepared}${input.content.slice(cursor)}`;
}

export function prepareDeployedSources(
  host: {
    readonly authContextGetter: (() => LocalRuntimeAuthContext | undefined) | undefined;
    readonly routingContextGetter: (() => LocalRuntimeRoutingContext | undefined) | undefined;
    readonly fetchImpl: typeof fetch | undefined;
  },
  input: { content: string; signal?: AbortSignal },
  workspaceDir: string,
): Promise<string> {
  return prepareDeployedWebsiteEditSources({
    content: input.content,
    workspaceDir,
    ownerClient: new LocalWebsiteManagementClient({
      ...(host.authContextGetter ? { authContext: host.authContextGetter() } : {}),
      routingContextGetter: host.routingContextGetter,
      ...(host.fetchImpl ? { fetchImpl: host.fetchImpl } : {}),
    }),
    downloadClient: new LocalMatrixClient({
      ...(host.authContextGetter ? { authContext: host.authContextGetter() } : {}),
      routingContextGetter: host.routingContextGetter,
      ...(host.fetchImpl ? { fetchImpl: host.fetchImpl } : {}),
    }),
    signal: input.signal,
  });
}

async function materializeSource(input: {
  workspaceDir: string;
  ownerClient: DeployedWebsiteSourceOwnerClient;
  downloadClient?: DeployedWebsiteSourceDownloadClient;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  context: DeployedWebsiteContext;
  extractionRoot: string;
}): Promise<string> {
  const downloadUrl = await getOwnerDownloadUrl(
    input.ownerClient,
    input.context.node_id,
    input.signal,
  );
  const archive = await downloadArchive({
    url: downloadUrl,
    downloadClient: input.downloadClient,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  });
  const sourcePath = join(input.extractionRoot, sourceDirectoryName(input.context.node_id));
  const stagingPath = join(input.extractionRoot, `.${randomUUID()}.staging`);
  try {
    await mkdir(stagingPath);
    await extractArchive(archive, stagingPath);
    await replaceSourceDirectory(sourcePath, stagingPath);
    return sourcePath;
  } finally {
    await rm(stagingPath, { force: true, recursive: true });
  }
}

function parseContext(value: string): DeployedWebsiteContext {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const nodeId = typeof parsed.node_id === 'string' ? parsed.node_id.trim() : '';
    const siteName = typeof parsed.site_name === 'string' ? parsed.site_name.trim() : '';
    const siteUrl = typeof parsed.site_url === 'string' ? parsed.site_url.trim() : '';
    if (!nodeId || !siteName) throw new Error('invalid deployed website context');
    return {
      node_id: nodeId,
      site_name: siteName,
      ...(siteUrl ? { site_url: siteUrl } : {}),
    };
  } catch {
    throw new Error('Invalid deployed website context.');
  }
}

async function getOwnerDownloadUrl(
  ownerClient: DeployedWebsiteSourceOwnerClient,
  nodeId: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  let response: Record<string, unknown>;
  try {
    response = await ownerClient.getProjectSourceDownloadUrl(nodeId, signal);
  } catch {
    throw new Error('Website source owner service failed.');
  }
  const baseResp = readRecord(response.base_resp);
  const baseStatus = readNumber(baseResp?.status_code);
  if (baseStatus !== undefined && baseStatus !== 0) {
    throw new Error('Website source owner service failed.');
  }
  const statusCode = readNumber(response.code);
  if (statusCode !== undefined && statusCode !== 0) {
    const errorCode =
      (baseStatus === undefined || baseStatus === 0) &&
      typeof response.error_code === 'string' &&
      SAFE_ERROR_CODE_RE.test(response.error_code)
        ? response.error_code
        : undefined;
    throw new Error(
      errorCode
        ? `Website source owner service failed (${errorCode}).`
        : 'Website source owner service failed.',
    );
  }
  const downloadUrl = typeof response.download_url === 'string' ? response.download_url.trim() : '';
  if (!downloadUrl) throw new Error('Website source owner service failed.');
  return downloadUrl;
}

async function downloadArchive(input: {
  url: string;
  downloadClient?: DeployedWebsiteSourceDownloadClient;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<Buffer> {
  let stream: { body: ReadableStream<Uint8Array>; contentLength?: number; dispose(): void };
  try {
    stream = input.downloadClient
      ? await input.downloadClient.getStream(input.url, input.signal)
      : await getStreamWithFetch(input.fetchImpl, input.url, input.signal);
  } catch {
    throw new Error('Website source download failed.');
  }
  try {
    if (
      stream.contentLength !== undefined &&
      (!Number.isSafeInteger(stream.contentLength) ||
        stream.contentLength < 0 ||
        stream.contentLength > DEPLOYED_WEBSITE_SOURCE_MAX_ARCHIVE_BYTES)
    ) {
      throw new Error(ARCHIVE_TOO_LARGE_MESSAGE);
    }
    try {
      return await readBoundedStream(stream.body);
    } catch (error) {
      if (error instanceof Error && error.message === ARCHIVE_TOO_LARGE_MESSAGE) throw error;
      throw new Error('Website source download failed.');
    }
  } finally {
    stream.dispose();
  }
}

async function getStreamWithFetch(
  fetchImpl: typeof fetch | undefined,
  url: string,
  signal: AbortSignal | undefined,
): Promise<{ body: ReadableStream<Uint8Array>; contentLength?: number; dispose(): void }> {
  if (!fetchImpl) throw new Error('fetch is unavailable');
  const response = await fetchImpl(url, { method: 'GET', signal });
  if (!response.ok || !response.body) throw new Error('download failed');
  const header = response.headers.get('content-length');
  const contentLength = header && /^\d+$/u.test(header) ? Number(header) : undefined;
  return {
    body: response.body,
    ...(contentLength !== undefined ? { contentLength } : {}),
    dispose() {},
  };
}

async function readBoundedStream(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > DEPLOYED_WEBSITE_SOURCE_MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new Error(ARCHIVE_TOO_LARGE_MESSAGE);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

async function extractArchive(archive: Buffer, stagingPath: string): Promise<void> {
  const zip = await JSZip.loadAsync(archive).catch(() => {
    throw new Error('Website source archive is not a valid ZIP archive.');
  });
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length === 0) throw new Error('Website source archive contains no files.');
  if (entries.length > DEPLOYED_WEBSITE_SOURCE_MAX_FILES) {
    throw new Error('Website source archive contains too many files.');
  }

  let declaredSize = 0;
  for (const entry of entries) {
    assertSafeZipEntry(entry);
    declaredSize += readUncompressedSize(entry);
    if (declaredSize > DEPLOYED_WEBSITE_SOURCE_MAX_UNCOMPRESSED_BYTES) {
      throw new Error('Website source expanded content is too large.');
    }
  }

  let extractedSize = 0;
  for (const entry of entries) {
    const destination = resolveEntryPath(stagingPath, entry.name);
    const content = await entry.async('nodebuffer').catch(() => {
      throw new Error('Website source archive is not a valid ZIP archive.');
    });
    extractedSize += content.byteLength;
    if (extractedSize > DEPLOYED_WEBSITE_SOURCE_MAX_UNCOMPRESSED_BYTES) {
      throw new Error('Website source expanded content is too large.');
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, { flag: 'wx' });
  }
}

function assertSafeZipEntry(entry: JSZip.JSZipObject): void {
  const originalName = entry.unsafeOriginalName ?? entry.name;
  if (isSymbolicLink(entry)) throw new Error('Website source archive contains a symbolic link.');
  if (
    !originalName ||
    originalName.includes('\0') ||
    isAbsolute(originalName) ||
    posix.isAbsolute(originalName) ||
    win32.isAbsolute(originalName) ||
    originalName.split(/[\\/]+/u).some((part) => part === '.' || part === '..')
  ) {
    throw new Error('Website source archive contains an unsafe path.');
  }
}

function isSymbolicLink(entry: JSZip.JSZipObject): boolean {
  const permissions = entry.unixPermissions;
  const mode =
    typeof permissions === 'number'
      ? permissions
      : typeof permissions === 'string' && /^[0-7]+$/u.test(permissions)
        ? Number.parseInt(permissions, 8)
        : undefined;
  return mode !== undefined && (mode & 0o170000) === 0o120000;
}

function resolveEntryPath(root: string, name: string): string {
  const destination = resolve(root, name);
  const pathRelative = relative(root, destination);
  if (
    !pathRelative ||
    pathRelative === '..' ||
    pathRelative.startsWith(`..${sep}`) ||
    isAbsolute(pathRelative)
  ) {
    throw new Error('Website source archive contains an unsafe path.');
  }
  return destination;
}

function readUncompressedSize(entry: JSZip.JSZipObject): number {
  const size = (entry as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw new Error('Website source archive contains invalid size metadata.');
  }
  return size;
}

async function ensureExtractionRoot(workspaceDir: string): Promise<string> {
  const workspace = await realpath(resolve(workspaceDir));
  const mavisRoot = join(workspace, '.mavis');
  await ensureDirectory(mavisRoot);
  const extractionRoot = join(mavisRoot, DEPLOYED_WEBSITE_SOURCE_ROOT);
  await ensureDirectory(extractionRoot);
  return extractionRoot;
}

async function ensureDirectory(path: string): Promise<void> {
  const existing = await lstat(path).catch((error: unknown) => {
    if (isMissingPath(error)) return undefined;
    throw error;
  });
  if (!existing) {
    await mkdir(path, { recursive: true });
    return ensureDirectory(path);
  }
  if (existing.isSymbolicLink())
    throw new Error('Website source extraction root must not be a symbolic link.');
  if (!existing.isDirectory())
    throw new Error('Website source extraction root is not a directory.');
}

async function replaceSourceDirectory(target: string, staging: string): Promise<void> {
  const current = await lstat(target).catch((error: unknown) => {
    if (isMissingPath(error)) return undefined;
    throw error;
  });
  if (current?.isSymbolicLink())
    throw new Error('Website source extraction root must not be a symbolic link.');
  if (current && !current.isDirectory())
    throw new Error('Website source extraction target is not a directory.');
  if (!current) {
    await rename(staging, target);
    return;
  }

  const backup = join(dirname(target), `.${randomUUID()}.previous`);
  await rename(target, backup);
  try {
    await rename(staging, target);
  } catch (error) {
    await rename(backup, target).catch(() => undefined);
    throw error;
  }
  await rm(backup, { force: true, recursive: true });
}

function sourceDirectoryName(nodeId: string): string {
  return createHash('sha256').update(nodeId).digest('hex');
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}
