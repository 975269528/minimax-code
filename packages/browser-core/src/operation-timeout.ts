/**
 * Embedded Browser operation deadlines.
 *
 * The inner deadline must always settle before its caller's outer deadline:
 * CDP scan (30s) -> tab operation (60s default) -> renderer IPC (275s).
 * A hidden long-running action can legally wait for a render slot for 125s and
 * then execute for another 125s, so the outer IPC budget leaves a 25s cleanup
 * buffer above both bounded phases.
 */
export const BROWSER_TIMEOUTS = {
  cdpCommand: 30_000,
  cdpScan: 30_000,
  tabOperation: 60_000,
  longTabOperation: 125_000,
  ipcHandler: 275_000,
} as const;

export type BrowserOperationInterruptionCode =
  | 'ABORTED'
  | 'BROWSER_OPERATION_TIMEOUT'
  | 'BROWSER_TRANSPORT_CLOSED';

export type BrowserTransportInterruptionError = Error & {
  readonly code: BrowserOperationInterruptionCode;
};

/** Create the structured command interruption contract shared by every Browser transport. */
export function browserTransportInterruptionError(
  code: BrowserOperationInterruptionCode,
  message: string,
): BrowserTransportInterruptionError {
  return Object.assign(new Error(message), { code });
}

export class OperationTimeoutError extends Error {
  readonly code = 'BROWSER_OPERATION_TIMEOUT';

  constructor(
    public readonly label: string,
    public readonly timeoutMs: number,
  ) {
    super(`BROWSER_OPERATION_TIMEOUT: Operation "${label}" exceeded ${timeoutMs}ms`);
    this.name = 'OperationTimeoutError';
  }
}

export class OperationAbortedError extends Error {
  readonly code = 'ABORTED';

  constructor(reason?: unknown) {
    super('Operation aborted');
    this.name = 'AbortError';
    if (reason !== undefined) {
      (this as Error & { cause?: unknown }).cause = reason;
    }
  }
}

type TimeoutOperation<T> = Promise<T> | ((signal: AbortSignal) => Promise<T> | T);

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new OperationAbortedError(signal.reason);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /^([A-Z][A-Z0-9_]+):/u.exec(message)?.[1];
}

export function browserOperationInterruptionCode(
  error: unknown,
): BrowserOperationInterruptionCode | undefined {
  const code = errorCode(error);
  if (code === 'ABORTED') return 'ABORTED';
  if (code === 'BROWSER_TRANSPORT_CLOSED') return 'BROWSER_TRANSPORT_CLOSED';
  if (
    code === 'ACTION_TIMEOUT' ||
    code === 'BROWSER_OPERATION_TIMEOUT' ||
    code === 'BACKGROUND_RENDER_OPERATION_TIMEOUT' ||
    code === 'BACKGROUND_RENDER_QUEUE_TIMEOUT'
  ) {
    return 'BROWSER_OPERATION_TIMEOUT';
  }
  return undefined;
}

export function isBrowserOperationInterruption(error: unknown): boolean {
  return browserOperationInterruptionCode(error) !== undefined;
}

export function browserOperationFailure(error: unknown):
  | {
      success: false;
      code: BrowserOperationInterruptionCode;
      error: string;
      label?: string;
      timeoutMs?: number;
    }
  | undefined {
  const code = browserOperationInterruptionCode(error);
  if (!code) return undefined;
  const source = error && typeof error === 'object' ? error : {};
  const label = 'label' in source && typeof source.label === 'string' ? source.label : undefined;
  const timeoutMs =
    'timeoutMs' in source &&
    typeof source.timeoutMs === 'number' &&
    Number.isFinite(source.timeoutMs)
      ? source.timeoutMs
      : undefined;
  return {
    success: false,
    code,
    error: error instanceof Error ? error.message : String(error),
    ...(label ? { label } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs an operation with a derived AbortSignal and a deterministic deadline.
 *
 * A timeout rejects the caller and aborts the derived signal so transports
 * such as the Utility Browser broker can release their pending request. The
 * external abort listener and timer are always removed when the race settles.
 */
export async function withTimeout<T>(
  operation: TimeoutOperation<T>,
  timeoutMs: number,
  label: string,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`Invalid timeout for "${label}": ${timeoutMs}`);
  }

  const controller = new AbortController();
  const externalSignal = options.signal;
  let rejectExternalAbort: ((error: OperationAbortedError) => void) | undefined;
  const externalAbortPromise = new Promise<never>((_resolve, reject) => {
    rejectExternalAbort = reject;
  });
  const onExternalAbort = () => {
    const error = new OperationAbortedError(externalSignal?.reason);
    rejectExternalAbort?.(error);
    controller.abort(error);
  };

  if (externalSignal?.aborted) {
    onExternalAbort();
    return externalAbortPromise;
  }
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new OperationTimeoutError(label, timeoutMs);
      // Reject the deadline first so a synchronous transport abort cannot
      // replace the structured timeout with a generic abort error.
      reject(error);
      controller.abort(error);
    }, timeoutMs);
    timer.unref?.();
  });
  const operationPromise = Promise.resolve().then(() =>
    typeof operation === 'function' ? operation(controller.signal) : operation,
  );

  try {
    return await Promise.race([operationPromise, timeoutPromise, externalAbortPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}
