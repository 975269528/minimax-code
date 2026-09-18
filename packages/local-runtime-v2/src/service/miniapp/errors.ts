export type MiniAppErrorCode =
  | 'ACTIVATION_FAILED'
  | 'BUSY'
  | 'CANDIDATE_CHANGED'
  | 'CLEANUP_UNPROVEN'
  | 'CLOSED'
  | 'DISABLED'
  | 'INVALID_CANDIDATE'
  | 'NO_ACTIVE_GENERATION'
  | 'PERSISTENCE_COMPENSATION_FAILED'
  | 'PERSISTENCE_WRITE_FAILED'
  | 'QUARANTINED'
  | 'RETIRED_GENERATION'
  | 'RUNTIME_EXITED'
  | 'RUNTIME_START_FAILED'
  | 'SERVICE_RESTARTED'
  | 'SUPERSEDED';

type MiniAppFailureReasonCode =
  | 'CANDIDATE_CHANGED'
  | 'ENTRY_OUTSIDE_ARTIFACT'
  | 'HOST_CONNECTOR_PROTOCOL_VIOLATION'
  | 'HOST_CONNECTOR_UNAVAILABLE'
  | 'NO_CANDIDATE_PORT'
  | 'READINESS_TIMEOUT'
  | 'RUNNER_LIFECYCLE_INVALID'
  | 'RUNNER_START_FAILED'
  | 'START_EXPORT_MISSING'
  | 'TCP_CONNECT_TIMEOUT';

const MINIAPP_RUNTIME_FAILURE_REASON_CODES: ReadonlySet<string> = new Set<MiniAppFailureReasonCode>(
  [
    'ENTRY_OUTSIDE_ARTIFACT',
    'HOST_CONNECTOR_PROTOCOL_VIOLATION',
    'HOST_CONNECTOR_UNAVAILABLE',
    'NO_CANDIDATE_PORT',
    'READINESS_TIMEOUT',
    'RUNNER_LIFECYCLE_INVALID',
    'RUNNER_START_FAILED',
    'START_EXPORT_MISSING',
    'TCP_CONNECT_TIMEOUT',
  ],
);

export type MiniAppRuntimeBusyReason = 'operation_busy' | 'capacity_busy';

interface MiniAppErrorOptions extends ErrorOptions {
  readonly reasonCode?: MiniAppFailureReasonCode;
  readonly busyReason?: MiniAppRuntimeBusyReason;
  readonly runtimeError?: MiniAppRuntimeErrorDetail;
}

export interface MiniAppRuntimeErrorDetail {
  readonly errorText: string;
  readonly stderr?: string;
}

export const MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES = 64 * 1024;

const runtimeErrorDetails = new WeakMap<object, MiniAppRuntimeErrorDetail>();
const provenRootTerminationErrors = new WeakSet<object>();

/** Keeps both the exception summary and the deepest stack frames within one IPC field budget. */
export function boundMiniAppRuntimeErrorText(text: string, label?: string): string {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES) return text;

  const noticeLabel = boundedNoticeLabel(label);
  const notice = `\n[... ${noticeLabel} truncated from ${originalBytes} bytes ...]\n`;
  const contentBudget = MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES - Buffer.byteLength(notice, 'utf8');
  const headBudget = Math.ceil(contentBudget / 2);
  const tailBudget = contentBudget - headBudget;
  return `${utf8Prefix(text, headBudget)}${notice}${utf8Suffix(text, tailBudget)}`;
}

export class MiniAppError extends Error {
  override readonly name: string = 'MiniAppError';
  declare readonly reasonCode?: MiniAppFailureReasonCode;
  declare readonly busyReason?: MiniAppRuntimeBusyReason;
  declare readonly runtimeError?: MiniAppRuntimeErrorDetail;

  constructor(
    readonly code: MiniAppErrorCode,
    message: string,
    options?: MiniAppErrorOptions,
  ) {
    super(message, options);
    const reasonCode =
      options?.reasonCode ?? (code === 'CANDIDATE_CHANGED' ? 'CANDIDATE_CHANGED' : undefined);
    if (reasonCode) this.reasonCode = reasonCode;
    const busyReason = options?.busyReason ?? miniAppBusyReason(options?.cause);
    if (code === 'BUSY' && busyReason) this.busyReason = busyReason;
    if (options?.runtimeError) this.runtimeError = freezeRuntimeErrorDetail(options.runtimeError);
  }
}

export class MiniAppCleanupUnprovenError extends MiniAppError {
  override readonly name: string = 'MiniAppCleanupUnprovenError';

  constructor(message: string, options?: ErrorOptions) {
    super('CLEANUP_UNPROVEN', message, options);
  }
}

export function isMiniAppCleanupUnproven(error: unknown): error is MiniAppCleanupUnprovenError {
  return error instanceof MiniAppCleanupUnprovenError;
}

export function miniAppFailureReasonCode(error: unknown): string | undefined {
  return error instanceof MiniAppError ? error.reasonCode : undefined;
}

export function miniAppErrorCode(error: unknown): string {
  const code = readProperty(error, 'code');
  if (typeof code === 'string') return code;
  return 'RUNTIME_START_FAILED';
}

export function isMiniAppExpectedCancellation(code: string): boolean {
  return code === 'CLOSED' || code === 'DISABLED' || code === 'SUPERSEDED';
}

/** Attaches Host-owned diagnostics without trusting fields found on arbitrary error objects. */
export function attachMiniAppRuntimeErrorDetail(
  error: unknown,
  detail: MiniAppRuntimeErrorDetail,
): void {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return;
  runtimeErrorDetails.set(error, freezeRuntimeErrorDetail(detail));
}

/** Reads diagnostics attached directly to this exact error identity. */
export function readMiniAppRuntimeErrorDetail(
  error: unknown,
): MiniAppRuntimeErrorDetail | undefined {
  if (error instanceof MiniAppError && error.runtimeError) return error.runtimeError;
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
  return runtimeErrorDetails.get(error);
}

/** Records Host-owned proof without mutating or replacing the original post-stop error. */
export function markMiniAppRootTerminationProven(error: unknown): void {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return;
  provenRootTerminationErrors.add(error);
}

/** Reads proof attached directly to this exact post-stop error identity. */
export function isMiniAppRootTerminationProven(error: unknown): boolean {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return false;
  return provenRootTerminationErrors.has(error);
}

export function normalizeMiniAppRuntimeError(error: unknown, message: string): MiniAppError {
  if (error instanceof MiniAppError) return error;
  const code = miniAppErrorCode(error);
  const reasonCode = runtimeFailureReasonCode(error);
  const busyReason = miniAppBusyReason(error);
  const runtimeError = readMiniAppRuntimeErrorDetail(error);
  return new MiniAppError(code === 'BUSY' ? 'BUSY' : 'RUNTIME_START_FAILED', message, {
    cause: error,
    ...(reasonCode ? { reasonCode } : {}),
    ...(code === 'BUSY' && busyReason ? { busyReason } : {}),
    ...(runtimeError ? { runtimeError } : {}),
  });
}

/** Returns only explicit, bounded BUSY metadata; private messages and class names are ignored. */
export function miniAppBusyReason(error: unknown): MiniAppRuntimeBusyReason | undefined {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && isRecord(current) && !visited.has(current); depth += 1) {
    visited.add(current);
    const busyReason = readProperty(current, 'busyReason');
    if (busyReason === 'operation_busy' || busyReason === 'capacity_busy') {
      return busyReason;
    }
    current = readProperty(current, 'cause');
  }
  return undefined;
}

export function cancellationOrSupersededError(signal: AbortSignal, message: string): Error {
  return signal.reason instanceof Error ? signal.reason : new MiniAppError('SUPERSEDED', message);
}

export function assertMiniAppCleanupsProven(
  results: readonly PromiseSettledResult<unknown>[],
): void {
  const failure = results.find(
    (result): result is PromiseRejectedResult =>
      result.status === 'rejected' && isMiniAppCleanupUnproven(result.reason),
  );
  if (!failure) return;
  throw failure.reason;
}

function runtimeFailureReasonCode(error: unknown): MiniAppFailureReasonCode | undefined {
  const code = readProperty(error, 'code');
  return typeof code === 'string' && MINIAPP_RUNTIME_FAILURE_REASON_CODES.has(code)
    ? (code as MiniAppFailureReasonCode)
    : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

function readProperty(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function freezeRuntimeErrorDetail(detail: MiniAppRuntimeErrorDetail): MiniAppRuntimeErrorDetail {
  return Object.freeze({
    errorText: boundMiniAppRuntimeErrorText(detail.errorText, 'runtime error text'),
    ...(detail.stderr !== undefined
      ? { stderr: boundMiniAppRuntimeErrorText(detail.stderr, 'runtime stderr') }
      : {}),
  });
}

function boundedNoticeLabel(label: string | undefined): string {
  if (!label || label.length > 128) return 'runtime error text';
  const singleLine = label.replace(/[\r\n]+/gu, ' ').trim();
  return Buffer.byteLength(singleLine, 'utf8') <= 128 && singleLine.length > 0
    ? singleLine
    : 'runtime error text';
}

function utf8Prefix(value: string, maxBytes: number): string {
  let end = 0;
  let bytes = 0;
  while (end < value.length) {
    const codePoint = value.codePointAt(end)!;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    const nextBytes = utf8CodePointBytes(codePoint);
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    end += codeUnits;
  }
  return value.slice(0, end);
}

function utf8Suffix(value: string, maxBytes: number): string {
  let start = value.length;
  let bytes = 0;
  while (start > 0) {
    let nextStart = start - 1;
    const lastCodeUnit = value.charCodeAt(nextStart);
    if (
      lastCodeUnit >= 0xdc00 &&
      lastCodeUnit <= 0xdfff &&
      nextStart > 0 &&
      value.charCodeAt(nextStart - 1) >= 0xd800 &&
      value.charCodeAt(nextStart - 1) <= 0xdbff
    ) {
      nextStart -= 1;
    }
    const nextBytes = utf8CodePointBytes(value.codePointAt(nextStart)!);
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    start = nextStart;
  }
  return value.slice(start);
}

function utf8CodePointBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}
