import type { EventEmitter } from 'node:events';
import {
  isDeadTerminalFailure,
  type TuiProcessStopCause,
  type TuiTerminationSignal,
} from './process-stop-cause.js';

type GuardEventSource = Pick<EventEmitter, 'on' | 'off'>;

export interface TuiProcessLike extends GuardEventSource {
  readonly stdout: GuardEventSource;
  readonly stderr: GuardEventSource;
  exitCode?: string | number;
}

export interface TuiProcessGuardOptions {
  process: TuiProcessLike;
  stop(): void | Promise<void>;
  report(error: unknown): void;
  capture?(error: unknown, context: TuiProcessFailureContext): void;
  onStopCause?(cause: TuiProcessStopCause): void;
  onStopFailure?(error: unknown): void;
  isTerminalDead?(): boolean;
  suspend?(): void | Promise<void>;
  resume?(): void | Promise<void>;
  suspendProcess?(): void;
}

export interface TuiProcessFailureContext {
  readonly origin:
    | 'uncaughtException'
    | 'unhandledRejection'
    | 'stdout'
    | 'stderr'
    | 'suspend'
    | 'resume'
    | 'shutdown';
  readonly terminalDead?: boolean;
}

export function installTuiProcessGuards(options: TuiProcessGuardOptions): () => void {
  let stopping = false;
  let disposed = false;
  let suspending = false;
  let suspended = false;

  const report = (error: unknown): void => {
    try {
      options.report(error);
    } catch {
      // Diagnostics must never replace the original process failure.
    }
  };
  const capture = (error: unknown, context: TuiProcessFailureContext): void => {
    try {
      options.capture?.(error, context);
    } catch {
      // Incident capture must never replace the original process failure.
    }
  };
  const notifyStopFailure = (error: unknown): void => {
    try {
      options.onStopFailure?.(error);
    } catch {
      // Failure notification must not replace the shutdown failure.
    }
  };
  const notifyStopCause = (cause: TuiProcessStopCause): void => {
    try {
      options.onStopCause?.(cause);
    } catch {
      // Diagnostics must never replace the original process failure.
    }
  };
  const stop = (
    cause: TuiProcessStopCause,
    failure?: unknown,
    suppressFailureReport = false,
  ): void => {
    if (stopping) return;
    stopping = true;
    notifyStopCause(cause);
    const shouldSuppressFailureReport = (): boolean =>
      suppressFailureReport || cause.terminalDead || options.isTerminalDead?.() === true;
    void Promise.resolve()
      .then(() => options.stop())
      .catch((stopFailure: unknown) => {
        options.process.exitCode = 1;
        const terminalDead =
          shouldSuppressFailureReport() || isDeadTerminalFailure('terminal.stop.sync', stopFailure);
        capture(stopFailure, {
          origin: 'shutdown',
          ...(terminalDead ? { terminalDead: true } : {}),
        });
        if (!terminalDead) report(stopFailure);
        notifyStopFailure(stopFailure);
      })
      .finally(() => {
        if (failure !== undefined && !shouldSuppressFailureReport()) report(failure);
      });
  };
  const fail = (
    source: Extract<
      TuiProcessStopCause['source'],
      `${string}.failure` | 'uncaughtException' | 'unhandledRejection'
    >,
    origin: Extract<
      TuiProcessFailureContext['origin'],
      'uncaughtException' | 'unhandledRejection' | 'suspend' | 'resume'
    >,
    error: unknown,
  ): void => {
    options.process.exitCode = 1;
    const terminalDead = isDeadTerminalFailure(source, error);
    capture(error, { origin, ...(terminalDead ? { terminalDead: true } : {}) });
    stop({ source, error, terminalDead }, error);
  };
  const onSignal = (signal: TuiTerminationSignal): void =>
    stop({ source: 'signal', signal, terminalDead: false });
  const onSigint = (): void => onSignal('SIGINT');
  const onSigterm = (): void => onSignal('SIGTERM');
  const onSighup = (): void => onSignal('SIGHUP');
  const onSigbreak = (): void => onSignal('SIGBREAK');
  const suspendSupported = Boolean(options.suspend && options.resume && options.suspendProcess);
  const onSuspend = (): void => {
    if (!suspendSupported || stopping || suspending || suspended) return;
    suspending = true;
    void Promise.resolve()
      .then(() => options.suspend?.())
      .then(() => {
        if (stopping || disposed) return;
        suspended = true;
        options.process.off('SIGTSTP', onSuspend);
        options.suspendProcess?.();
      })
      .catch((error: unknown) => fail('suspend.failure', 'suspend', error))
      .finally(() => {
        suspending = false;
      });
  };
  const onContinue = (): void => {
    if (!suspendSupported || stopping || !suspended) return;
    suspended = false;
    options.process.on('SIGTSTP', onSuspend);
    void Promise.resolve()
      .then(() => options.resume?.())
      .catch((error: unknown) => fail('resume.failure', 'resume', error));
  };
  const onUncaughtException = (error: unknown): void =>
    fail('uncaughtException', 'uncaughtException', error);
  const onUnhandledRejection = (error: unknown): void =>
    fail('unhandledRejection', 'unhandledRejection', error);
  const onOutputError = (source: 'stdout.error' | 'stderr.error', error: unknown): void => {
    const cause = {
      source,
      error,
      terminalDead: isDeadTerminalFailure(source, error),
    } satisfies TuiProcessStopCause;
    const origin = source === 'stdout.error' ? 'stdout' : 'stderr';
    capture(error, { origin, ...(cause.terminalDead ? { terminalDead: true } : {}) });
    if (!cause.terminalDead) {
      options.process.exitCode = 1;
      stop(cause, error);
      return;
    }
    options.process.exitCode = 1;
    stop(cause, undefined, true);
  };
  const onStdoutError = (error: unknown): void => onOutputError('stdout.error', error);
  const onStderrError = (error: unknown): void => onOutputError('stderr.error', error);

  options.process.on('SIGINT', onSigint);
  options.process.on('SIGTERM', onSigterm);
  options.process.on('SIGHUP', onSighup);
  options.process.on('SIGBREAK', onSigbreak);
  if (suspendSupported) {
    options.process.on('SIGTSTP', onSuspend);
    options.process.on('SIGCONT', onContinue);
  }
  options.process.on('uncaughtException', onUncaughtException);
  options.process.on('unhandledRejection', onUnhandledRejection);
  options.process.stdout.on('error', onStdoutError);
  options.process.stderr.on('error', onStderrError);

  return () => {
    if (disposed) return;
    disposed = true;
    options.process.off('SIGINT', onSigint);
    options.process.off('SIGTERM', onSigterm);
    options.process.off('SIGHUP', onSighup);
    options.process.off('SIGBREAK', onSigbreak);
    if (suspendSupported) {
      options.process.off('SIGTSTP', onSuspend);
      options.process.off('SIGCONT', onContinue);
    }
    options.process.off('uncaughtException', onUncaughtException);
    options.process.off('unhandledRejection', onUnhandledRejection);
    options.process.stdout.off('error', onStdoutError);
    options.process.stderr.off('error', onStderrError);
  };
}
