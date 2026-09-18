import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model, Tool } from '@earendil-works/pi-ai';
import {
  buildMessagesCountTokensRequestBody,
  type MessagesCountTokensBuildOptions,
  type MessagesCountTokensRequestBody,
} from './messages-count-tokens-payload.js';
import { estimateImageBlockTokens } from './image-detection.js';

const FALLBACK_MESSAGE_OVERHEAD = 4;

export type CountTokensRequestBody = MessagesCountTokensRequestBody;

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}

export type CountTokensRequestBodyOptions = MessagesCountTokensBuildOptions;

export function buildCountTokensRequestBody(
  messages: AgentMessage[],
  systemPrompt: string | undefined,
  model: Model<Api>,
  tools?: Tool[],
  options: CountTokensRequestBodyOptions = {},
): CountTokensRequestBody {
  return buildMessagesCountTokensRequestBody(messages, systemPrompt, model, tools, options);
}

/**
 * Whether the request body contains base64 image/video blocks in user messages or embedded
 * tool_result content. Retained for adapter/request-shape checks; this does not trigger uploads by
 * the remote counter.
 */
export function countTokensBodyHasImages(body: CountTokensRequestBody): boolean {
  for (const message of body.messages ?? []) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (isBase64MediaBlock(block)) return true;
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        if (block.content.some((nested) => isBase64MediaBlock(nested))) return true;
      }
    }
  }
  return false;
}

function isBase64MediaBlock(block: unknown): boolean {
  const type = (block as { type?: unknown } | undefined)?.type;
  return type === 'image' || type === 'video';
}

const CJK_RE =
  /[\u{3000}-\u{303F}\u{3040}-\u{30FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}\u{FF00}-\u{FFEF}\u{AC00}-\u{D7AF}\u{20000}-\u{2FA1F}]/u;

export function estimateCharsToTokensCjkAware(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export function cjkFallbackTokensForBody(body: CountTokensRequestBody, model?: Model<Api>): number {
  let total = estimateMessagesPayloadTokens(body.system, model);
  for (const m of body.messages ?? [])
    total += FALLBACK_MESSAGE_OVERHEAD + estimateMessagesPayloadTokens(m, model);
  for (const tool of body.tools ?? []) {
    const record = tool as { name?: unknown; description?: unknown; input_schema?: unknown };
    total +=
      FALLBACK_MESSAGE_OVERHEAD +
      estimateMessagesPayloadTokens(record.name, model) +
      estimateMessagesPayloadTokens(record.description, model) +
      estimateCharsToTokensCjkAware(safeJsonStringify(record.input_schema));
  }
  return total;
}

function estimateMessagesPayloadTokens(value: unknown, model?: Model<Api>): number {
  if (typeof value === 'string') return estimateCharsToTokensCjkAware(value);
  if (typeof value === 'number' || typeof value === 'boolean')
    return estimateCharsToTokensCjkAware(String(value));
  if (!value) return 0;
  if (Array.isArray(value))
    return value.reduce((total, item) => total + estimateMessagesPayloadTokens(item, model), 0);
  if (typeof value !== 'object') return 0;

  const record = value as Record<string, unknown>;
  if (record.type === 'image' || record.type === 'video')
    return estimateImageBlockTokens(record as Record<string, unknown>, { model });
  if (record.type === 'text') return estimateMessagesPayloadTokens(record.text, model);
  if (record.type === 'thinking') {
    return (
      estimateMessagesPayloadTokens(record.thinking, model) +
      estimateMessagesPayloadTokens(record.signature, model)
    );
  }
  if (record.type === 'redacted_thinking') return estimateMessagesPayloadTokens(record.data, model);
  if (record.type === 'tool_use') {
    return (
      estimateMessagesPayloadTokens(record.id, model) +
      estimateMessagesPayloadTokens(record.name, model) +
      estimateCharsToTokensCjkAware(safeJsonStringify(record.input))
    );
  }
  if (record.type === 'tool_result') {
    return (
      estimateMessagesPayloadTokens(record.tool_use_id, model) +
      estimateMessagesPayloadTokens(record.content, model) +
      estimateMessagesPayloadTokens(record.is_error, model)
    );
  }

  let total = 0;
  for (const [key, nested] of Object.entries(record)) {
    if (key === 'data' || key === 'source' || key === 'cache_control') continue;
    total += estimateMessagesPayloadTokens(nested, model);
  }
  return total;
}
