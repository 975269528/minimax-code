import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  streamSimple,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { classifyLLMErrorToCode, LLM_ERROR_CODES } from '@mavis/shared/llm-error-classifier';

const BYOK_ERROR_PREFIX = 'BYOK upstream error';
export const BYOK_UPSTREAM_ERROR_SOURCE = 'byok_upstream';
const MAX_ERROR_MESSAGE_LENGTH = 1200;

export interface ByokErrorStatus {
  errorCode: number;
  message: string;
  errorSource: typeof BYOK_UPSTREAM_ERROR_SOURCE;
  errorDetail: string;
  errorProviderId: string;
}

export function withByokErrorAttribution(input: {
  streamFn?: StreamFn;
  providerId: string;
}): StreamFn {
  const base = input.streamFn ?? streamSimple;
  return (async (model, context, options) => {
    try {
      const stream = await base(model, context, options);
      return wrapByokErrorStream(stream, input.providerId, options?.signal);
    } catch (err) {
      if (options?.signal?.aborted) throw err;
      throw new Error(formatByokErrorMessage(err, input.providerId));
    }
  }) as StreamFn;
}

function wrapByokErrorStream(
  stream: AssistantMessageEventStream,
  providerId: string,
  signal?: AbortSignal,
): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const event of stream) {
          yield attributeByokEvent(event, providerId);
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new Error(formatByokErrorMessage(err, providerId));
      }
    },
    async result() {
      try {
        return attributeByokAssistantMessage(await stream.result(), providerId);
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new Error(formatByokErrorMessage(err, providerId));
      }
    },
  } as unknown as AssistantMessageEventStream;
}

function attributeByokEvent(
  event: AssistantMessageEvent,
  providerId: string,
): AssistantMessageEvent {
  if (event.type !== 'error' || event.reason !== 'error') return event;
  return {
    ...event,
    error: attributeByokAssistantMessage(event.error, providerId),
  };
}

function attributeByokAssistantMessage(
  message: AssistantMessage,
  providerId: string,
): AssistantMessage {
  if (message.stopReason !== 'error' || !message.errorMessage) return message;
  return {
    ...message,
    errorMessage: formatByokErrorMessage(message.errorMessage, providerId),
  };
}

export function formatByokErrorMessage(raw: unknown, providerId: string): string {
  const rawMessage = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '';
  if (rawMessage.startsWith(BYOK_ERROR_PREFIX)) return rawMessage;

  const status = buildByokErrorStatus(raw, providerId);
  return `${BYOK_ERROR_PREFIX}: ${JSON.stringify(status)}`;
}

export function parseByokErrorStatus(
  raw: unknown,
  fallbackErrorCode?: number,
): ByokErrorStatus | undefined {
  const rawMessage = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '';
  if (!rawMessage) return undefined;

  if (rawMessage.startsWith(BYOK_ERROR_PREFIX)) {
    const payload = parseByokErrorPayload(rawMessage);
    if (payload) return normalizeByokErrorPayload(payload, fallbackErrorCode);
  }

  const legacyMatch = rawMessage.match(
    /^BYOK provider (?<providerId>.+?) upstream error: (?<detail>[\s\S]*)$/u,
  );
  const providerId = legacyMatch?.groups?.providerId?.trim();
  const detail = legacyMatch?.groups?.detail?.trim();
  if (!providerId || !detail) return undefined;
  const errorCode = fallbackErrorCode ?? LLM_ERROR_CODES.LLM_UPSTREAM_ERROR;
  return {
    errorCode,
    message: rawMessage,
    errorSource: BYOK_UPSTREAM_ERROR_SOURCE,
    errorDetail: detail,
    errorProviderId: providerId,
  };
}

function buildByokErrorStatus(raw: unknown, providerId: string): ByokErrorStatus {
  const rawMessage = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '';
  const classified = classifyLLMErrorToCode(raw);
  const errorCode = classified?.status_code ?? LLM_ERROR_CODES.LLM_UPSTREAM_ERROR;
  const detailSource = classified?.message ?? rawMessage;
  const detail = redactByokErrorMessage(detailSource || 'LLM provider request failed');
  const message = `BYOK provider ${providerId} upstream error: ${detail}`;
  return {
    errorCode,
    message,
    errorSource: BYOK_UPSTREAM_ERROR_SOURCE,
    errorDetail: detail,
    errorProviderId: providerId,
  };
}

function parseByokErrorPayload(message: string): Record<string, unknown> | undefined {
  const start = message.indexOf('{');
  if (start < 0) return undefined;
  try {
    const parsed = JSON.parse(message.slice(start)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeByokErrorPayload(
  payload: Record<string, unknown>,
  fallbackErrorCode?: number,
): ByokErrorStatus | undefined {
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  const legacy = parseByokErrorStatus(message, fallbackErrorCode);
  const providerId =
    typeof payload.errorProviderId === 'string' && payload.errorProviderId.trim()
      ? payload.errorProviderId.trim()
      : legacy?.errorProviderId;
  const detail =
    typeof payload.errorDetail === 'string' && payload.errorDetail.trim()
      ? payload.errorDetail.trim()
      : legacy?.errorDetail;
  if (!providerId || !detail) return undefined;
  return {
    errorCode:
      typeof payload.errorCode === 'number'
        ? payload.errorCode
        : (fallbackErrorCode ?? legacy?.errorCode ?? LLM_ERROR_CODES.LLM_UPSTREAM_ERROR),
    message: message || `BYOK provider ${providerId} upstream error: ${detail}`,
    errorSource: BYOK_UPSTREAM_ERROR_SOURCE,
    errorDetail: detail,
    errorProviderId: providerId,
  };
}

export function redactByokErrorMessage(message: string): string {
  return message
    .slice(0, MAX_ERROR_MESSAGE_LENGTH)
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/gu, 'sk-***')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"',}]+/giu, '$1***')
    .replace(/((?:api[_-]?key|x-api-key)\s*[:=]\s*)[^\s"',}]+/giu, '$1***')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/giu, '$1***');
}
