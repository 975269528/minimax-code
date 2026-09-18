import { randomBytes } from 'node:crypto';

import {
  ASK_OTHER_PLACEHOLDER,
  type AskQuestionImage,
  type AskQuestionOption,
  type AskQuestionStep,
  type AskQuestionnairePresentation,
  type AskQuestionnairePurpose,
  type AskQuestionnaireReplyAnswer,
  type AskQuestionnaireReplyPayload,
  type AskQuestionnaireRequest,
  type AskUserToolImageInput,
  type AskUserToolInput,
  type AskUserToolStepInput,
} from '@mavis/shared/questionnaire';

export class QuestionnaireNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionnaireNormalizationError';
  }
}

export class QuestionnaireValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionnaireValidationError';
  }
}

export interface NormalizeQuestionnaireOptions {
  requestId?: string;
  sessionId: string;
  agentName?: string;
  toolMessageId?: string;
  toolCallId?: string;
  runId?: string;
  createdAt?: number;
  purpose?: AskQuestionnairePurpose;
  goalId?: string;
  expiresAt?: number;
}

const DEFAULT_PRESENTATION: AskQuestionnairePresentation = Object.freeze({
  replaceComposer: true,
  showProgress: true,
  allowBackNavigation: true,
});

const FEATURE_ENABLE_PRESENTATION: AskQuestionnairePresentation = Object.freeze({
  replaceComposer: false,
  showProgress: false,
  allowBackNavigation: false,
});

export function generateQuestionnaireRequestId(): string {
  return `ask_${randomBytes(12).toString('hex')}`;
}

function generateStepId(index: number): string {
  return `q${index + 1}_${randomBytes(4).toString('hex')}`;
}

function generateOptionId(stepId: string, index: number): string {
  return `${stepId}_opt${index + 1}`;
}

export function isAllowedImageSrc(src: string): boolean {
  const trimmed = src.trim();
  if (trimmed === '') return false;
  if (trimmed.startsWith('https://')) return true;
  if (trimmed.startsWith('/mavis/api/')) return true;
  if (trimmed.startsWith('/minimax-desktop/api/')) return true;
  return false;
}

export function normalizeAskUserInput(
  input: AskUserToolInput,
  opts: NormalizeQuestionnaireOptions,
): AskQuestionnaireRequest {
  if (!input || typeof input !== 'object') {
    throw new QuestionnaireNormalizationError('ask_user input must be an object');
  }
  if (input.mode === 'feature-enable') {
    return normalizeFeatureEnableInput(input, opts);
  }
  if (input.mode !== undefined && input.mode !== 'questionnaire') {
    throw new QuestionnaireNormalizationError(`Unsupported ask_user mode: ${String(input.mode)}`);
  }
  if (input.modePayload !== undefined) {
    throw new QuestionnaireNormalizationError(
      'ask_user questionnaire input must not include a mode payload',
    );
  }
  if (!Array.isArray(input.steps)) {
    throw new QuestionnaireNormalizationError(
      'ask_user input must include a non-empty `steps` array',
    );
  }

  const includeRecommendations = opts.purpose === 'goal';
  const steps = input.steps
    .map((step, idx) => normalizeStep(step, idx, includeRecommendations))
    .filter((step): step is AskQuestionStep => step !== null);

  if (steps.length === 0) {
    throw new QuestionnaireNormalizationError(
      'ask_user input must include at least one step with non-empty question text',
    );
  }

  const seen = new Set<string>();
  for (const step of steps) {
    // Keep model-supplied IDs when unique; rename duplicates so reply
    // validation can use a simple step-id map with no ambiguity.
    if (seen.has(step.id)) {
      step.id = generateStepId(seen.size);
    }
    seen.add(step.id);
  }

  const requestId = opts.requestId ?? generateQuestionnaireRequestId();
  const createdAt = opts.createdAt ?? Date.now();
  const request: AskQuestionnaireRequest = {
    schemaVersion: 2,
    id: requestId,
    ...(input.mode === 'questionnaire' ? { mode: 'questionnaire' as const } : {}),
    presentation: { ...DEFAULT_PRESENTATION },
    steps,
    status: 'pending',
    createdAt,
    requester: {
      sessionId: opts.sessionId,
      ...(opts.agentName ? { agentName: opts.agentName } : {}),
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
    },
    ...(opts.purpose ? { purpose: opts.purpose } : {}),
    ...(opts.goalId ? { goalId: opts.goalId } : {}),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
  };

  const title = readNonEmptyString(input.title);
  if (title) request.title = title;
  if (opts.toolMessageId && opts.toolCallId) {
    request.tool = { message_id: opts.toolMessageId, call_id: opts.toolCallId };
  }
  return request;
}

function normalizeFeatureEnableInput(
  input: AskUserToolInput,
  opts: NormalizeQuestionnaireOptions,
): AskQuestionnaireRequest {
  const featureKey = readNonEmptyString(input.modePayload?.featureKey);
  if (!featureKey) {
    throw new QuestionnaireNormalizationError(
      'ask_user feature-enable input must include a non-empty `modePayload.featureKey`',
    );
  }
  if (input.steps !== undefined) {
    throw new QuestionnaireNormalizationError(
      'ask_user feature-enable input must not include questionnaire `steps`',
    );
  }

  const requestId = opts.requestId ?? generateQuestionnaireRequestId();
  const createdAt = opts.createdAt ?? Date.now();
  const request: AskQuestionnaireRequest = {
    schemaVersion: 2,
    id: requestId,
    mode: 'feature-enable',
    modePayload: { featureKey },
    presentation: { ...FEATURE_ENABLE_PRESENTATION },
    // Keep replies on the existing validator/service path. This synthetic
    // step is never rendered by the feature prompt.
    steps: [
      {
        id: 'feature-enable',
        question: `Enable ${featureKey}?`,
        selectionMode: 'single',
        options: [{ id: 'enable', label: 'Enable' }],
        allowOther: true,
        otherPlaceholder: ASK_OTHER_PLACEHOLDER,
        required: true,
      },
    ],
    status: 'pending',
    createdAt,
    requester: {
      sessionId: opts.sessionId,
      ...(opts.agentName ? { agentName: opts.agentName } : {}),
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
    },
  };
  const title = readNonEmptyString(input.title);
  if (title) request.title = title;
  if (opts.toolMessageId && opts.toolCallId) {
    request.tool = { message_id: opts.toolMessageId, call_id: opts.toolCallId };
  }
  return request;
}

export function validateQuestionnaireReply(
  request: AskQuestionnaireRequest,
  payload: AskQuestionnaireReplyPayload,
): void {
  if (payload.schemaVersion !== 2) {
    throw new QuestionnaireValidationError(
      `Unsupported schemaVersion: ${String(payload.schemaVersion)}. Expected 2.`,
    );
  }
  if (payload.requestId !== request.id) {
    throw new QuestionnaireValidationError(
      `Reply requestId mismatch: payload=${payload.requestId} request=${request.id}`,
    );
  }
  if (!Array.isArray(payload.answers)) {
    throw new QuestionnaireValidationError('answers must be an array');
  }

  const stepById = new Map(request.steps.map((step) => [step.id, step]));
  const answeredStepIds = new Set<string>();
  for (const answer of payload.answers) {
    if (!answer || typeof answer.stepId !== 'string') {
      throw new QuestionnaireValidationError('each answer must include a stepId string');
    }
    if (answeredStepIds.has(answer.stepId)) {
      throw new QuestionnaireValidationError(`duplicate answer for step ${answer.stepId}`);
    }
    answeredStepIds.add(answer.stepId);

    const step = stepById.get(answer.stepId);
    if (!step) {
      throw new QuestionnaireValidationError(`unknown stepId in reply: ${answer.stepId}`);
    }

    const skipped = answer.skipped === true;
    const selectedIds = Array.isArray(answer.selectedOptionIds) ? answer.selectedOptionIds : [];
    const selectedOther = answer.selectedOther === true;
    const otherText = typeof answer.otherText === 'string' ? answer.otherText : '';
    if (skipped) {
      if (selectedIds.length > 0 || selectedOther || otherText.trim() !== '') {
        throw new QuestionnaireValidationError(
          `step ${step.id}: skipped answer cannot carry selectedOptions / selectedOther / otherText`,
        );
      }
      continue;
    }

    const validIds = new Set(step.options.map((option) => option.id));
    for (const optionId of selectedIds) {
      if (!validIds.has(optionId)) {
        throw new QuestionnaireValidationError(`unknown optionId ${optionId} for step ${step.id}`);
      }
    }
    if (selectedOther && otherText.trim() === '') {
      throw new QuestionnaireValidationError(
        `step ${step.id}: selectedOther is true but otherText is empty`,
      );
    }
    if (!selectedOther && selectedIds.length === 0 && step.required) {
      throw new QuestionnaireValidationError(
        `step ${step.id} is required but has no selected option, no Others text, and is not skipped`,
      );
    }
    if (step.selectionMode === 'single' && selectedIds.length > 1) {
      throw new QuestionnaireValidationError(
        `step ${step.id} is single-choice but has ${selectedIds.length} selected options`,
      );
    }
    if (step.selectionMode === 'single' && selectedOther && selectedIds.length > 0) {
      throw new QuestionnaireValidationError(
        `step ${step.id} is single-choice: Others cannot be selected alongside a normal option`,
      );
    }
  }

  for (const step of request.steps) {
    if (step.required && !answeredStepIds.has(step.id)) {
      throw new QuestionnaireValidationError(`required step ${step.id} is missing from reply`);
    }
  }
}

export function sanitizeReplyAnswers(
  payload: AskQuestionnaireReplyPayload,
): AskQuestionnaireReplyAnswer[] {
  return payload.answers.map((answer) => {
    if (answer.skipped === true) {
      return { stepId: answer.stepId, selectedOptionIds: [], selectedOther: false, skipped: true };
    }
    const sanitized: AskQuestionnaireReplyAnswer = {
      stepId: answer.stepId,
      selectedOptionIds: Array.isArray(answer.selectedOptionIds)
        ? [...answer.selectedOptionIds]
        : [],
      selectedOther: answer.selectedOther === true,
    };
    if (sanitized.selectedOther && typeof answer.otherText === 'string') {
      sanitized.otherText = answer.otherText.trim();
    }
    return sanitized;
  });
}

function normalizeStep(
  raw: AskUserToolStepInput,
  index: number,
  includeRecommendations: boolean,
): AskQuestionStep | null {
  if (!raw || typeof raw.question !== 'string') return null;
  const question = raw.question.trim();
  if (!question) return null;
  const id =
    typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : generateStepId(index);
  const step: AskQuestionStep = {
    id,
    question,
    selectionMode: raw.selectionMode === 'multiple' ? 'multiple' : 'single',
    options: normalizeOptions(raw.options, id, includeRecommendations),
    allowOther: true,
    otherPlaceholder: ASK_OTHER_PLACEHOLDER,
    required: true,
  };
  const header = readNonEmptyString(raw.header);
  const description = readNonEmptyString(raw.description);
  const image = normalizeImage(raw.image);
  if (header) step.header = header;
  if (description) step.description = description;
  if (image) step.image = image;
  return step;
}

function normalizeOptions(
  raw: AskUserToolStepInput['options'],
  stepId: string,
  includeRecommendations: boolean,
): AskQuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AskQuestionOption[] = [];
  const seenIds = new Set<string>();
  let hasRecommendation = false;
  raw.forEach((option, index) => {
    if (!option || typeof option.label !== 'string') return;
    const label = option.label.trim();
    if (!label) return;
    let id = typeof option.id === 'string' ? option.id.trim() : '';
    if (!id || seenIds.has(id)) id = generateOptionId(stepId, index);
    seenIds.add(id);
    const normalized: AskQuestionOption = { id, label };
    const description = readNonEmptyString(option.description);
    const image = normalizeImage(option.image);
    if (description) normalized.description = description;
    if (image) normalized.image = image;
    if (includeRecommendations && !hasRecommendation && option.recommended === true) {
      normalized.recommended = true;
      hasRecommendation = true;
    }
    out.push(normalized);
  });
  if (includeRecommendations && out.length > 0 && !hasRecommendation) {
    out[0]!.recommended = true;
  }
  return out;
}

function normalizeImage(raw: AskUserToolImageInput | undefined): AskQuestionImage | undefined {
  if (!raw || typeof raw.src !== 'string') return undefined;
  if (!isAllowedImageSrc(raw.src)) return undefined;
  const image: AskQuestionImage = { src: raw.src.trim() };
  const alt = readNonEmptyString(raw.alt);
  const caption = readNonEmptyString(raw.caption);
  if (alt) image.alt = alt;
  if (caption) image.caption = caption;
  return image;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
