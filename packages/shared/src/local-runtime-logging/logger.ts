import type { Logger as PinoLogger } from 'pino';

import {
  createDiskLogTransport,
  createStructuredLogger,
  wrapTraceContextLogger,
  type DiskLogTransport,
  type DiskLogTransportOptions,
  type StructuredLoggerOptions,
  type TraceContextLike,
} from '../logging/index.js';

/**
 * local-runtime logger facade.
 *
 * Per `.harness/docs/local-runtime-observability.md` — local-runtime business
 * code MUST import logger APIs from this module, never call `console.*` and
 * never reach into `@mavis/shared/logging` directly. This keeps the field
 * shape stable, sources go through the trace-context wrapper, and the host
 * can later swap the underlying transport without touching call sites.
 *
 * Allowed APIs: the six methods on `logger` — `info`, `warn`, `error`,
 * `ctxInfo`, `ctxWarn`, `ctxError`.
 *
 * Diagnostic events (privacy-tagged JSONL, redaction metadata, diagnostic
 * bundles) intentionally stay in `packages/local-runtime/src/observability/`
 * — that module is the diagnostic event sink, not the engineering logger.
 *
 * Persistent-disk fan-out (hourly-rotating file, retention cutoff, total-bytes
 * cap) is opt-in: the host wiring calls {@link configureLocalRuntimeLogging}
 * during boot with a real `dir`, which swaps the module-level base logger for
 * one whose pretty output is teed into
 * `<dataDir>/v2/observability/logs/runtime-<YYYYMMDDHH>[.N].log`. Feedback and
 * local diagnostic bundles scan that prefix, so once disk fan-out is on,
 * every module that uses this facade shows up in user-triggered diagnostics
 * automatically.
 */

export type LogFields = Record<string, unknown>;

/**
 * Options for {@link configureLocalRuntimeLogging}. The disk-transport knobs
 * mirror {@link DiskLogTransportOptions} but with `dir` promoted to a
 * top-level required field so callers cannot accidentally initialise the disk
 * transport without a target directory.
 */
export interface ConfigureLocalRuntimeLoggingOptions extends Omit<DiskLogTransportOptions, 'dir'> {
  /**
   * Absolute path of the log directory. When omitted, disk fan-out is
   * disabled and the base logger writes to stdout only (existing behaviour
   * before this facade grew a disk arm).
   */
  dir?: string;
  /** Overrides for the pino logger factory. Rarely used outside tests. */
  loggerOptions?: Omit<StructuredLoggerOptions, 'disk'>;
}

let activeDisk: DiskLogTransport | null = null;
let baseLogger: PinoLogger = wrapTraceContextLogger(createStructuredLogger());

/**
 * Install (or re-install) the local-runtime engineering logger. Called by
 * the host wiring during boot. Safe to call more than once — the previous
 * disk transport (if any) is detached synchronously and its final flush
 * runs in the background so the caller is not held on cold-start latency.
 *
 * When `opts.dir` is omitted the disk arm is disabled and the base logger
 * falls back to stdout-only. That path is intended for tests / CLI utilities
 * that don't own a `dataDir` yet.
 */
export function configureLocalRuntimeLogging(opts: ConfigureLocalRuntimeLoggingOptions = {}): void {
  const previous = activeDisk;
  activeDisk = null;

  if (opts.dir) {
    const {
      dir,
      prefix,
      maxBytesPerFile,
      maxTotalBytes,
      retentionMs,
      now,
      onError,
      loggerOptions,
    } = opts;
    const diskOpts: DiskLogTransportOptions = { dir };
    if (prefix !== undefined) diskOpts.prefix = prefix;
    if (maxBytesPerFile !== undefined) diskOpts.maxBytesPerFile = maxBytesPerFile;
    if (maxTotalBytes !== undefined) diskOpts.maxTotalBytes = maxTotalBytes;
    if (retentionMs !== undefined) diskOpts.retentionMs = retentionMs;
    if (now !== undefined) diskOpts.now = now;
    if (onError !== undefined) diskOpts.onError = onError;
    const disk = createDiskLogTransport(diskOpts);
    activeDisk = disk;
    baseLogger = wrapTraceContextLogger(createStructuredLogger({ ...loggerOptions, disk }));
  } else {
    baseLogger = wrapTraceContextLogger(createStructuredLogger(opts.loggerOptions ?? {}));
  }

  if (previous) {
    // Fire-and-forget: the previous transport keeps draining its own write
    // chain in the background. Any close errors already routed through the
    // transport's `onError` sink; we just prevent an unhandled rejection.
    void previous.close().catch(() => {});
  }
}

/**
 * Flush pending disk writes without tearing down the base logger. Callers
 * (feedback upload path, forced diagnostics dump) invoke this before reading
 * the log directory to make sure the tail of the file is on disk.
 */
export async function flushLocalRuntimeLogging(): Promise<void> {
  if (!activeDisk) return;
  await activeDisk.flush();
}

/**
 * Close the disk transport (flush + retention sweep + stop accepting new
 * writes). Called during Electron `will-quit` / CLI graceful shutdown so the
 * final rotation sweep runs before the process exits.
 *
 * After shutdown the module-level logger keeps working (stdout only) — a
 * subsequent {@link configureLocalRuntimeLogging} call re-installs it.
 */
export async function shutdownLocalRuntimeLogging(): Promise<void> {
  if (!activeDisk) return;
  const old = activeDisk;
  activeDisk = null;
  try {
    await old.close();
  } catch {
    // Already surfaced via onError.
  }
  baseLogger = wrapTraceContextLogger(createStructuredLogger());
}

/**
 * The complete facade surface: plain leveled logging plus the ctx* variants
 * that carry a trace context. The ctx* methods put the context into the
 * standard `{ ctx: { traceId } }` field slot the trace-context wrapper
 * renders (never hand-write a `traceId` field — see the observability doc).
 * One object on purpose: consumers that receive dependencies instead of
 * importing this module (e.g. the local-runtime-v2 HTTP pipeline) inject
 * `logger` as-is, so their tests can assert log behavior with capturing
 * fakes instead of module mocking.
 */
export interface LocalRuntimeLogger {
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
  ctxInfo(ctx: TraceContextLike, fields: LogFields, message: string): void;
  ctxWarn(ctx: TraceContextLike, fields: LogFields, message: string): void;
  ctxError(ctx: TraceContextLike, fields: LogFields, message: string): void;
}

export const logger: LocalRuntimeLogger = {
  info(fields: LogFields, message: string): void {
    baseLogger.info(fields, message);
  },
  warn(fields: LogFields, message: string): void {
    baseLogger.warn(fields, message);
  },
  error(fields: LogFields, message: string): void {
    baseLogger.error(fields, message);
  },
  ctxInfo(ctx: TraceContextLike, fields: LogFields, message: string): void {
    baseLogger.info({ ctx, ...fields }, message);
  },
  ctxWarn(ctx: TraceContextLike, fields: LogFields, message: string): void {
    baseLogger.warn({ ctx, ...fields }, message);
  },
  ctxError(ctx: TraceContextLike, fields: LogFields, message: string): void {
    baseLogger.error({ ctx, ...fields }, message);
  },
};

export type { TraceContextLike, StructuredLoggerOptions, DiskLogTransport };

/**
 * Test-only helper: returns the underlying pino logger so spec files can
 * assert structured calls without rebuilding the facade. Not part of the
 * package's runtime API and not re-exported from `index.ts`.
 *
 * @internal
 */
export function __getBaseLoggerForTests(): PinoLogger {
  return baseLogger;
}

/**
 * Test-only helper: returns the active disk transport so spec files can
 * inspect rotation state / flush during assertions.
 *
 * @internal
 */
export function __getActiveDiskTransportForTests(): DiskLogTransport | null {
  return activeDisk;
}
