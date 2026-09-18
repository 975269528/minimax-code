import type { LLMModelConfig, PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';

import { logger } from '../common/logger.js';

const REQUEST_ID_HEADERS = ['request-id', 'x-request-id', 'x-mm-request-id'] as const;
const TRACE_ID_HEADERS = ['x-trace-id', 'trace-id', 'uber-trace-id'] as const;

function safeLog(level: 'info' | 'warn' | 'error', fields: unknown, message?: string): void {
  try {
    const normalized =
      fields && typeof fields === 'object' ? (fields as Record<string, unknown>) : {};
    logger[level](normalized, message ?? '[pi-turn-runner]');
  } catch {
    // Logging is observability-only and must never alter a turn outcome.
  }
}

function pickIdentifier(
  headers: Record<string, string>,
  keys: readonly string[],
): { key: string; value: string } | undefined {
  for (const key of keys) {
    const value = headers[key];
    if (value?.trim()) return { key, value };
  }
  return undefined;
}

export const PI_TURN_RUNNER_LOGGER: PiTurnRunnerLogger = {
  debug: (fields, message) => safeLog('info', fields, message),
  info: (fields, message) => safeLog('info', fields, message),
  warn: (fields, message) => safeLog('warn', fields, message),
  error: (fields, message) => safeLog('error', fields, message),
};

export function withLlmResponseIdentifierLogging(
  llm: LLMModelConfig,
  context: { sessionId: string; turnId: string },
): LLMModelConfig {
  const callerResponseObserver = llm.responseObserver;
  return {
    ...llm,
    responseObserver: async (response, model): Promise<void> => {
      const requestId = pickIdentifier(response.headers, REQUEST_ID_HEADERS);
      const traceId = pickIdentifier(response.headers, TRACE_ID_HEADERS);
      if (requestId || traceId) {
        safeLog(
          'info',
          {
            session_id: context.sessionId,
            turn_id: context.turnId,
            provider: model.provider,
            model: model.id,
            response_status: response.status,
            ...(requestId
              ? {
                  downstream_request_id: requestId.value,
                  downstream_request_id_header: requestId.key,
                }
              : {}),
            ...(traceId
              ? {
                  downstream_trace_id: traceId.value,
                  downstream_trace_id_header: traceId.key,
                }
              : {}),
          },
          'llm_response_identifiers',
        );
      }
      await callerResponseObserver?.(response, model);
    },
  };
}
