import { createHash } from 'node:crypto';

import type { messageRows } from '../../../../infra/db/schema/messages.js';
import { MessageDataCorruptionError } from './contract.js';
import type {
  DisplayMessageRecord,
  MessageSourceRecord,
  NormalizedDisplayMessage,
} from './contract.js';
import { sanitizeDisplayMessageRecord } from '../display-binary-sanitizer.js';

export type MessageStorageRow = typeof messageRows.$inferSelect;

export function normalizeDisplayMessage(
  message: DisplayMessageRecord,
  input: {
    readonly turnId?: string;
    readonly source?: string;
    readonly sourceContext?: Record<string, unknown>;
    readonly generatedIdDiscriminator?: string;
    readonly nowMs: () => number;
  },
): NormalizedDisplayMessage {
  const explicitTime = parseTime(message.timestamp ?? message.created_at);
  const createdAtMs = explicitTime ?? Math.floor(input.nowMs());
  const msgId = resolveMessageId(message, explicitTime, input.generatedIdDiscriminator);
  const turnId = resolveTurnId(message, input.turnId);
  const messageHasProvenance = message.source !== undefined || message.sourceContext !== undefined;
  const source = messageHasProvenance ? message.source : input.source;
  const sourceContext = messageHasProvenance ? message.sourceContext : input.sourceContext;
  const data = normalizedData(message, { msgId, createdAtMs, turnId, source, sourceContext });
  return {
    msgId,
    role: typeof data.role === 'string' ? data.role : null,
    turnId: turnId ?? null,
    source: source ?? null,
    sourceContextJson: sourceContext ? JSON.stringify(sourceContext) : null,
    createdAtMs,
    dataJson: JSON.stringify(data),
  };
}

function normalizedData(
  message: DisplayMessageRecord,
  values: {
    readonly msgId: string;
    readonly createdAtMs: number;
    readonly turnId?: string;
    readonly source?: string;
    readonly sourceContext?: Record<string, unknown>;
  },
): DisplayMessageRecord {
  const displayMessage = sanitizeDisplayMessageRecord(message);
  return {
    ...displayMessage,
    msg_id: values.msgId,
    ...(displayMessage.timestamp === undefined && displayMessage.created_at === undefined
      ? { timestamp: values.createdAtMs }
      : {}),
    ...(values.turnId ? { turnId: values.turnId } : {}),
    ...(values.source ? { source: values.source } : {}),
    ...(values.sourceContext ? { sourceContext: values.sourceContext } : {}),
  };
}

function resolveMessageId(
  message: DisplayMessageRecord,
  explicitTime: number | undefined,
  discriminator: string | undefined,
): string {
  return typeof message.msg_id === 'string' && message.msg_id
    ? message.msg_id
    : generatedMessageId(message, explicitTime, discriminator);
}
function resolveTurnId(
  message: DisplayMessageRecord,
  input: string | undefined,
): string | undefined {
  return input ?? message.turnId ?? message.meta?.turnId;
}
export function decodeDisplayMessage(row: MessageStorageRow): DisplayMessageRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.dataJson);
  } catch {
    throw new MessageDataCorruptionError(row.sessionId, row.messageId);
  }
  if (!isObject(parsed) || parsed.msg_id !== row.messageId) {
    throw new MessageDataCorruptionError(row.sessionId, row.messageId);
  }
  const sourceContext = parseSourceContext(row.sourceContextJson, row);
  const result = { ...parsed };
  delete result.source;
  delete result.sourceContext;
  return sanitizeDisplayMessageRecord({
    ...result,
    ...(row.source ? { source: row.source } : {}),
    ...(sourceContext ? { sourceContext } : {}),
  });
}

export function decodeMessageSource(row: MessageStorageRow): MessageSourceRecord | undefined {
  const sourceContext = parseSourceContext(row.sourceContextJson, row);
  if (!row.source && !sourceContext) return undefined;
  return {
    ...(row.source ? { source: row.source } : {}),
    ...(sourceContext ? { sourceContext } : {}),
  };
}

function parseSourceContext(
  raw: string | null,
  row: Pick<MessageStorageRow, 'sessionId' | 'messageId'>,
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isObject(parsed)) return parsed;
  } catch {
    // Fail closed below.
  }
  throw new MessageDataCorruptionError(row.sessionId, row.messageId);
}

function generatedMessageId(
  message: DisplayMessageRecord,
  explicitTime: number | undefined,
  discriminator: string | undefined,
): string {
  const suffix = createHash('sha256')
    .update(JSON.stringify({ message, discriminator }))
    .digest('base64url')
    .slice(0, 20);
  return `msg-${explicitTime ?? 'untimed'}-${suffix}`;
}
function parseTime(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
