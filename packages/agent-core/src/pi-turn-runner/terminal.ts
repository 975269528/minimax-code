import {
  classifyLLMErrorToCode,
  toLLMProtocolClassification,
  type NormalizedLLMError,
} from '@mavis/shared/llm-error-classifier';
import type { TurnTerminationReason } from '../event-bridge/types.js';
import type { RuntimeProtocolError } from '../protocol/runtime-event.js';

/**
 * Exported alias for unit testing — the LLM-error classify branch is
 * significant enough to merit a focused regression test.
 */
export function _computeFailureTerminationReasonForTest(
  runError: string | undefined,
): TurnTerminationReason {
  return failureReason(runError);
}

export function failureReason(
  runError: string | undefined,
  normalized?: NormalizedLLMError,
): TurnTerminationReason {
  const message = runError ?? 'pi-turn-runner: unknown failure';
  const projected = normalized ? toLLMProtocolClassification(normalized) : null;
  const classified = projected
    ? { status_code: projected.code, message: projected.message ?? message }
    : classifyLLMErrorToCode(message);
  if (classified !== null) {
    const protocolError: RuntimeProtocolError = {
      code: classified.status_code,
      message: classified.message,
    };
    return { kind: 'failed', message: classified.message, error: protocolError };
  }
  return { kind: 'failed', message };
}
