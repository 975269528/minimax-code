import { LLM_ERROR_CODES } from '@mavis/shared/llm-error-classifier';

const RETRYABLE_RUNTIME_ERROR_CODES = new Set<number>([
  LLM_ERROR_CODES.LLM_RATE_LIMITED,
  LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
  LLM_ERROR_CODES.LLM_TPM_RATE_LIMITED,
  LLM_ERROR_CODES.LLM_CLUSTER_OVERLOADED,
]);

export function isProductionRuntimeErrorRetryable(errorCode: number | undefined): boolean {
  return errorCode !== undefined && RETRYABLE_RUNTIME_ERROR_CODES.has(errorCode);
}
