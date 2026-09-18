const RETRYABLE_WINDOWS_FILE_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const DEFAULT_RETRIES = 4;
const DEFAULT_RETRY_DELAY_MS = 50;

export interface WindowsFileSystemRetryOptions {
  platform?: NodeJS.Platform;
  retries?: number;
  retryDelayMs?: number;
  wait?(delayMs: number): void;
}

export function retryWindowsFileSystemOperation<T>(
  operation: () => T,
  options: WindowsFileSystemRetryOptions = {},
): T {
  const platform = options.platform ?? process.platform;
  const retries = Math.max(0, Math.floor(options.retries ?? DEFAULT_RETRIES));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
  const wait = options.wait ?? waitSynchronously;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (platform !== 'win32' || attempt >= retries || !isRetryableWindowsFileError(error)) {
        throw error;
      }
      wait(retryDelayMs * (attempt + 1));
    }
  }
}

function isRetryableWindowsFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    RETRYABLE_WINDOWS_FILE_CODES.has(error.code)
  );
}

function waitSynchronously(delayMs: number): void {
  if (delayMs <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}
