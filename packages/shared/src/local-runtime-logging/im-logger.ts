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

import type { LocalRuntimeLogger, LogFields } from './logger.js';

/**
 * IM-subsystem logger facade.
 *
 * Mirror of `common/logger.ts` but with a physically independent pino
 * instance and disk transport so the AC audit line + all IM channel/adapter
 * chatter lands in `<dataDir>/v2/observability/logs/im-runtime-<YYYYMMDDHH>[.N].log`
 * — separate from the main `runtime-*.log` so operators can grep it, retain
 * it, and rotate it independently.
 *
 * Allowed APIs: `info`, `warn`, `error`, plus the `ctxInfo`/`ctxWarn`/`ctxError`
 * exports (re-exported through `common/index.ts` as `imCtxInfo` / `imCtxWarn`
 * / `imCtxError`). Business code (IM channels, adapters, permission-bridge,
 * host-channels wiring) imports `imLogger` from this module aliased as
 * `logger`; the AC store consumes it through the `bindAccessControlAuditLogger`
 * adapter in `channels/access-control-store.ts`.
 *
 * Persistent-disk fan-out is opt-in via {@link configureImLogger} — the host
 * wiring (Electron main, CLI `tui.ts`) calls it during boot with a `dir`,
 * which swaps the module-level base logger for one whose pretty output is
 * teed into the `im-runtime-` file family. Electron's feedback upload path
 * scans that prefix (see `apps/electron/main/utils/extra-log-source.ts`), so
 * user diagnostic bundles automatically include IM audit history.
 */

let activeDisk: DiskLogTransport | null = null;
let baseLogger: PinoLogger = wrapTraceContextLogger(createStructuredLogger());

/**
 * Options for {@link configureImLogger}. Shape mirrors
 * `ConfigureLocalRuntimeLoggingOptions` — the on-disk `prefix` is hard-coded
 * to `im-runtime` so callers cannot accidentally point IM logs at the main
 * `runtime-*.log` file family (that would defeat the whole point of the
 * split).
 */
export interface ConfigureImLoggerOptions extends Omit<DiskLogTransportOptions, 'dir' | 'prefix'> {
  /**
   * Absolute path of the log directory. Same shape as
   * `configureLocalRuntimeLogging` so the host can point both loggers at
   * the same v2 logs dir; only the on-disk prefix distinguishes IM
   * (`im-runtime-`) from main runtime (`runtime-`). When omitted, disk
   * fan-out is disabled and imLogger writes to stdout only.
   */
  dir?: string;
  /** Overrides for the pino logger factory. Rarely used outside tests. */
  loggerOptions?: Omit<StructuredLoggerOptions, 'disk'>;
}

/**
 * Install (or re-install) the IM-subsystem engineering logger. Idempotent:
 * the previous disk transport (if any) is detached synchronously and its
 * final flush runs in the background.
 *
 * When `opts.dir` is omitted the disk arm is disabled and the base logger
 * falls back to stdout-only — the pre-configure default. That path is
 * intended for tests / early boot before dataDir is resolved.
 */
export function configureImLogger(opts: ConfigureImLoggerOptions = {}): void {
  const previous = activeDisk;
  activeDisk = null;

  if (opts.dir) {
    const { dir, maxBytesPerFile, maxTotalBytes, retentionMs, now, onError, loggerOptions } = opts;
    // prefix: 'im-runtime' — disk transport composes '<prefix>-<hourKey>.log',
    // i.e. 'im-runtime-2026061209.log'. Never pass 'im-runtime-' here or the
    // transport would produce a double-dashed 'im-runtime--<hour>.log'.
    const diskOpts: DiskLogTransportOptions = { dir, prefix: 'im-runtime' };
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
    // chain in the background. Any close errors were already routed through
    // its `onError` sink; we just prevent an unhandled rejection.
    void previous.close().catch(() => {});
  }
}

/**
 * Flush pending disk writes without tearing down the base logger. Called
 * by the feedback upload path before it reads the log directory.
 */
export async function flushImLogger(): Promise<void> {
  if (!activeDisk) return;
  await activeDisk.flush();
}

/**
 * Close the disk transport (flush + retention sweep + stop accepting new
 * writes). Called during Electron `will-quit` / CLI graceful shutdown so
 * the final rotation sweep runs before the process exits.
 *
 * After shutdown the module-level logger keeps working (stdout only) — a
 * subsequent {@link configureImLogger} call re-installs it.
 */
export async function shutdownImLogger(): Promise<void> {
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

export const imLogger: LocalRuntimeLogger = {
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

export function ctxInfo(ctx: TraceContextLike, fields: LogFields, message: string): void {
  baseLogger.info({ ctx, ...fields }, message);
}

export function ctxWarn(ctx: TraceContextLike, fields: LogFields, message: string): void {
  baseLogger.warn({ ctx, ...fields }, message);
}

export function ctxError(ctx: TraceContextLike, fields: LogFields, message: string): void {
  baseLogger.error({ ctx, ...fields }, message);
}

/**
 * Test-only helper mirroring `common/logger.ts`'s `__getBaseLoggerForTests`.
 * The 4 IM tests that previously spied on the main logger's baseLogger now
 * spy this one instead; shape and behaviour are identical.
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
