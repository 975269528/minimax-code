export type SessionFailureReason =
  | 'agent-not-found'
  | 'workspace-required'
  | 'parent-not-found'
  | 'invalid-session-kind'
  | 'parent-required'
  | 'session-not-found'
  | 'session-busy'
  | 'maintenance-lease-lost'
  | 'content-policy-rejected'
  | 'runtime-unsupported'
  | 'session-id-conflict'
  | 'run-location-invalid'
  | 'memory-recall-locked'
  | 'task-agent-capture-unavailable';

export class SessionServiceError extends Error {
  constructor(
    readonly reason: SessionFailureReason,
    message: string,
    readonly detailCode?: string,
  ) {
    super(message);
    this.name = 'SessionServiceError';
  }
}

export class SessionQueryServiceError extends Error {
  constructor(
    readonly reason: 'session-not-found',
    message: string,
  ) {
    super(message);
    this.name = 'SessionQueryServiceError';
  }
}
