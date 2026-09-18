export function successfulTaskOutputReadTaskId(input: {
  readonly toolName: string;
  readonly isError?: boolean;
  readonly args?: unknown;
  readonly details?: unknown;
}): string | undefined {
  if (input.toolName !== 'task_output' || input.isError === true) return undefined;
  const details = readRecord(input.details);
  if (isFailedRead(details)) return undefined;
  const args = readRecord(input.args);
  return nonEmptyString(args.task_id) ?? nonEmptyString(details.task_id);
}

function isFailedRead(details: Readonly<Record<string, unknown>>): boolean {
  return (
    details.is_error === true ||
    details.cancelled === true ||
    details.status === 'cancelled' ||
    ['failed', 'cancel', 'cancelled', 'canceled'].includes(String(details.decision))
  );
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Incremental reads while running must not suppress a later terminal notification. */
export function successfulTerminalTaskOutputReadTaskId(
  input: Parameters<typeof successfulTaskOutputReadTaskId>[0],
): string | undefined {
  const status = readRecord(input.details).status;
  return ['succeeded', 'failed', 'canceled', 'lost'].includes(String(status))
    ? successfulTaskOutputReadTaskId(input)
    : undefined;
}
