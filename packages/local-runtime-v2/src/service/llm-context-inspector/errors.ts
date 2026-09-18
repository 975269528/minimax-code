export type LlmContextInspectorErrorCode =
  | 'LLM_CONTEXT_CALL_NOT_FOUND'
  | 'LLM_CONTEXT_INSPECTOR_UNAVAILABLE';

export class LlmContextInspectorServiceError extends Error {
  constructor(
    readonly status: 404 | 503,
    readonly code: LlmContextInspectorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LlmContextInspectorServiceError';
  }
}
