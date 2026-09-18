import type { LocalTaskRunnerHostWithSessionLookup } from '../api/local-task-host.js';

export interface LocalBackgroundBashCompletion {
  taskId: string;
  status: 'succeeded' | 'failed' | 'canceled';
  text: string;
  details?: Record<string, unknown>;
  isError?: boolean;
  endedAt: number;
  durationMs: number;
  outputBytes: number;
}

export async function raceCompletionWithSoftYield<T>(
  completion: Promise<T>,
  softYieldMs: number,
): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      completion,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, softYieldMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function recordBashMetrics(
  host: LocalTaskRunnerHostWithSessionLookup,
  sessionId: string,
  completion: LocalBackgroundBashCompletion,
  executionMode: 'explicit_background' | 'managed_foreground' | 'auto_promoted',
): void {
  const labels = { executionMode, status: completion.status };
  try {
    host.metricsClient?.counter('bash_execution_total', 1, labels);
    host.metricsClient?.histogram('bash_duration_ms', completion.durationMs, labels);
    host.metricsClient?.histogram('bash_output_bytes', completion.outputBytes, labels);
  } catch (error) {
    warnMetricFailure(
      host,
      { sessionId, turnId: completion.taskId },
      `Failed to record local bash metrics: ${formatError(error)}`,
    );
  }
  try {
    host.recordSessionBashCompletion?.(sessionId, {
      endedAt: completion.endedAt,
      durationMs: completion.durationMs,
    });
  } catch (error) {
    warnMetricFailure(
      host,
      { sessionId, turnId: completion.taskId },
      `Failed to record local bash completion correlation: ${formatError(error)}`,
    );
  }
}

export function recordSoftYieldMetric(
  host: LocalTaskRunnerHostWithSessionLookup,
  taskId: string,
  durationMs: number,
  outcome: 'completed' | 'promoted',
): void {
  try {
    host.metricsClient?.histogram('bash_foreground_soft_yield_ms', durationMs, { outcome });
  } catch (error) {
    warnMetricFailure(
      host,
      { sessionId: 'local-bash-metrics', turnId: taskId },
      `Failed to record local bash soft-yield metric: ${formatError(error)}`,
    );
  }
}

export function managedBashAbortError(signal: AbortSignal | undefined, fallback: string): Error {
  if (signal?.reason instanceof Error && signal.reason.name === 'AbortError') return signal.reason;
  const error = new Error(
    signal?.reason instanceof Error
      ? signal.reason.message
      : signal?.reason === undefined
        ? fallback
        : String(signal.reason),
    signal?.reason instanceof Error ? { cause: signal.reason } : undefined,
  );
  error.name = 'AbortError';
  return error;
}

export function logRunnerFailure(
  host: LocalTaskRunnerHostWithSessionLookup,
  sessionId: string,
  taskId: string,
  error: unknown,
): void {
  host.matrixLogger?.warn(
    { sessionId, turnId: taskId },
    `Local background bash runner failed after error handling: ${formatError(error)}`,
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warnMetricFailure(
  host: LocalTaskRunnerHostWithSessionLookup,
  context: { sessionId: string; turnId: string },
  message: string,
): void {
  try {
    host.matrixLogger?.warn(context, message);
  } catch {
    // Metrics and diagnostics are both optional. Neither may alter Bash
    // execution or prevent the independent completion correlation hook.
  }
}
