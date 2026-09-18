import { executionAsyncId, executionAsyncResource, triggerAsyncId } from 'node:async_hooks';
import type {
  TuiAsyncResourceObservation,
  TuiAsyncResourceTargetObservation,
  TuiProcessErrorObservation,
  TuiProcessStopObservation,
  TuiWritableStreamObservation,
} from '../../observability/index.js';
import { redactTuiSensitiveText } from '../../user-facing-failure.js';
import type { TuiProcessStopCause } from './process-stop-cause.js';

const MAX_ERROR_MESSAGE_LENGTH = 1_024;
const MAX_ERROR_STACK_LENGTH = 8_192;

export interface CreateTuiProcessStopObservationOptions {
  readonly homeDirectory: string;
  readonly workspaceDir: string;
  readonly asyncContext?: {
    readonly executionAsyncId: number;
    readonly triggerAsyncId: number;
    readonly resource: unknown;
  };
}

export function createTuiProcessStopObservation(
  cause: TuiProcessStopCause,
  options: CreateTuiProcessStopObservationOptions,
): TuiProcessStopObservation {
  const asyncContext = options.asyncContext ?? {
    executionAsyncId: executionAsyncId(),
    triggerAsyncId: triggerAsyncId(),
    resource: executionAsyncResource(),
  };
  return {
    source: cause.source,
    terminalDead: cause.terminalDead,
    ...(cause.signal ? { signal: cause.signal } : {}),
    ...(cause.bytes === undefined ? {} : { bytes: cause.bytes }),
    ...(cause.error === undefined ? {} : { error: observeError(cause.error, options) }),
    runtime: {
      nodeVersion: process.version,
      ...(process.versions.uv ? { uvVersion: process.versions.uv } : {}),
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
    },
    asyncResource: observeAsyncResource(asyncContext),
    stdout: observeWritableStream(process.stdout),
    stderr: observeWritableStream(process.stderr),
  };
}

function observeAsyncResource(context: {
  readonly executionAsyncId: number;
  readonly triggerAsyncId: number;
  readonly resource: unknown;
}): TuiAsyncResourceObservation {
  const owner = readFirstProperty(context.resource, ['owner', '_owner']);
  const stream = readFirstProperty(context.resource, ['stream', '_stream']);
  const handle = readFirstProperty(context.resource, ['handle', '_handle']);
  return {
    executionAsyncId: context.executionAsyncId,
    triggerAsyncId: context.triggerAsyncId,
    resource: observeAsyncResourceTarget(context.resource),
    ...(owner === undefined ? {} : { owner: observeAsyncResourceTarget(owner) }),
    ...(stream === undefined ? {} : { stream: observeAsyncResourceTarget(stream) }),
    ...(handle === undefined ? {} : { handle: observeAsyncResourceTarget(handle) }),
  };
}

function observeAsyncResourceTarget(value: unknown): TuiAsyncResourceTargetObservation {
  return {
    constructorName: readConstructorName(value).slice(0, 128),
    identity: value === process.stdout ? 'stdout' : value === process.stderr ? 'stderr' : 'other',
    fd: observeFd(value),
    ...observeErrorListenerCount(value),
  };
}

function observeFd(value: unknown): 1 | 2 | 'other' {
  const fd = readProperty(value, 'fd');
  return fd === 1 || fd === 2 ? fd : 'other';
}

function observeErrorListenerCount(value: unknown): Record<string, number> {
  const listenerCount = readProperty(value, 'listenerCount');
  if (typeof listenerCount !== 'function') return {};
  try {
    const count = listenerCount.call(value, 'error');
    return typeof count === 'number' && Number.isFinite(count)
      ? { errorListenerCount: Math.max(0, Math.floor(count)) }
      : {};
  } catch {
    return {};
  }
}

function readFirstProperty(value: unknown, keys: readonly string[]): unknown {
  for (const key of keys) {
    const property = readProperty(value, key);
    if (property !== undefined) return property;
  }
  return undefined;
}

function observeError(
  error: unknown,
  options: CreateTuiProcessStopObservationOptions,
): TuiProcessErrorObservation {
  const name =
    readStringProperty(error, 'name') ?? (error instanceof Error ? error.name : undefined);
  const message =
    readStringProperty(error, 'message') ??
    (typeof error === 'string' || typeof error === 'number' || typeof error === 'boolean'
      ? String(error)
      : undefined);
  const stack = readStringProperty(error, 'stack');
  const code = readScalarProperty(error, 'code');
  const errno = readScalarProperty(error, 'errno');
  const syscall = readStringProperty(error, 'syscall');
  return {
    ...(name ? { name: sanitizeDiagnosticText(name, options, 256) } : {}),
    ...(message
      ? { message: sanitizeDiagnosticText(message, options, MAX_ERROR_MESSAGE_LENGTH) }
      : {}),
    ...(code === undefined ? {} : { code: sanitizeScalar(code, options) }),
    ...(errno === undefined ? {} : { errno: sanitizeScalar(errno, options) }),
    ...(syscall ? { syscall: sanitizeDiagnosticText(syscall, options, 256) } : {}),
    ...(stack ? { stack: sanitizeDiagnosticText(stack, options, MAX_ERROR_STACK_LENGTH) } : {}),
  };
}

function sanitizeScalar(
  value: string | number,
  options: CreateTuiProcessStopObservationOptions,
): string | number {
  return typeof value === 'number' ? value : sanitizeDiagnosticText(value, options, 256);
}

function observeWritableStream(stream: unknown): TuiWritableStreamObservation {
  return {
    constructorName: readConstructorName(stream),
    ...readOptionalBoolean(stream, 'isTTY'),
    ...readOptionalBoolean(stream, 'writable'),
    ...readOptionalBoolean(stream, 'destroyed'),
    ...readOptionalBoolean(stream, 'writableEnded'),
    ...readOptionalBoolean(stream, 'writableFinished'),
    ...readOptionalBoolean(stream, 'writableNeedDrain'),
  };
}

function readConstructorName(value: unknown): string {
  try {
    if (typeof value !== 'object' || value === null) return typeof value;
    const name = value.constructor?.name;
    return typeof name === 'string' && name ? name : 'unknown';
  } catch {
    return 'unknown';
  }
}

function readOptionalBoolean(value: unknown, key: string): Record<string, boolean> {
  const property = readProperty(value, key);
  return typeof property === 'boolean' ? { [key]: property } : {};
}

function readStringProperty(value: unknown, key: string): string | undefined {
  const property = readProperty(value, key);
  return typeof property === 'string' ? property : undefined;
}

function readScalarProperty(value: unknown, key: string): string | number | undefined {
  const property = readProperty(value, key);
  return typeof property === 'string' || typeof property === 'number' ? property : undefined;
}

function readProperty(value: unknown, key: string): unknown {
  try {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
      return undefined;
    }
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function sanitizeDiagnosticText(
  value: string,
  options: CreateTuiProcessStopObservationOptions,
  maxLength: number,
): string {
  let sanitized = redactTuiSensitiveText(value);
  const replacements = [
    { path: options.workspaceDir, label: '[workspace]' },
    { path: options.homeDirectory, label: '[home]' },
  ].sort((left, right) => right.path.length - left.path.length);
  for (const replacement of replacements) {
    for (const variant of pathVariants(replacement.path)) {
      sanitized = sanitized.split(variant).join(replacement.label);
    }
  }
  return sanitized.slice(0, maxLength);
}

function pathVariants(path: string): readonly string[] {
  const variants = new Set([path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')]);
  variants.delete('');
  return [...variants];
}
