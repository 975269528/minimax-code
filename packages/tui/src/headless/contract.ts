import { Ajv } from 'ajv';

import type { TuiTurnRunOutcome } from '../application/turn-run-outcome.js';

export type ExecResultStatus = 'succeeded' | 'failed' | 'timeout' | 'cancelled' | 'limit_exceeded';

export interface ExecError {
  readonly category: 'config' | 'runtime' | 'internal';
  readonly code?: string;
  readonly message: string;
  readonly retryable?: boolean;
}

export interface ExecModelIdentity {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly providerSource?: string;
  readonly providerKind?: string;
  readonly protocol?: string;
  readonly structuredOutputMode?: 'native_strict';
}

export interface ExecTokenUsage {
  /** Input plus output; cache buckets are separate and reasoning may overlap output. */
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export type ExecUsageSource = 'completed_responses' | 'analytics_fallback' | 'unavailable';

/** Stable public result emitted by mcode exec. */
export interface ExecResult {
  readonly schemaVersion: 1;
  readonly type: 'exec.result';
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly status: ExecResultStatus;
  readonly output?: unknown;
  readonly error?: ExecError;
  readonly model?: ExecModelIdentity;
  readonly usage?: ExecTokenUsage;
  readonly usageSource?: ExecUsageSource;
  readonly usageIncomplete?: boolean;
  readonly durationMs: number;
}

export type OutputValidation =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly kind: 'empty' | 'invalid_json' | 'schema_mismatch';
      readonly message: string;
    };

/** Validates without discarding the caller's original answer. */
export function validateExecOutput(
  answer: string | null | undefined,
  schema: Readonly<Record<string, unknown>> | undefined,
): OutputValidation {
  if (!schema) return { ok: true, value: answer ?? null };
  if (!answer?.trim()) {
    return { ok: false, kind: 'empty', message: 'Structured output was empty.' };
  }
  let value: unknown;
  try {
    value = JSON.parse(answer);
  } catch {
    return { ok: false, kind: 'invalid_json', message: 'Structured output was not valid JSON.' };
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    return {
      ok: false,
      kind: 'schema_mismatch',
      message: `Structured output did not match --output-schema: ${ajv.errorsText(validate.errors, { separator: '; ' })}`,
    };
  }
  return { ok: true, value };
}

export function createExecResult(
  outcome: TuiTurnRunOutcome,
  options: {
    readonly runId: string;
    readonly outputSchema?: Readonly<Record<string, unknown>>;
    readonly model?: ExecModelIdentity;
    readonly usage?: ExecTokenUsage;
    readonly usageSource?: ExecUsageSource;
    readonly usageIncomplete?: boolean;
    readonly validation?: OutputValidation;
  },
): ExecResult {
  const validation =
    outcome.status === 'succeeded'
      ? (options.validation ?? validateExecOutput(outcome.answer, options.outputSchema))
      : undefined;
  const normalized = normalizeOutcome(outcome, validation);
  return {
    schemaVersion: 1,
    type: 'exec.result',
    runId: options.runId,
    sessionId: normalized.sessionId,
    turnId: normalized.turnId,
    status: normalized.status === 'awaiting-user-continuation' ? 'failed' : normalized.status,
    ...(normalized.status === 'succeeded' && validation?.ok ? { output: validation.value } : {}),
    ...(normalized.error ? { error: { ...normalized.error } } : {}),
    ...(options.model ? { model: { ...options.model } } : {}),
    ...(options.usage ? { usage: { ...options.usage } } : {}),
    ...(options.usageSource !== undefined ? { usageSource: options.usageSource } : {}),
    ...(options.usageIncomplete !== undefined ? { usageIncomplete: options.usageIncomplete } : {}),
    durationMs: normalized.durationMs,
  };
}

export function isExecResult(value: unknown): value is ExecResult {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    value.type === 'exec.result' &&
    typeof value.runId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.turnId === 'string' &&
    typeof value.durationMs === 'number' &&
    Number.isFinite(value.durationMs) &&
    isExecStatus(value.status) &&
    isModel(value.model) &&
    isUsage(value.usage) &&
    (value.usageSource === undefined ||
      value.usageSource === 'completed_responses' ||
      value.usageSource === 'analytics_fallback' ||
      value.usageSource === 'unavailable') &&
    (value.usageIncomplete === undefined || typeof value.usageIncomplete === 'boolean') &&
    isError(value.error)
  );
}

function normalizeOutcome(
  outcome: TuiTurnRunOutcome,
  validation: OutputValidation | undefined,
): TuiTurnRunOutcome {
  if (outcome.status === 'awaiting-user-continuation') {
    return {
      ...outcome,
      status: 'failed',
      error: outcome.error ?? {
        category: 'runtime',
        code: 'INTERACTION_NOT_AVAILABLE',
        message: 'The Runtime requested interaction from a non-interactive Exec host.',
        retryable: false,
      },
    };
  }
  if (outcome.status !== 'succeeded' || !validation || validation.ok) return outcome;
  return {
    ...outcome,
    status: 'failed',
    error: {
      category: 'runtime',
      code: 'STRUCTURED_OUTPUT_INVALID',
      message: validation.message,
      retryable: true,
    },
  };
}

export function assertValidOutputSchema(schema: Readonly<Record<string, unknown>>): void {
  new Ajv({ allErrors: true, strict: false }).compile(schema);
}

function isExecStatus(value: unknown): value is ExecResultStatus {
  return (
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'timeout' ||
    value === 'cancelled' ||
    value === 'limit_exceeded'
  );
}

function isModel(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.providerId === 'string' &&
    typeof value.modelId === 'string' &&
    optionalString(value.variant) &&
    optionalString(value.providerSource) &&
    optionalString(value.providerKind) &&
    optionalString(value.protocol) &&
    (value.structuredOutputMode === undefined || value.structuredOutputMode === 'native_strict')
  );
}

function isUsage(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (field) => field === undefined || (typeof field === 'number' && Number.isFinite(field)),
  );
}

function isError(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    (value.category === 'config' ||
      value.category === 'runtime' ||
      value.category === 'internal') &&
    optionalString(value.code) &&
    typeof value.message === 'string' &&
    (value.retryable === undefined || typeof value.retryable === 'boolean')
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
