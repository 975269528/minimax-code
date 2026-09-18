import type { TuiQuestionnaireReplyAnswer, TuiQuestionnaireRequest } from '../../runtime/port.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';

export interface QuestionnaireAnswerDraft {
  stepId: string;
  rawText: string;
  answer: TuiQuestionnaireReplyAnswer;
}

export interface ActiveTuiQuestionnaire {
  request: TuiQuestionnaireRequest;
  sessionId?: string;
  agentName?: string;
  answers: Map<string, QuestionnaireAnswerDraft>;
}

export interface ParsedQuestionAnswer {
  index: number;
  text: string;
}

export function parseQuestionAnswer(input: string): ParsedQuestionAnswer | undefined {
  const match = /^\/q([1-9]\d*)\b([\s\S]*)$/u.exec(input);
  if (!match) return undefined;
  return {
    index: Number(match[1]) - 1,
    text: (match[2] ?? '').trim(),
  };
}

export function createActiveQuestionnaire(
  request: TuiQuestionnaireRequest,
  sessionId?: string,
  agentName?: string,
): ActiveTuiQuestionnaire {
  return { request, sessionId, agentName, answers: new Map() };
}

export function recordQuestionnaireAnswer(
  state: ActiveTuiQuestionnaire,
  questionIndex: number,
  rawText: string,
): { ok: true; label: string } | { ok: false; message: string } {
  const step = state.request.steps[questionIndex];
  if (!step) {
    return { ok: false, message: `Unknown question: /q${questionIndex + 1}` };
  }
  const text = sanitizeTerminalText(rawText).trim();
  if (!text) {
    return { ok: false, message: `/q${questionIndex + 1} needs answer text.` };
  }
  const answer = answerTextToReply(step, text);
  if (!answer) {
    const question = `/q${questionIndex + 1}`;
    if ((step.options?.length ?? 0) === 0) {
      return { ok: false, message: `${question} does not accept free-text answers.` };
    }
    return {
      ok: false,
      message: isMultipleSelection(step.selectionMode)
        ? `${question} accepts only listed options. Use option numbers, IDs, or labels separated by commas.`
        : `${question} accepts only listed options. Use an option number, ID, or label.`,
    };
  }
  state.answers.set(step.id, {
    stepId: step.id,
    rawText: text,
    answer,
  });
  return { ok: true, label: `q${questionIndex + 1}` };
}

export function isQuestionnaireComplete(state: ActiveTuiQuestionnaire): boolean {
  return state.request.steps.every((step) => state.answers.has(step.id));
}

export function buildQuestionnaireReplyAnswers(
  state: ActiveTuiQuestionnaire,
  options: { skipUnanswered: boolean },
): TuiQuestionnaireReplyAnswer[] {
  const answers: TuiQuestionnaireReplyAnswer[] = [];
  for (const step of state.request.steps) {
    const draft = state.answers.get(step.id);
    if (draft) {
      answers.push(draft.answer);
    } else if (options.skipUnanswered) {
      answers.push({
        stepId: step.id,
        selectedOptionIds: [],
        selectedOther: false,
        skipped: true,
      });
    }
  }
  return answers;
}

export function formatQuestionnaireAnswerSummary(state: ActiveTuiQuestionnaire): string {
  const lines: string[] = [];
  for (const step of state.request.steps) {
    const draft = state.answers.get(step.id);
    if (!draft) continue;
    const label = sanitizeTerminalText(step.header ?? step.question).trim();
    const answers = (draft.answer.selectedOptionIds ?? [])
      .map((optionId) => step.options?.find((option) => option.id === optionId)?.label ?? optionId)
      .map((answer) => sanitizeTerminalText(answer).trim())
      .filter(Boolean);
    if (draft.answer.selectedOther && draft.answer.otherText) {
      answers.push(sanitizeTerminalText(draft.answer.otherText).trim());
    }
    lines.push(`${label}  ${answers.join(', ') || 'No answer'}`);
  }
  return lines.join('\n') || 'No answers sent.';
}

export function extractQuestionnaireResponseSummary(content: string): string | undefined {
  const sanitized = sanitizeTerminalText(content);
  const opening = /<questionnaire-response\b[^>]*>/u.exec(sanitized);
  if (!opening) return undefined;

  const openingEnd = opening.index + opening[0].length;
  const selfClosing = /\/>\s*$/u.test(opening[0]);
  const closing = selfClosing
    ? undefined
    : /<\/questionnaire-response>/u.exec(sanitized.slice(openingEnd));
  if (!selfClosing && !closing) return '';
  const suffixStart = selfClosing
    ? openingEnd
    : openingEnd + (closing?.index ?? 0) + (closing?.[0].length ?? 0);
  const lines = sanitized
    .slice(suffixStart)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const answers: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const question = /^Q:\s*(.+)$/u.exec(lines[index] ?? '')?.[1]?.trim();
    if (!question) continue;
    const answer = /^A:\s*(.*)$/u.exec(lines[index + 1] ?? '')?.[1]?.trim();
    if (answer === undefined) continue;
    answers.push(`${question}  ${answer || 'No answer'}`);
    index += 1;
  }
  return answers.join('\n');
}

export function extractQuestionnaireResponseRequestId(content: string): string | undefined {
  const sanitized = sanitizeTerminalText(content);
  const response = /<questionnaire-response\b[^>]*>([\s\S]*?)<\/questionnaire-response>/u.exec(
    sanitized,
  )?.[1];
  return response ? /<requestId>([^<]+)<\/requestId>/u.exec(response)?.[1]?.trim() : undefined;
}

function answerTextToReply(
  step: TuiQuestionnaireRequest['steps'][number],
  text: string,
): TuiQuestionnaireReplyAnswer | undefined {
  const selectedOptionIds = matchOptionIds(step, text);
  if (selectedOptionIds.length > 0) {
    return { stepId: step.id, selectedOptionIds, selectedOther: false };
  }
  if (step.allowOther !== true) return undefined;
  return {
    stepId: step.id,
    selectedOptionIds: [],
    selectedOther: true,
    otherText: text,
  };
}

function matchOptionIds(step: TuiQuestionnaireRequest['steps'][number], text: string): string[] {
  const options = step.options ?? [];
  if (options.length === 0) return [];
  const tokens = isMultipleSelection(step.selectionMode)
    ? text
        .split(/[,\uFF0C\u3001]/u)
        .map((token) => token.trim())
        .filter(Boolean)
    : [text.trim()];
  const ids: string[] = [];
  for (const token of tokens) {
    const optionId = matchOption(options, token);
    if (!optionId) return [];
    if (!ids.includes(optionId)) ids.push(optionId);
  }
  return ids;
}

function matchOption(
  options: NonNullable<TuiQuestionnaireRequest['steps'][number]['options']>,
  token: string,
): string | undefined {
  const index = Number(token);
  if (Number.isInteger(index) && index >= 1 && index <= options.length) {
    return options[index - 1]?.id;
  }
  const normalized = token.toLocaleLowerCase();
  return options.find(
    (option) =>
      option.id.toLocaleLowerCase() === normalized ||
      option.label.trim().toLocaleLowerCase() === normalized,
  )?.id;
}

function isMultipleSelection(selectionMode: unknown): boolean {
  return selectionMode === 1 || selectionMode === 'multiple';
}
