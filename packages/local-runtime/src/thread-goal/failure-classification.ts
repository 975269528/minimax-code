import { ProtocolErrorCode } from '@mavis/protocol';
import { LLM_ERROR_CODES } from '@mavis/shared/llm-error-classifier';

import type { ThreadGoalFailureClass } from '@mavis/goal';

export interface ThreadGoalFailureInput {
  readonly code?: number | string;
  readonly message?: string;
  readonly details?: unknown;
}

/**
 * Collapse transport/provider failures into the bounded Goal settlement
 * catalog. Raw provider text is used only for classification and is never
 * persisted as a Goal status reason.
 */
export function classifyThreadGoalFailure(
  input: ThreadGoalFailureInput | undefined,
): ThreadGoalFailureClass {
  const code = Number(input?.code);
  const message = `${input?.message ?? ''} ${input?.details ?? ''}`.trim().toLowerCase();

  if (
    code === LLM_ERROR_CODES.USAGE_LIMIT_EXCEEDED ||
    code === LLM_ERROR_CODES.LLM_CREDITS_EXHAUSTED ||
    /\b(?:quota|credits? exhausted|insufficient (?:balance|credits?)|usage limit)\b/u.test(message)
  ) {
    return 'provider_quota';
  }
  if (
    code === LLM_ERROR_CODES.LLM_RATE_LIMITED ||
    code === LLM_ERROR_CODES.LLM_TPM_RATE_LIMITED ||
    code === 429 ||
    /\b(?:rate limit|rate_limited|too many requests|tpm|rpm)\b/u.test(message)
  ) {
    return 'rate_limit';
  }
  if (
    code === ProtocolErrorCode.SAFETY_SENSITIVE ||
    /\b(?:content[_ -]?filter|safety sensitive|sensitive content|policy violation)\b/u.test(message)
  ) {
    return 'safety';
  }
  if (
    code === ProtocolErrorCode.TIMEOUT ||
    code === ProtocolErrorCode.RUNTIME_UNAVAILABLE ||
    code === ProtocolErrorCode.INTERNAL ||
    code === ProtocolErrorCode.SAFETY_UNAVAILABLE ||
    code === LLM_ERROR_CODES.LLM_UPSTREAM_ERROR ||
    code === LLM_ERROR_CODES.LLM_CLUSTER_OVERLOADED ||
    (code >= 500 && code <= 599) ||
    /\b(?:timeout|timed out|network|upstream|overload|temporar(?:y|ily) unavailable)\b/u.test(
      message,
    )
  ) {
    return 'infra_retryable';
  }
  return 'unknown';
}
