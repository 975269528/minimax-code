import { isRecord } from '../support.js';

export type TuiQuestionnaireReplyOutcome =
  | { status: 'terminal'; code: string; detail: string }
  | { status: 'retryable'; code?: string };

const TERMINAL_REPLY_DETAILS = new Map<string, string>([
  ['QUESTIONNAIRE_NOT_FOUND', 'Question is no longer available.'],
  ['QUESTIONNAIRE_ALREADY_ANSWERED', 'Answered on another surface.'],
  ['QUESTIONNAIRE_NOT_PENDING', 'Question is no longer pending.'],
  ['SESSION_NOT_FOUND', 'Session is no longer available.'],
]);

export function classifyQuestionnaireReplyError(error: unknown): TuiQuestionnaireReplyOutcome {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
  const detail = code ? TERMINAL_REPLY_DETAILS.get(code) : undefined;
  if (code && detail) return { status: 'terminal', code, detail };
  return { status: 'retryable', ...(code ? { code } : {}) };
}
