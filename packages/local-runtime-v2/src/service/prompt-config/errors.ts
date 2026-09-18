export class PromptConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PromptConfigError';
  }
}

/** A remote snapshot cannot be used as a complete prompt source for this call. */
export class PromptSnapshotInvalidError extends PromptConfigError {
  constructor(message = 'Prompt snapshot is invalid') {
    super('PROMPT_SNAPSHOT_INVALID', message);
    this.name = 'PromptSnapshotInvalidError';
  }
}

export function isPromptSnapshotInvalidError(error: unknown): error is PromptSnapshotInvalidError {
  return error instanceof PromptSnapshotInvalidError;
}
