import type { LocalTaskRunResult } from '@mavis/agent-tools/desktop';

import type { LocalTaskRunnerHostWithSessionLookup } from '../api/local-task-host.js';
import { logger } from '../common/logger.js';
import { scheduleLocalBackgroundTaskDelivery } from './delivery.js';
import {
  isTerminalTaskStatus,
  normalizeTaskError,
  type BackgroundTask,
  type BackgroundTaskStatus,
  type TaskError,
  type TaskOutputRef,
} from './domain.js';

/**
 * `already-delivered` means the caller already handed the result back to the
 * owner Turn synchronously, so the task only needs the delivery latch.
 * `schedule` hands the notification to the background delivery scheduler.
 */
export type LocalSubagentTaskDelivery = 'already-delivered' | 'schedule';

/** A completion rejection, normalized into a terminal outcome by this module. */
export interface LocalSubagentTaskFailure {
  readonly failure: unknown;
}

export type LocalSubagentTaskOutcome = LocalTaskRunResult | LocalSubagentTaskFailure;

export interface PersistLocalSubagentTaskTerminalInput {
  readonly host: LocalTaskRunnerHostWithSessionLookup;
  readonly taskId: string;
  readonly result: LocalSubagentTaskOutcome;
  readonly delivery: LocalSubagentTaskDelivery;
}

interface TerminalProjection {
  readonly status: BackgroundTaskStatus;
  readonly outputText: string;
  readonly summary?: string;
  readonly lastError?: TaskError;
}

/**
 * Single terminal writer for local subagent tasks. Every producer of a subagent
 * completion — background runner, foreground runner and append — routes through
 * here so a task can never keep a non-terminal status after its Turn settled,
 * and so a task_stop that already finalized the row is never overwritten.
 */
export async function persistLocalSubagentTaskTerminal(
  input: PersistLocalSubagentTaskTerminalInput,
): Promise<BackgroundTask> {
  const { host, taskId } = input;
  const terminal = toTerminalProjection(input.result);
  const now = host.nowMs();
  const outputRef = await host.backgroundTaskService.appendOutput({
    taskId,
    stream: 'final_result',
    content: terminal.outputText,
    timestamp: now,
  });
  const completion = await host.backgroundTaskService.patchIfNotTerminal(taskId, {
    status: terminal.status,
    endedAt: now,
    outputRef,
    ...(terminal.lastError ? { lastError: terminal.lastError } : {}),
    ...(input.delivery === 'already-delivered' ? { deliveredAt: now } : {}),
  });
  // task_stop (or any earlier terminal writer) wins the status race; the late
  // result may only backfill the output pointer.
  const task = completion.patched
    ? completion.task
    : ((await patchTerminalTaskOutput(host, taskId, outputRef, input.delivery, now)) ??
      completion.task);
  if (completion.patched) {
    logger.info(
      {
        taskId,
        ownerSessionId: task.ownerSessionId,
        status: terminal.status,
        delivery: input.delivery,
      },
      'Local subagent task reached a terminal status',
    );
  } else {
    // Losing this race is normal (task_stop got there first) but it changes
    // what the owner will read, so it is never silent.
    logger.warn(
      {
        taskId,
        ownerSessionId: task.ownerSessionId,
        keptStatus: task.status,
        discardedStatus: terminal.status,
        delivery: input.delivery,
      },
      'Local subagent task was already terminal; only backfilling its output',
    );
  }
  try {
    await host.backgroundTaskService.finalizeOutput(taskId, terminal.summary);
  } catch (error) {
    // Finalization only seals the sidecar output. The terminal status and its
    // owner delivery are still authoritative and must proceed independently.
    logger.warn(
      { taskId, error: failureMessage(error) },
      'Local subagent task final output could not be finalized',
    );
  }
  try {
    await deliverTerminal(host, task, input.delivery);
  } catch (error) {
    logger.warn(
      { taskId, error: failureMessage(error) },
      'Local subagent task terminal delivery could not be scheduled',
    );
  }
  return task;
}

async function deliverTerminal(
  host: LocalTaskRunnerHostWithSessionLookup,
  task: BackgroundTask,
  delivery: LocalSubagentTaskDelivery,
): Promise<void> {
  if (delivery === 'schedule') {
    scheduleLocalBackgroundTaskDelivery(host, task.taskId);
  }
}

async function patchTerminalTaskOutput(
  host: LocalTaskRunnerHostWithSessionLookup,
  taskId: string,
  outputRef: TaskOutputRef,
  delivery: LocalSubagentTaskDelivery,
  now: number,
): Promise<BackgroundTask | undefined> {
  const existing = await host.backgroundTaskService.get(taskId);
  if (!existing || !isTerminalTaskStatus(existing.status)) return undefined;
  return host.backgroundTaskService.patch(taskId, {
    outputRef,
    endedAt: existing.endedAt ?? now,
    ...(delivery === 'already-delivered' && existing.deliveredAt === undefined
      ? { deliveredAt: now }
      : {}),
  });
}

function toTerminalProjection(result: LocalSubagentTaskOutcome): TerminalProjection {
  if (isFailure(result)) {
    return {
      status: 'failed',
      outputText: `Background task failed: ${failureMessage(result.failure)}`,
      lastError: normalizeTaskError(result.failure, 'TASK_FAILED'),
    };
  }
  const status = terminalStatus(result.status);
  const failureText =
    result.status === 'succeeded'
      ? ''
      : `\n\n[${result.status}] ${result.errorMessage ?? 'Local background task did not complete.'}`;
  return {
    status,
    outputText: `${result.finalText ?? ''}${failureText}`,
    ...(result.finalText !== undefined ? { summary: result.finalText } : {}),
    ...(result.status === 'succeeded'
      ? {}
      : {
          lastError: {
            message: result.errorMessage ?? result.status,
            code: status === 'canceled' ? 'TASK_CANCELED' : 'TASK_FAILED',
          },
        }),
  };
}

function terminalStatus(status: LocalTaskRunResult['status']): BackgroundTaskStatus {
  if (status === 'succeeded') return 'succeeded';
  return status === 'aborted' ? 'canceled' : 'failed';
}

function isFailure(result: LocalSubagentTaskOutcome): result is LocalSubagentTaskFailure {
  return 'failure' in result;
}

function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
