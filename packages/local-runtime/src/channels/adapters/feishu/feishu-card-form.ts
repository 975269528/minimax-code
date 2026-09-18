import type {
  AskQuestionnaireReplyAnswer,
  AskQuestionnaireReplyPayload,
  AskQuestionnaireRequest,
} from '@mavis/shared/questionnaire';

import { QUESTIONNAIRE_OTHER_SUFFIX, type QuestionnaireSubmitActionValue } from './feishu-card.js';

/**
 * Card 2.0 form-submit decoder helpers. Split out of `feishu-card.ts` so the
 * card-encoder file stays under the default 500-line budget. The wire-shape
 * mirrors `feat/im-genui-full-mr` (`im-slice-all`) — Feishu posts
 * `action.value` (submit-button payload) and `action.form_value` (the form
 * state, keyed by per-step name) — both of which we re-shape into a canonical
 * {@link AskQuestionnaireReplyPayload}.
 */

function toObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Extract the questionnaire-submit button value from a Feishu card-action
 * event. Searches the same candidate locations across v1/v2 card layouts; each
 * candidate may be an object OR a JSON string. Returns the value only when
 * `kind === 'questionnaire_submit'` and `requestId` is a non-empty string.
 */
export function extractQuestionnaireSubmitValue(
  rawEvent: unknown,
): QuestionnaireSubmitActionValue | null {
  const event = toObject(rawEvent);
  if (!event) return null;
  const eventBody = toObject(event.event);
  const actionObj = toObject(event.action) ?? toObject(eventBody?.action);

  const candidates: unknown[] = [
    actionObj?.value,
    event.action_value,
    event.value,
    eventBody?.action_value,
    eventBody?.value,
  ];

  for (const candidate of candidates) {
    let valueObj: Record<string, unknown> | null = null;
    if (typeof candidate === 'string') {
      try {
        valueObj = toObject(JSON.parse(candidate));
      } catch {
        valueObj = null;
      }
    } else {
      valueObj = toObject(candidate);
    }
    if (!valueObj) continue;
    if (
      valueObj.kind === 'questionnaire_submit' &&
      typeof valueObj.requestId === 'string' &&
      valueObj.requestId.length > 0
    ) {
      return {
        kind: 'questionnaire_submit',
        requestId: valueObj.requestId,
        sessionId: typeof valueObj.sessionId === 'string' ? valueObj.sessionId : '',
      };
    }
  }
  return null;
}

/**
 * Extract the form_value map (name → submitted value) from a Feishu form
 * submit card-action event. Feishu places it on `action.form_value` (v2) and
 * some SDK shapes flatten it to `form_value` at top level (or under `event`).
 */
export function extractFormValue(rawEvent: unknown): Record<string, unknown> {
  const event = toObject(rawEvent);
  if (!event) return {};
  const eventBody = toObject(event.event);
  const actionObj = toObject(event.action) ?? toObject(eventBody?.action);

  const candidates: unknown[] = [actionObj?.form_value, event.form_value, eventBody?.form_value];
  for (const candidate of candidates) {
    const obj = toObject(candidate);
    if (obj) return obj;
  }
  return {};
}

/** Coerce a select/multi_select form_value field into a string[] of option ids. */
export function normalizeSelected(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  return [];
}

/**
 * Map a Feishu form_value object to questionnaire reply answers. One answer
 * per step; an empty step (no selection, no free text) is marked `skipped`
 * so a required step left blank does not fail validation.
 */
export function mapFormValueToAnswers(
  request: AskQuestionnaireRequest,
  formValue: Record<string, unknown>,
): AskQuestionnaireReplyAnswer[] {
  const answers: AskQuestionnaireReplyAnswer[] = [];
  for (const step of request.steps) {
    const selectedOptionIds = normalizeSelected(formValue[step.id]);
    const otherRaw = formValue[`${step.id}${QUESTIONNAIRE_OTHER_SUFFIX}`];
    const otherText = typeof otherRaw === 'string' ? otherRaw.trim() : '';

    const answer: AskQuestionnaireReplyAnswer = {
      stepId: step.id,
      selectedOptionIds,
      selectedOther: otherText.length > 0,
    };
    if (otherText.length > 0) answer.otherText = otherText;
    if (selectedOptionIds.length === 0 && otherText.length === 0) {
      answer.skipped = true;
    }
    answers.push(answer);
  }
  return answers;
}

/**
 * Convenience end-to-end decode: turn a raw Feishu card-action submit event
 * into a structured reply payload, gated on the submit value's requestId
 * matching the supplied request. Returns null when the event is not this
 * request's questionnaire submit.
 */
export function buildReplyFromEvent(
  request: AskQuestionnaireRequest,
  rawEvent: unknown,
  nowMs: () => number = () => Date.now(),
): AskQuestionnaireReplyPayload | null {
  const submitValue = extractQuestionnaireSubmitValue(rawEvent);
  if (!submitValue || submitValue.requestId !== request.id) return null;
  return {
    schemaVersion: 2,
    requestId: request.id,
    answers: mapFormValueToAnswers(request, extractFormValue(rawEvent)),
    submittedAt: nowMs(),
  };
}
