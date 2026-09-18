/**
 * V2-owned Messages File API final-payload patcher.
 * Keep upload, cache-key, traversal and per-block fail-open behavior aligned
 * with the v1 and cloud-runtime functional twins.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { Api, Model } from '@earendil-works/pi-ai';

interface FileApiUploadCacheEntry {
  readonly fileId: string;
  readonly expiresAtMs: number;
}

export interface FileApiUploadKey {
  readonly contentHash: string;
  readonly endpointHash: string;
  readonly callerIdentityHash: string;
  readonly ttlSec: number;
}

interface FileApiUploadRecord extends FileApiUploadKey, FileApiUploadCacheEntry {}

export interface FileApiUploadStore {
  get(
    cacheKey: string,
    key: FileApiUploadKey,
  ): FileApiUploadCacheEntry | undefined | Promise<FileApiUploadCacheEntry | undefined>;
  set(
    cacheKey: string,
    entry: FileApiUploadCacheEntry,
    record: FileApiUploadRecord,
  ): void | Promise<void>;
}

export interface FileApiUploadStoreSource {
  forSession(sessionId: string): FileApiUploadStore;
}

export interface MessagesFileApiPatcherLogger {
  info?(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn?(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface MessagesFileApiPatcherOptions {
  readonly uploadEndpoint: string;
  readonly refScheme: string;
  readonly gatewayHeaders: Readonly<Record<string, string>>;
  readonly callerIdentityHash: string;
  readonly ttlSec: number;
  readonly store: FileApiUploadStore;
  readonly uploadTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly nowMs?: () => number;
  readonly signal?: AbortSignal;
  readonly logger?: MessagesFileApiPatcherLogger;
}

interface Base64MediaSource {
  readonly type: 'base64';
  readonly media_type: string;
  readonly data: string;
}

interface MediaTarget {
  readonly block: Record<string, unknown>;
  readonly source: Base64MediaSource;
  readonly blockIndex: number;
  readonly purpose: 'image_understanding' | 'video_understanding';
  readonly videoMimeFallback: boolean;
}

interface FileApiPatcherRuntime {
  readonly options: MessagesFileApiPatcherOptions;
  readonly fetchImpl: typeof fetch;
  readonly nowMs: () => number;
  readonly ttlSec: number;
  readonly uploadTimeoutMs: number;
  readonly endpointHash: string;
  readonly endpointForLog: string;
  readonly inFlight: Map<string, Promise<string | undefined>>;
}

class FileApiUploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly apiStatusCode?: number | string,
  ) {
    super(message);
    this.name = 'FileApiUploadError';
  }
}

function buildFileApiUploadCacheKey(input: FileApiUploadKey): string {
  return `${input.contentHash}:${input.endpointHash}:${input.callerIdentityHash}:${input.ttlSec}`;
}

export function buildMessagesFileApiPatcher(options: MessagesFileApiPatcherOptions) {
  const runtime: FileApiPatcherRuntime = {
    options,
    fetchImpl: options.fetchImpl ?? fetch,
    nowMs: options.nowMs ?? Date.now,
    ttlSec: Number.isFinite(options.ttlSec) && options.ttlSec >= 0 ? options.ttlSec : 43_200,
    uploadTimeoutMs: validTimeout(options.uploadTimeoutMs),
    endpointHash: sha256(options.uploadEndpoint),
    endpointForLog: redactEndpointForLog(options.uploadEndpoint),
    inFlight: new Map(),
  };

  return async function patchMessagesFileApiBlocks(
    payload: unknown,
    model: Model<Api>,
  ): Promise<unknown | undefined> {
    if (
      options.signal?.aborted ||
      model.api !== 'anthropic-messages' ||
      !isMessagesPayload(payload)
    ) {
      return undefined;
    }
    const targets = collectMediaTargets(payload.messages);
    if (targets.length === 0) return undefined;
    let mutated = false;
    let convertedCount = 0;
    await Promise.all(
      targets.map(async (target) => {
        const fileId = await resolveFileId(runtime, target);
        if (!fileId) return;
        target.block.source = { type: 'url', url: `${options.refScheme}${fileId}` };
        mutated = true;
        convertedCount += 1;
      }),
    );
    logConversionSummary(runtime, targets, convertedCount);
    return mutated ? payload : undefined;
  };
}

function logConversionSummary(
  runtime: FileApiPatcherRuntime,
  targets: readonly MediaTarget[],
  convertedCount: number,
): void {
  const videoMimeFallbackCount = targets.filter((target) => target.videoMimeFallback).length;
  const skippedCount = targets.length - convertedCount;
  if (videoMimeFallbackCount === 0 && skippedCount === 0) return;
  runtime.options.logger?.info?.(
    {
      candidate_count: targets.length,
      converted_count: convertedCount,
      skipped_count: skippedCount,
      video_mime_fallback_count: videoMimeFallbackCount,
    },
    '[messages-file-api] final payload media conversion summary',
  );
}

async function resolveFileId(
  runtime: FileApiPatcherRuntime,
  target: MediaTarget,
): Promise<string | undefined> {
  const recordKey: FileApiUploadKey = {
    contentHash: hashMediaIdentity(target),
    endpointHash: runtime.endpointHash,
    callerIdentityHash: runtime.options.callerIdentityHash,
    ttlSec: runtime.ttlSec,
  };
  const cacheKey = buildFileApiUploadCacheKey(recordKey);
  const cached = await readCachedFileId(runtime, target, cacheKey, recordKey);
  if (cached) return cached;
  if (runtime.options.signal?.aborted) return undefined;
  const pending = getOrCreateUpload(runtime, target, cacheKey, recordKey);
  try {
    return await pending;
  } catch (error) {
    return handleUploadFailure(runtime, target, error);
  }
}

async function readCachedFileId(
  runtime: FileApiPatcherRuntime,
  target: MediaTarget,
  cacheKey: string,
  recordKey: FileApiUploadKey,
): Promise<string | undefined> {
  try {
    const cached = await runtime.options.store.get(cacheKey, recordKey);
    return cached && cached.expiresAtMs > runtime.nowMs() ? cached.fileId : undefined;
  } catch (error) {
    if (runtime.options.signal?.aborted) return undefined;
    warn(
      runtime.options.logger,
      {
        upload_endpoint: runtime.endpointForLog,
        block_index: target.blockIndex,
        error_type: errorType(error),
      },
      '[messages-file-api] cache lookup failed; uploading without a cached reference',
    );
    return undefined;
  }
}

function getOrCreateUpload(
  runtime: FileApiPatcherRuntime,
  target: MediaTarget,
  cacheKey: string,
  recordKey: FileApiUploadKey,
): Promise<string | undefined> {
  const existing = runtime.inFlight.get(cacheKey);
  if (existing) return existing;
  const pending = runTrackedUpload(runtime, target, cacheKey, recordKey);
  runtime.inFlight.set(cacheKey, pending);
  return pending;
}

async function runTrackedUpload(
  runtime: FileApiPatcherRuntime,
  target: MediaTarget,
  cacheKey: string,
  recordKey: FileApiUploadKey,
): Promise<string | undefined> {
  try {
    return await uploadAndRemember({
      options: runtime.options,
      fetchImpl: runtime.fetchImpl,
      nowMs: runtime.nowMs,
      ttlSec: runtime.ttlSec,
      uploadTimeoutMs: runtime.uploadTimeoutMs,
      cacheKey,
      recordKey,
      target,
    });
  } finally {
    runtime.inFlight.delete(cacheKey);
  }
}

function handleUploadFailure(
  runtime: FileApiPatcherRuntime,
  target: MediaTarget,
  error: unknown,
): undefined {
  if (runtime.options.signal?.aborted) return undefined;
  warn(
    runtime.options.logger,
    {
      upload_endpoint: runtime.endpointForLog,
      block_index: target.blockIndex,
      ...fileApiErrorFields(error),
      error_type: errorType(error),
    },
    '[messages-file-api] upload failed; keeping inline media block',
  );
  return undefined;
}

function fileApiErrorFields(error: unknown): Readonly<Record<string, number | string>> {
  if (!(error instanceof FileApiUploadError)) return {};
  const fields: Record<string, number | string> = {};
  if (error.status !== undefined) fields.status = error.status;
  if (error.apiStatusCode !== undefined) fields.api_status_code = error.apiStatusCode;
  return fields;
}

async function uploadAndRemember(input: {
  readonly options: MessagesFileApiPatcherOptions;
  readonly fetchImpl: typeof fetch;
  readonly nowMs: () => number;
  readonly ttlSec: number;
  readonly uploadTimeoutMs: number;
  readonly cacheKey: string;
  readonly recordKey: FileApiUploadKey;
  readonly target: MediaTarget;
}): Promise<string> {
  const fileId = await uploadMedia({
    fetchImpl: input.fetchImpl,
    endpoint: input.options.uploadEndpoint,
    gatewayHeaders: input.options.gatewayHeaders,
    target: input.target,
    timeoutMs: input.uploadTimeoutMs,
    ...(input.options.signal ? { signal: input.options.signal } : {}),
  });
  const expiresAtMs = input.nowMs() + input.ttlSec * 1_000;
  const entry = { fileId, expiresAtMs };
  try {
    await input.options.store.set(input.cacheKey, entry, { ...input.recordKey, ...entry });
  } catch (error) {
    warn(
      input.options.logger,
      {
        upload_endpoint: redactEndpointForLog(input.options.uploadEndpoint),
        block_index: input.target.blockIndex,
        error_type: errorType(error),
      },
      '[messages-file-api] cache persistence failed after upload; continuing with file reference',
    );
  }
  return fileId;
}

async function uploadMedia(input: {
  readonly fetchImpl: typeof fetch;
  readonly endpoint: string;
  readonly gatewayHeaders: Readonly<Record<string, string>>;
  readonly target: MediaTarget;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const form = new FormData();
  const bytes = Buffer.from(input.target.source.data, 'base64');
  form.append('purpose', input.target.purpose);
  form.append(
    'file',
    new Blob([bytes], { type: input.target.source.media_type }),
    filenameForMediaType(input.target.source.media_type),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  const abortForTurn = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abortForTurn();
  else input.signal?.addEventListener('abort', abortForTurn, { once: true });
  try {
    const response = await input.fetchImpl(input.endpoint, {
      method: 'POST',
      headers: input.gatewayHeaders,
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) throw new FileApiUploadError('upload returned non-2xx', response.status);
    const body = (await response.json()) as unknown;
    const fileId = readSuccessfulFileId(body);
    if (!fileId) {
      throw new FileApiUploadError(
        'upload response missing successful file_id',
        response.status,
        readFileApiStatusCode(body),
      );
    }
    return fileId;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abortForTurn);
  }
}

function collectMediaTargets(messages: Array<{ content?: unknown[] } | null>): MediaTarget[] {
  const targets: MediaTarget[] = [];
  const visited = new WeakSet<object>();
  let blockIndex = 0;
  const visitContent = (value: unknown): void => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => visitContent(item));
      return;
    }
    if (!isRecord(value)) return;
    const currentIndex = blockIndex++;
    const source = readBase64MediaSource(value.source);
    const purpose = mediaPurpose(value.type, source?.media_type);
    if (source && purpose) {
      targets.push({
        block: value,
        source,
        blockIndex: currentIndex,
        purpose,
        videoMimeFallback: value.type === 'image' && purpose === 'video_understanding',
      });
    }
    if (Array.isArray(value.content)) visitContent(value.content);
  };
  messages.forEach((message) => {
    if (message && Array.isArray(message.content)) visitContent(message.content);
  });
  return targets;
}

function mediaPurpose(
  blockType: unknown,
  mediaType: string | undefined,
): MediaTarget['purpose'] | undefined {
  const normalized = mediaType?.trim().toLowerCase();
  if (blockType === 'image' && normalized?.startsWith('image/')) return 'image_understanding';
  if ((blockType === 'image' || blockType === 'video') && normalized?.startsWith('video/')) {
    return 'video_understanding';
  }
  return undefined;
}

function readBase64MediaSource(value: unknown): Base64MediaSource | undefined {
  if (!isRecord(value)) return undefined;
  return value.type === 'base64' &&
    typeof value.media_type === 'string' &&
    typeof value.data === 'string'
    ? { type: 'base64', media_type: value.media_type, data: value.data }
    : undefined;
}

function readSuccessfulFileId(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.base_resp) || !isRecord(value.file)) return undefined;
  if (value.base_resp.status_code !== 0) return undefined;
  const fileId = value.file.file_id;
  if (typeof fileId === 'number') {
    return Number.isSafeInteger(fileId) && fileId >= 0 ? String(fileId) : undefined;
  }
  return typeof fileId === 'string' && fileId.trim() ? fileId.trim() : undefined;
}

function readFileApiStatusCode(value: unknown): number | string | undefined {
  if (!isRecord(value) || !isRecord(value.base_resp)) return undefined;
  const code = value.base_resp.status_code;
  return typeof code === 'number' || typeof code === 'string' ? code : undefined;
}

function filenameForMediaType(mediaType: string): string {
  const subtype = mediaType.split('/')[1]?.toLowerCase() ?? '';
  let extension = /^[a-z0-9]+$/u.test(subtype) ? subtype : 'bin';
  if (subtype === 'jpeg') extension = 'jpg';
  if (subtype === 'quicktime') extension = 'mov';
  if (subtype === 'x-msvideo') extension = 'avi';
  return `mavis-media.${extension}`;
}

function hashMediaIdentity(target: MediaTarget): string {
  return createHash('sha256')
    .update(target.purpose)
    .update('\0')
    .update(target.source.media_type.trim().toLowerCase())
    .update('\0')
    .update(target.source.data)
    .digest('hex');
}

function redactEndpointForLog(value: string): string {
  try {
    const endpoint = new URL(value);
    endpoint.username = '';
    endpoint.password = '';
    endpoint.search = '';
    endpoint.hash = '';
    return endpoint.toString();
  } catch {
    return '[invalid gateway endpoint]';
  }
}

function validTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 60_000;
}

function warn(
  logger: MessagesFileApiPatcherLogger | undefined,
  fields: Readonly<Record<string, unknown>>,
  message: string,
): void {
  logger?.warn?.(fields, message);
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isMessagesPayload(
  payload: unknown,
): payload is { messages: Array<{ content?: unknown[] } | null> } {
  return isRecord(payload) && Array.isArray(payload.messages);
}
