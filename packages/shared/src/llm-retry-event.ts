import type { LLMMetricErrorKind } from './llm-error-classifier.js';

export const SESSION_LLM_RETRY_EVENT_TYPE = 'session.llm_retry' as const;

export type SessionLLMRetryScope = 'agent' | 'compaction' | 'title';
export type SessionLLMRetryStatus = 'waiting' | 'recovered' | 'exhausted' | 'cancelled';
/** Retry trigger reasons plus the bounded final-attempt reason on terminal events. */
export type SessionLLMRetryReason = LLMMetricErrorKind;

export interface SessionLLMRetryEventPayload {
  schemaVersion: 1;
  sessionId: string;
  turnId: string;
  callId: string;
  scope: SessionLLMRetryScope;
  status: SessionLLMRetryStatus;
  retryAttempt: number;
  maxRetries: number;
  requestAttempt: number;
  delayMs?: number;
  nextRetryAtMs?: number;
  error?: {
    reason: SessionLLMRetryReason;
    code?: number;
    message: string;
  };
}
