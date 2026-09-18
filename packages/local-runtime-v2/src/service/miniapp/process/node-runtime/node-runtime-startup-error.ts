import type { ChildProcess } from 'node:child_process';

import {
  attachMiniAppRuntimeErrorDetail,
  boundMiniAppRuntimeErrorText,
  MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES,
  readMiniAppRuntimeErrorDetail,
  type MiniAppRuntimeBusyReason,
} from '../../errors.js';
import { normalizeMiniAppRunnerFailureCode } from './host-runner.js';

export class MiniAppNodeRuntimeError extends Error {
  override readonly name = 'MiniAppNodeRuntimeError';
  declare readonly busyReason?: MiniAppRuntimeBusyReason;

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions & { readonly busyReason?: MiniAppRuntimeBusyReason },
  ) {
    super(message, options);
    if (code === 'BUSY' && options?.busyReason) this.busyReason = options.busyReason;
  }
}

interface StartupErrorCapture {
  complete(): void;
  attachFailure(authoritativeError: unknown, startupError: unknown): void;
}

export function captureStartupError(child: ChildProcess): StartupErrorCapture {
  const stderrCapture = createBoundedStderrTailCapture();
  const onStderr = (chunk: Buffer | string) => {
    stderrCapture.append(chunk);
  };
  child.stderr?.on('data', onStderr);
  const stop = () => {
    child.stderr?.removeListener('data', onStderr);
  };
  return {
    complete() {
      stop();
      stderrCapture.clear();
    },
    attachFailure(authoritativeError, startupError) {
      stop();
      const capturedStderr = stderrCapture.text();
      stderrCapture.clear();
      const directDetail = readMiniAppRuntimeErrorDetail(startupError);
      const stderr = boundMiniAppRuntimeErrorText(
        `${directDetail?.stderr ?? ''}${capturedStderr}`,
        'runtime stderr',
      );
      attachMiniAppRuntimeErrorDetail(authoritativeError, {
        errorText: boundMiniAppRuntimeErrorText(
          directDetail?.errorText ?? startupErrorText(startupError),
          'runtime error text',
        ),
        ...(stderr.length > 0 ? { stderr } : {}),
      });
    },
  };
}

export function isRunnerErrorMessage(value: unknown): value is {
  readonly type: 'miniapp:error';
  readonly code: string;
  readonly errorText: string;
} {
  return (
    isRecord(value) &&
    value.type === 'miniapp:error' &&
    typeof value.code === 'string' &&
    typeof value.errorText === 'string'
  );
}

export function runnerFailure(code: string, message: string, errorText: string): Error {
  const error = new MiniAppNodeRuntimeError(normalizeMiniAppRunnerFailureCode(code), message);
  attachMiniAppRuntimeErrorDetail(error, {
    errorText: boundMiniAppRuntimeErrorText(errorText, 'runner error text'),
  });
  return error;
}

export function attachStartupFailureDetail(source: unknown, target: unknown): void {
  const detail = readMiniAppRuntimeErrorDetail(source);
  attachMiniAppRuntimeErrorDetail(target, detail ?? { errorText: startupErrorText(source) });
}

function createBoundedStderrTailCapture(): {
  append(chunk: Buffer | string): void;
  clear(): void;
  text(): string;
} {
  let retained: Buffer | undefined;
  let retainedBytes = 0;
  let writeOffset = 0;
  let originalBytes = 0;
  return {
    append(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      originalBytes += bytes.byteLength;
      if (bytes.byteLength === 0) return;
      const tailBuffer = (retained ??= Buffer.allocUnsafe(MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES));
      if (bytes.byteLength >= MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES) {
        bytes.copy(tailBuffer, 0, bytes.byteLength - MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES);
        retainedBytes = MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES;
        writeOffset = 0;
        return;
      }
      const firstPartBytes = Math.min(bytes.byteLength, tailBuffer.byteLength - writeOffset);
      bytes.copy(tailBuffer, writeOffset, 0, firstPartBytes);
      if (firstPartBytes < bytes.byteLength) {
        bytes.copy(tailBuffer, 0, firstPartBytes);
      }
      writeOffset = (writeOffset + bytes.byteLength) % tailBuffer.byteLength;
      retainedBytes = Math.min(tailBuffer.byteLength, retainedBytes + bytes.byteLength);
    },
    clear() {
      retained = undefined;
      retainedBytes = 0;
      writeOffset = 0;
      originalBytes = 0;
    },
    text() {
      const tailBuffer = retained;
      if (originalBytes === 0 || !tailBuffer) return '';
      const ordered =
        retainedBytes < tailBuffer.byteLength || writeOffset === 0
          ? tailBuffer.subarray(0, retainedBytes)
          : Buffer.concat([tailBuffer.subarray(writeOffset), tailBuffer.subarray(0, writeOffset)]);
      if (originalBytes <= MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES) {
        return ordered.toString('utf8');
      }
      return formatTruncatedStderrTail(ordered, originalBytes);
    },
  };
}

function formatTruncatedStderrTail(retained: Buffer, originalBytes: number): string {
  const largestNotice = `[... stderr truncated from ${originalBytes} bytes; showing last ${MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES} bytes ...]\n`;
  const tailBudget =
    MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES - Buffer.byteLength(largestNotice, 'utf8');
  let start = Math.max(0, retained.byteLength - tailBudget);
  while (start < retained.byteLength && (retained.readUInt8(start) & 0xc0) === 0x80) start += 1;
  const tail = retained.subarray(start).toString('utf8');
  const tailBytes = Buffer.byteLength(tail, 'utf8');
  return `[... stderr truncated from ${originalBytes} bytes; showing last ${tailBytes} bytes ...]\n${tail}`;
}

function startupErrorText(error: unknown): string {
  let text: string;
  try {
    const candidate =
      error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : error;
    text = typeof candidate === 'string' ? candidate : String(candidate);
  } catch {
    text = 'Runtime startup error could not be converted to text';
  }
  return boundMiniAppRuntimeErrorText(text, 'runtime startup error text');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
