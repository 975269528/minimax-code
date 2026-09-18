export type SessionInputSummaryFailureReason = 'invalid-request' | 'session-not-found';

export class SessionInputSummaryServiceError extends Error {
  constructor(
    readonly reason: SessionInputSummaryFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'SessionInputSummaryServiceError';
  }
}
