import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { DisplayMessageRecord, MessageRepository } from '../messages/repo/contract.js';
import type { LegacyImportedAssetPort } from './assets.js';
import type { LegacyOpencodeSourceReader } from './repo/contract.js';

const DISPLAY_BATCH_COUNT = 250;
const DISPLAY_BATCH_BYTES = 8 * 1024 * 1024;
const INLINE_BINARY_THRESHOLD = 1_024;
const BASE64_CHARS = /^[A-Za-z0-9+/_=\s-]+$/u;

interface LegacyDisplayStreamImportResult {
  readonly count: number;
  readonly checksum: string;
  readonly parsedCount: number;
  readonly duplicateRewritten: number;
  readonly missingAssigned: number;
  readonly warnings: readonly string[];
  readonly attachments: { copied: number; dataUrl: number; missing: number };
}

interface LegacyDisplayStreamImportOptions {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly duplicateSourceMsgIds: readonly string[];
  readonly source: Pick<LegacyOpencodeSourceReader, 'streamMessagePages'>;
  readonly messages: Pick<MessageRepository, 'list' | 'replaceStream'>;
  readonly assets: LegacyImportedAssetPort;
  readonly nowMs: () => number;
}

interface DisplayImportState {
  readonly seenSourceIds: Map<string, number>;
  readonly sourceIds: Set<string>;
  readonly duplicateSourceIds: ReadonlySet<string>;
  sourceIndex: number;
  parsedCount: number;
  duplicateRewritten: number;
  missingAssigned: number;
}

interface SerializedMessage {
  readonly message: DisplayMessageRecord;
  readonly bytes: number;
}

export async function importLegacyDisplayStream(
  options: LegacyDisplayStreamImportOptions,
): Promise<LegacyDisplayStreamImportResult> {
  const existing = (await options.messages.list(options.targetSessionId)).messages;
  const duplicateSourceIds = new Set(options.duplicateSourceMsgIds);
  const existingById = new Map(
    existing.flatMap((message) =>
      message.msg_id && !duplicateSourceIds.has(message.msg_id)
        ? [[message.msg_id, message] as const]
        : [],
    ),
  );
  const state: DisplayImportState = {
    seenSourceIds: new Map(),
    sourceIds: new Set(),
    duplicateSourceIds,
    sourceIndex: 0,
    parsedCount: 0,
    duplicateRewritten: 0,
    missingAssigned: 0,
  };
  const attachments = { copied: 0, dataUrl: 0, missing: 0 };
  const displayHash = createHash('sha256');
  displayHash.update('[');
  let checksumCount = 0;
  let importedCount = 0;

  const serialize = (message: DisplayMessageRecord): SerializedMessage => {
    const json = JSON.stringify(message);
    if (json === undefined) throw new TypeError('Display message cannot be serialized');
    if (checksumCount > 0) displayHash.update(',');
    displayHash.update(json);
    checksumCount += 1;
    importedCount += 1;
    return { message, bytes: Buffer.byteLength(json, 'utf8') };
  };

  const batches = transformedDisplayBatches({
    ...options,
    existing,
    existingById,
    state,
    attachments,
    serialize,
  });
  await options.messages.replaceStream({ sessionId: options.targetSessionId, batches });
  displayHash.update(']');
  return {
    count: importedCount,
    checksum: displayHash.digest('hex'),
    parsedCount: state.parsedCount,
    duplicateRewritten: state.duplicateRewritten,
    missingAssigned: state.missingAssigned,
    warnings: [
      ...(state.duplicateRewritten > 0
        ? [`legacy_duplicate_msg_id_rewritten:${String(state.duplicateRewritten)}`]
        : []),
      ...(state.missingAssigned > 0
        ? [`legacy_missing_msg_id_assigned:${String(state.missingAssigned)}`]
        : []),
    ],
    attachments,
  };
}

interface TransformOptions extends LegacyDisplayStreamImportOptions {
  readonly existing: readonly DisplayMessageRecord[];
  readonly existingById: ReadonlyMap<string, DisplayMessageRecord>;
  readonly state: DisplayImportState;
  readonly attachments: { copied: number; dataUrl: number; missing: number };
  readonly serialize: (message: DisplayMessageRecord) => SerializedMessage;
}

async function* transformedDisplayBatches(
  options: TransformOptions,
): AsyncGenerator<readonly DisplayMessageRecord[], void, void> {
  let batch: DisplayMessageRecord[] = [];
  let batchBytes = 2;
  const enqueue = (serialized: SerializedMessage): readonly DisplayMessageRecord[] | undefined => {
    const separatorBytes = batch.length > 0 ? 1 : 0;
    if (batch.length > 0 && batchBytes + separatorBytes + serialized.bytes > DISPLAY_BATCH_BYTES) {
      const ready = batch;
      batch = [serialized.message];
      batchBytes = 2 + serialized.bytes;
      return ready;
    }
    batch.push(serialized.message);
    batchBytes += separatorBytes + serialized.bytes;
    if (batch.length >= DISPLAY_BATCH_COUNT || batchBytes >= DISPLAY_BATCH_BYTES) {
      const ready = batch;
      batch = [];
      batchBytes = 2;
      return ready;
    }
    return undefined;
  };
  for await (const page of options.source.streamMessagePages(
    options.sourceSessionId,
    DISPLAY_BATCH_COUNT,
    DISPLAY_BATCH_BYTES,
  )) {
    options.state.parsedCount += page.length;
    const preferred = page.map((message) =>
      preferExistingMessage(prepareSourceMessage(message, options.state), options),
    );
    const normalized = await Promise.all(
      preferred.map((message) => normalizeMessageAttachments(message, options)),
    );
    const transformed = normalized.map((message) =>
      options.serialize(sanitizeDisplayMessage(message)),
    );
    for (const message of transformed) {
      const ready = enqueue(message);
      if (ready) yield ready;
    }
  }
  for (const message of options.existing) {
    if (message.msg_id && options.state.sourceIds.has(message.msg_id)) continue;
    const normalized = await normalizeMessageAttachments(message, options);
    const ready = enqueue(options.serialize(sanitizeDisplayMessage(normalized)));
    if (ready) yield ready;
  }
  if (batch.length > 0) yield batch;
}

function prepareSourceMessage(
  message: DisplayMessageRecord,
  state: DisplayImportState,
): DisplayMessageRecord {
  const original =
    typeof message.msg_id === 'string' && message.msg_id.trim() ? message.msg_id : undefined;
  const base = original ?? `legacy-missing-msg-id-${String(state.sourceIndex + 1)}`;
  const count = state.seenSourceIds.get(base) ?? 0;
  state.seenSourceIds.set(base, count + 1);
  const sourceIndex = state.sourceIndex;
  state.sourceIndex += 1;
  if (!original) {
    state.missingAssigned += 1;
    const prepared = {
      ...message,
      msg_id: `${base}-${checksumJson(message).slice(0, 12)}`,
    };
    state.sourceIds.add(prepared.msg_id);
    return prepared;
  }
  if (count > 0) {
    state.duplicateRewritten += 1;
    const prepared = {
      ...message,
      msg_id: `${base}__legacy_dup_${String(count + 1)}_${String(sourceIndex + 1)}`,
    };
    state.sourceIds.add(prepared.msg_id);
    return prepared;
  }
  state.sourceIds.add(original);
  return message;
}

function preferExistingMessage(
  message: DisplayMessageRecord,
  options: Pick<TransformOptions, 'existingById' | 'state'>,
): DisplayMessageRecord {
  if (!message.msg_id || options.state.duplicateSourceIds.has(message.msg_id)) return message;
  return options.existingById.get(message.msg_id) ?? message;
}

async function normalizeMessageAttachments(
  message: DisplayMessageRecord,
  options: Pick<TransformOptions, 'assets' | 'attachments' | 'nowMs' | 'sourceSessionId'>,
): Promise<DisplayMessageRecord> {
  if (!Array.isArray(message.attachments)) return message;
  const attachments = await Promise.all(
    message.attachments.map((candidate) => normalizeAttachment(candidate, options)),
  );
  return { ...message, attachments };
}

async function normalizeAttachment(
  candidate: unknown,
  options: Pick<TransformOptions, 'assets' | 'attachments' | 'nowMs' | 'sourceSessionId'>,
): Promise<unknown> {
  if (!isRecord(candidate)) return candidate;
  const source = attachmentSource(candidate);
  if (readString(candidate.asset_id) ?? readString(candidate.assetId)) return candidate;
  if (!source.sourcePath && !source.dataUrl) return candidate;
  try {
    const asset = await options.assets.register({
      fileName: attachmentFileName(candidate),
      mimeType: attachmentMimeType(candidate),
      ...source,
      sourceKind: 'legacy-migration',
      sessionId: options.sourceSessionId,
      nowMs: options.nowMs,
    });
    if (source.dataUrl) options.attachments.dataUrl += 1;
    else options.attachments.copied += 1;
    return importedAttachmentMetadata(candidate, asset);
  } catch {
    options.attachments.missing += 1;
    return candidate;
  }
}

function attachmentSource(candidate: Record<string, unknown>): {
  sourcePath?: string;
  dataUrl?: string;
} {
  return {
    sourcePath: readString(candidate.file_path) ?? readString(candidate.filePath),
    dataUrl: readString(candidate.data_url) ?? readString(candidate.dataUrl),
  };
}

function attachmentFileName(candidate: Record<string, unknown>): string {
  return readString(candidate.file_name) ?? readString(candidate.fileName) ?? 'attachment';
}

function attachmentMimeType(candidate: Record<string, unknown>): string {
  return (
    readString(candidate.mime_type) ?? readString(candidate.mimeType) ?? 'application/octet-stream'
  );
}

function importedAttachmentMetadata(
  candidate: Record<string, unknown>,
  asset: Awaited<ReturnType<LegacyImportedAssetPort['register']>>,
): Record<string, unknown> {
  const metadata = Object.fromEntries(
    Object.entries(candidate).filter(([key]) => key !== 'data_url' && key !== 'dataUrl'),
  );
  return {
    ...metadata,
    file_path: asset.absolutePath,
    file_name: asset.fileName,
    mime_type: asset.mimeType,
    asset_id: asset.assetId,
  };
}

function sanitizeDisplayMessage(message: DisplayMessageRecord): DisplayMessageRecord {
  if (!Array.isArray(message.tool_calls)) return message;
  let changed = false;
  const toolCalls = message.tool_calls.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.tool_call_result_data !== 'string') {
      return candidate;
    }
    const cleaned = sanitizeWireToolCallResultData(candidate.tool_call_result_data);
    if (cleaned === candidate.tool_call_result_data) return candidate;
    changed = true;
    return { ...candidate, tool_call_result_data: cleaned };
  });
  return changed ? { ...message, tool_calls: toolCalls } : message;
}

/** Keeps legacy display rows compact without importing the Agent runtime owner. */
function sanitizeWireToolCallResultData(raw: string): string {
  if (!raw) return raw;
  const first = raw.trimStart()[0];
  if (first !== '{' && first !== '[') {
    return raw.length > INLINE_BINARY_THRESHOLD ? `<omitted:non-json ${raw.length} bytes>` : raw;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.length > INLINE_BINARY_THRESHOLD
      ? `<omitted:invalid-json ${raw.length} bytes>`
      : raw;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.content)) return raw;
  const content = parsed.content.filter((block) => !isInlineBinaryBlock(block));
  if (content.length === parsed.content.length) return raw;
  return JSON.stringify({ ...parsed, content });
}

function isInlineBinaryBlock(value: unknown): boolean {
  if (!isRecord(value) || typeof value.data !== 'string') return false;
  const type = typeof value.type === 'string' ? value.type : '';
  if (['image', 'video', 'audio', 'file'].includes(type)) return true;
  const sample = value.data.length > 256 ? value.data.slice(0, 256) : value.data;
  return value.data.length >= INLINE_BINARY_THRESHOLD && BASE64_CHARS.test(sample);
}

export function checksumJson(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
