import { tuiErrorDiagnostic } from '../../user-facing-failure.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function toErrorMessage(error: unknown): string {
  return tuiErrorDiagnostic(error);
}

export function isRuntimeMethodNotImplemented(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return (
    error.status === 404 ||
    error.status === 501 ||
    error.statusCode === 404 ||
    error.statusCode === 501 ||
    error.code === 'NOT_IMPLEMENTED'
  );
}

export function isRuntimeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

export function delayWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timeout = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}
