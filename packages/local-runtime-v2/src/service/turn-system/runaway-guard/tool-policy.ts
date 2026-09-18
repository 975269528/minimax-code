import type { RunawayGuardToolPolicy } from '@mavis/agent-extension';

type RunawayGuardToolStep = Parameters<NonNullable<RunawayGuardToolPolicy['projectProgress']>>[0];
type RunawayGuardToolResult = RunawayGuardToolStep['result'];

/** Shared by production assembly and offline replay so typed task rules cannot drift. */
export function createProductionRunawayGuardToolPolicies(): Readonly<
  Record<string, RunawayGuardToolPolicy>
> {
  const shellSearchPolicy: RunawayGuardToolPolicy = {
    kind: 'detect',
    isExpectedResult: isExpectedShellSearchNoMatch,
  };
  return {
    bash: shellSearchPolicy,
    sh: shellSearchPolicy,
    shell: shellSearchPolicy,
    zsh: shellSearchPolicy,
    grep: {
      kind: 'detect',
      isExpectedResult: isExpectedDedicatedSearchNoMatch,
    },
    task_query: {
      kind: 'polling',
      projectProgress: projectTaskQueryProgress,
    },
    task_output: {
      kind: 'polling',
      projectProgress: projectTaskOutputProgress,
    },
  };
}

function isExpectedShellSearchNoMatch(
  step: Parameters<NonNullable<RunawayGuardToolPolicy['isExpectedResult']>>[0],
): boolean {
  if (step.result?.isError !== true || !isRecord(step.arguments)) return false;
  const command = firstNonEmptyString(step.arguments, [
    'command',
    'cmd',
    'script',
    'input',
    '_raw',
  ]);
  if (!command || !/^(?:rg|grep|git\s+grep)(?:\s|$)/u.test(command.trim())) return false;
  // Unknown/compound shell forms are never blanket-exempted as search no-match.
  if (/[;&|`$<>\\\\\r\n]/u.test(command)) return false;
  const text = joinedToolResultText(step.result.content).trim().toLowerCase();
  return (
    text === 'command exited with code 1' ||
    text === '(no output)\n\ncommand exited with code 1' ||
    text === 'background bash failed: (no output)\n\ncommand exited with code 1'
  );
}

function isExpectedDedicatedSearchNoMatch(
  step: Parameters<NonNullable<RunawayGuardToolPolicy['isExpectedResult']>>[0],
): boolean {
  if (step.result?.isError !== true) return false;
  const text = joinedToolResultText(step.result.content).trim().toLowerCase();
  return text === 'no matches found' || text === 'no matches found.';
}

function projectTaskOutputProgress(step: RunawayGuardToolStep) {
  const taskId = taskIdFromArguments(step.arguments);
  const observation = taskOutputObservation(step);
  if (!isTrustedNativeTaskOutput(step)) return observation;
  if (!taskId) return undefined;
  return projectTrustedTaskOutput(taskId, step.result);
}

function projectTrustedTaskOutput(taskId: string, result: RunawayGuardToolResult) {
  const reset = () => taskOutputReset(taskId);
  // A dispatched native request identifies this task even if the result was lost.
  if (!result) return reset();
  if (result.toolName !== 'task_output') return undefined;
  const details = isRecord(result.details) ? result.details : undefined;
  // A receipt that explicitly names a different task invalidates the whole
  // polling segment, even when the tool itself reported an error.
  if (receiptTaskConflicts(taskId, details)) return undefined;
  // Native execution plus the request identity is enough to reset a known task
  // when a failed result has no structured receipt.
  if (result.isError) return reset();
  return projectSuccessfulTaskOutputReceipt(taskId, details);
}

function projectSuccessfulTaskOutputReceipt(
  taskId: string,
  details: Readonly<Record<string, unknown>> | undefined,
) {
  const reset = () => taskOutputReset(taskId);
  if (!details || taskIdFromDetails(details) !== taskId) return undefined;
  if (details.is_error === true || details.ok === false) return reset();
  const status = nonEmptyString(details.status);
  const nextOffset = nonNegativeSafeInteger(details.next_offset);
  if ((status !== 'queued' && status !== 'running') || nextOffset === undefined) return reset();
  return {
    loopKey: { taskId },
    progressKey: { status, nextOffset },
    polling: { mode: 'continuous' as const, reminderEligible: true },
  };
}

function receiptTaskConflicts(
  taskId: string,
  details: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const receiptTaskId = details ? taskIdFromDetails(details) : undefined;
  return receiptTaskId !== undefined && receiptTaskId !== taskId;
}

function taskOutputObservation(step: RunawayGuardToolStep) {
  if (!isRecord(step.arguments) || !isRecord(step.result?.details)) return undefined;
  const taskId = taskIdFromArguments(step.arguments);
  const status = nonEmptyString(step.result.details.status);
  if (!taskId || !status) return undefined;
  return {
    loopKey: { taskId },
    progressKey: {
      status,
      nextOffset: safeIntegerOrNull(step.result.details.next_offset),
    },
  };
}

function taskOutputReset(taskId: string) {
  return {
    loopKey: { taskId },
    progressKey: 'reset',
    polling: { mode: 'reset' as const },
  };
}

function isTrustedNativeTaskOutput(step: RunawayGuardToolStep): boolean {
  const provenance = step.trustedToolProvenance;
  return (
    step.toolName === 'task_output' &&
    provenance?.toolCallId === step.toolCallId &&
    provenance.toolName === 'task_output' &&
    (provenance.source === 'builtin' || provenance.source === 'captured-compatibility')
  );
}

function taskIdFromArguments(value: unknown): string | undefined {
  return isRecord(value) ? nonBlankString(value.task_id) : undefined;
}

function taskIdFromDetails(value: Readonly<Record<string, unknown>>): string | undefined {
  return nonBlankString(value.task_id);
}

function projectTaskQueryProgress(
  step: Parameters<NonNullable<RunawayGuardToolPolicy['projectProgress']>>[0],
) {
  if (!isRecord(step.arguments) || !isRecord(step.result?.details)) return undefined;
  const taskId = nonEmptyString(step.arguments.task_id);
  const statusFilter = nonEmptyString(step.arguments.status);
  const taskStates = taskQueryStates(step.result.details);
  const count = safeIntegerOrNull(step.result.details.count);
  if (taskStates.length === 0 && count === null) return undefined;
  return {
    loopKey: { taskId: taskId ?? null, statusFilter: statusFilter ?? null },
    progressKey: {
      count,
      tasks: taskStates,
    },
  };
}

function taskQueryStates(
  details: Readonly<Record<string, unknown>>,
): readonly { readonly taskId: string; readonly status: string }[] {
  let values: readonly unknown[] = [];
  if (Array.isArray(details.tasks)) {
    values = details.tasks;
  } else if (isRecord(details.task)) {
    values = [details.task];
  }
  return values
    .flatMap((value) => {
      if (!isRecord(value)) return [];
      const taskId = nonEmptyString(value.task_id);
      const status = nonEmptyString(value.status);
      return taskId && status ? [{ taskId, status }] : [];
    })
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function firstNonEmptyString(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = nonEmptyString(value[key]);
    if (candidate) return candidate;
  }
  return undefined;
}

function joinedToolResultText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string'
        ? [block.text]
        : [],
    )
    .join('\n');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
