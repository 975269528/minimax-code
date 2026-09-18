import { createHash } from 'node:crypto';

import type { LocalRuntimeLogger } from '../common/logger.js';
import { logger as defaultLogger } from '../common/logger.js';
import type { MetricsClient } from '../common/metrics.js';
import type { PreparedReview } from './preparation.js';

export type ReviewValidationStage = 'candidate' | 'document' | 'finding' | 'correction';
export type ReviewValidationOutcome = 'first_pass' | 'recovered' | 'partial' | 'failed';
type ReviewValidationCategory = 'format' | 'projection';

export interface ReviewValidationObservabilityOptions {
  metricsClient?: MetricsClient;
  logger?: Pick<LocalRuntimeLogger, 'warn' | 'error'>;
  model?: string;
}

interface ReviewValidationIdentity {
  sessionId: string;
  turnId: string;
  prepared: PreparedReview;
}

interface ReviewValidationFailureInput extends ReviewValidationIdentity {
  stage: ReviewValidationStage;
  error: unknown;
  candidateText: string;
  reasonCode?: string;
  details?: unknown;
  assistant?: ReviewAssistantEventContext;
}

export interface ReviewAssistantEventContext {
  stopReason: string;
  errorMessage?: string;
  responseId?: string;
  responseModel?: string;
  contentTypes: string[];
  diagnostics?: unknown;
  signalAborted: boolean;
}

interface RecordedFailure {
  fields: Record<string, unknown>;
}

export class ReviewValidationObserver {
  private readonly metricsClient: MetricsClient | undefined;
  private readonly validationLogger: Pick<LocalRuntimeLogger, 'warn' | 'error'>;
  private readonly model: string | undefined;
  private sawFailure = false;
  private sawFormatFailure = false;
  private resultRecorded = false;
  private lastFailure: RecordedFailure | undefined;

  constructor(options: ReviewValidationObservabilityOptions = {}) {
    this.metricsClient = options.metricsClient;
    this.validationLogger = options.logger ?? defaultLogger;
    this.model = options.model;
  }

  recordFailure(input: ReviewValidationFailureInput): void {
    const attempt = this.sawFailure ? 'retry' : 'initial';
    const message = errorMessage(input.error);
    const invalidEntityLocation =
      input.stage === 'document' ? findUnescapedXmlEntity(input.candidateText) : undefined;
    const reasonCode =
      input.reasonCode ??
      (invalidEntityLocation
        ? 'xml_invalid_entity'
        : classifyReviewValidationError(input.stage, message));
    const category = validationCategory(input.stage, reasonCode);
    const location = invalidEntityLocation ?? parseXmlErrorLocation(message);
    this.sawFailure = true;
    if (category === 'format') this.sawFormatFailure = true;
    const fields = {
      event: 'code_review_candidate_validation_failed',
      session_id: input.sessionId,
      turn_id: input.turnId,
      review_run_id: input.prepared.context.reviewRunId,
      trigger: input.prepared.trigger,
      mode: input.prepared.mode,
      attempt,
      stage: input.stage,
      category,
      reason_code: reasonCode,
      error: message,
      ...(location ?? {}),
      candidate_length: input.candidateText.length,
      candidate_sha256: createHash('sha256').update(input.candidateText).digest('hex'),
      // Review candidates are capped at 1 MB by the XML parser. Keep the full
      // rejected document in the local engineering log so field reports retain
      // enough evidence to reproduce model-format failures.
      candidate_xml: input.candidateText,
      ...(input.assistant ? assistantEventFields(input.assistant, attempt) : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(input.details !== undefined ? { details: input.details } : {}),
    };
    this.lastFailure = { fields };
    this.validationLogger.warn(fields, 'Code review candidate validation failed');
    this.metricsClient?.counter('code_review_candidate_validation_failure_total', 1, {
      attempt,
      category,
      mode: input.prepared.mode,
      reasonCode,
      stage: input.stage,
      trigger: input.prepared.trigger,
    });
  }

  recordIgnoredTerminalEmpty(
    input: ReviewValidationIdentity & {
      candidateText: string;
      assistant: ReviewAssistantEventContext;
    },
  ): void {
    const attempt = this.sawFailure ? 'retry' : 'initial';
    const fields = {
      event: 'code_review_assistant_empty_ignored',
      session_id: input.sessionId,
      turn_id: input.turnId,
      review_run_id: input.prepared.context.reviewRunId,
      trigger: input.prepared.trigger,
      mode: input.prepared.mode,
      attempt,
      reason_code: `assistant_empty_${input.assistant.stopReason}`,
      candidate_length: input.candidateText.length,
      candidate_sha256: createHash('sha256').update(input.candidateText).digest('hex'),
      candidate_xml: input.candidateText,
      ...assistantEventFields(input.assistant, attempt),
      ...(this.model ? { model: this.model } : {}),
    };
    this.validationLogger.warn(fields, 'Code review ignored an empty terminal assistant event');
  }

  recordResult(identity: ReviewValidationIdentity, outcome?: ReviewValidationOutcome): void {
    if (this.resultRecorded) return;
    this.resultRecorded = true;
    this.metricsClient?.counter('code_review_candidate_result_total', 1, {
      mode: identity.prepared.mode,
      formatStatus: this.sawFormatFailure ? 'invalid' : 'valid',
      outcome: outcome ?? (this.sawFailure ? 'recovered' : 'first_pass'),
      trigger: identity.prepared.trigger,
    });
  }

  recordExhausted(identity: ReviewValidationIdentity): void {
    this.recordResult(identity, 'failed');
    const fields = {
      ...(this.lastFailure?.fields ?? {
        session_id: identity.sessionId,
        turn_id: identity.turnId,
        review_run_id: identity.prepared.context.reviewRunId,
        trigger: identity.prepared.trigger,
        mode: identity.prepared.mode,
      }),
      event: 'code_review_candidate_validation_exhausted',
    };
    this.validationLogger.error(fields, 'Code review candidate validation exhausted');
  }
}

function assistantEventFields(
  assistant: ReviewAssistantEventContext,
  attempt: 'initial' | 'retry',
): Record<string, unknown> {
  return {
    assistant_stop_reason: assistant.stopReason,
    assistant_error_message: assistant.errorMessage,
    assistant_response_id: assistant.responseId,
    assistant_response_model: assistant.responseModel,
    assistant_content_types: assistant.contentTypes,
    assistant_diagnostics: assistant.diagnostics,
    candidate_retry_pending: attempt === 'retry',
    signal_aborted: assistant.signalAborted,
  };
}

function findUnescapedXmlEntity(text: string): { line: number; column: number } | undefined {
  const match = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/iu.exec(text);
  if (!match || match.index < 0) return undefined;
  const before = text.slice(0, match.index);
  const lines = before.split('\n');
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

function parseXmlErrorLocation(message: string): { line: number; column: number } | undefined {
  const match = /(?:^|\s)(\d+):(\d+):\s/u.exec(message);
  if (!match) return undefined;
  const line = Number(match[1]);
  const column = Number(match[2]);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column)) return undefined;
  return { line, column };
}

function validationCategory(
  stage: ReviewValidationStage,
  reasonCode: string,
): ReviewValidationCategory {
  if (stage === 'finding') {
    return reasonCode === 'finding_schema_invalid' ? 'format' : 'projection';
  }
  return reasonCode === 'correction_application_failed' ? 'projection' : 'format';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyReviewValidationError(
  stage: ReviewValidationStage,
  message: string,
): string {
  if (stage === 'candidate') return 'candidate_missing';
  if (/entity/iu.test(message)) return 'xml_invalid_entity';
  if (/too large/iu.test(message)) return 'document_too_large';
  if (/too many nodes/iu.test(message)) return 'document_node_limit';
  if (/deeply nested/iu.test(message)) return 'document_depth_limit';
  if (/doctype/iu.test(message)) return 'xml_doctype_not_allowed';
  if (/processing instruction/iu.test(message)) return 'xml_processing_instruction_not_allowed';
  if (/comment/iu.test(message) && /not allowed/iu.test(message)) return 'xml_comment_not_allowed';
  if (/exactly one root/iu.test(message)) return 'xml_multiple_roots';
  if (/outside review candidate xml root/iu.test(message)) return 'xml_outside_text';
  if (/not closed|unexpected close|unclosed|text data outside of root/iu.test(message)) {
    return 'xml_not_well_formed';
  }
  if (stage === 'finding') {
    if (/outside the local changes/iu.test(message)) return 'target_outside_changes';
    if (/does not overlap a deleted line/iu.test(message)) return 'old_target_not_deleted';
    if (/invalid finding schema/iu.test(message)) return 'finding_schema_invalid';
    return 'finding_validation_failed';
  }
  if (stage === 'correction') return 'correction_invalid';
  return 'document_schema_invalid';
}
