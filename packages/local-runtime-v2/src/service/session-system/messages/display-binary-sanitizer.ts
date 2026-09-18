import {
  isInlineBinaryContentBlock,
  sanitizeWireToolCallResultData,
} from '@mavis/agent-core/event-bridge';

import type { DisplayMessageRecord } from './repo/contract.js';

export function isInlineDisplayDataUrl(value: unknown): value is string {
  return typeof value === 'string' && /^data:/iu.test(value.trimStart());
}

export function sanitizeDisplayAttachment(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>>;
export function sanitizeDisplayAttachment(value: unknown): unknown;
export function sanitizeDisplayAttachment(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDisplayAttachment);
  if (!isRecord(value)) return value;
  const binaryBlock = isInlineBinaryContentBlock(value);
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      if (isInlineDisplayDataUrl(entry)) return [];
      if (key === 'data' && binaryBlock) return [];
      return [[key, sanitizeDisplayAttachment(entry)]];
    }),
  );
}

export function sanitizeDisplayMessageRecord(message: DisplayMessageRecord): DisplayMessageRecord {
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.map(sanitizeDisplayAttachment)
    : undefined;
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map(sanitizeDisplayToolCall)
    : undefined;
  const camelToolCalls = Array.isArray(message.toolCalls)
    ? message.toolCalls.map(sanitizeDisplayToolCall)
    : undefined;
  if (!attachments && !toolCalls && !camelToolCalls) return message;
  return {
    ...message,
    ...(attachments ? { attachments } : {}),
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
    ...(camelToolCalls ? { toolCalls: camelToolCalls } : {}),
  };
}

function sanitizeDisplayToolCall(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (!isToolCallResultKey(key)) return [key, entry];
      return [
        key,
        typeof entry === 'string'
          ? sanitizeToolResultJson(entry)
          : sanitizeDisplayAttachment(entry),
      ];
    }),
  );
}

function sanitizeToolResultJson(raw: string): string {
  const sanitized = sanitizeWireToolCallResultData(raw);
  if (sanitized === raw && !raw.toLowerCase().includes('data:')) return raw;
  try {
    return JSON.stringify(sanitizeDisplayAttachment(JSON.parse(sanitized)));
  } catch {
    return sanitized;
  }
}

function isToolCallResultKey(key: string): boolean {
  return [
    'tool_call_result_data',
    'tool_call_result_data_json',
    'toolCallResultData',
    'toolCallResultDataJson',
  ].includes(key);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
