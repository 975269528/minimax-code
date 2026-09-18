import { LocalQuestionnaireError } from './errors.js';

export type QuestionnaireReplyOutcome =
  | { status: 'accepted' }
  | { status: 'terminal'; code?: string }
  | { status: 'retryable'; code?: string };

const TERMINAL_QUESTIONNAIRE_REPLY_CODES = new Set([
  'QUESTIONNAIRE_NOT_FOUND',
  'QUESTIONNAIRE_ALREADY_ANSWERED',
  'QUESTIONNAIRE_NOT_PENDING',
  'SESSION_NOT_FOUND',
]);

/**
 * Convert the service-visible reply error into the channel settle contract.
 * Terminal questionnaire states, including a missing session after the service
 * deletes its questionnaire record, consume a pending channel reply. Validation,
 * scope, transport, and unknown failures remain retryable.
 */
export function classifyQuestionnaireReplyError(err: unknown): QuestionnaireReplyOutcome {
  if (!(err instanceof LocalQuestionnaireError)) return { status: 'retryable' };
  if (TERMINAL_QUESTIONNAIRE_REPLY_CODES.has(err.code)) {
    return { status: 'terminal', code: err.code };
  }
  return { status: 'retryable', code: err.code };
}
