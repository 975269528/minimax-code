import { AppError } from '../errors.js';

/** Transport-neutral conversation application failure mapped by delivery boundaries. */
export class ApplicationError extends AppError {
  constructor(status: number, key: string, message: string) {
    super(status, key, message);
    this.name = 'ApplicationError';
  }
}

/** Known Turn admission errors shared by direct HTTP, SSE and queue controls. */
export function turnAdmissionError(reason: string) {
  if (reason === 'policy:cloud-handoff:interrupt-timeout') {
    return {
      status: 409,
      key: 'HANDOFF_INTERRUPT_TIMEOUT',
      message: 'The previous turn has not stopped yet. Cloud handoff was not started.',
    };
  }
  if (reason === 'policy:turn-abort:pre-admission') {
    return {
      status: 409,
      key: 'local_turn_aborted',
      message: 'Turn was stopped before execution.',
    };
  }
  if (reason.startsWith('policy:cloud-handoff:denied:')) {
    const cause = reason.slice('policy:cloud-handoff:denied:'.length);
    const messages: Record<string, string> = {
      'proposal-pending': 'This session already has a handoff proposal awaiting approval.',
      'in-progress': 'This session is already being handed off to Cloud.',
      'already-handed-off':
        'This session has already been handed off. Continue in the existing Cloud session.',
      'cleanup-pending': 'The previous Cloud handoff is awaiting cleanup.',
    };
    return {
      status: 409,
      key: Object.hasOwn(messages, cause)
        ? `HANDOFF_PREFLIGHT_DENIED:${cause}`
        : 'HANDOFF_PREFLIGHT_DENIED',
      message: messages[cause] ?? 'Cloud handoff is not allowed.',
    };
  }
  if (
    reason === 'policy:cloud-handoff:preparation-failed' ||
    reason === 'policy:cloud-handoff:unavailable'
  ) {
    return {
      status: 503,
      key: 'HANDOFF_PREFLIGHT_UNAVAILABLE',
      message: 'Unable to prepare Cloud handoff. Please try again later.',
    };
  }
  return undefined;
}
