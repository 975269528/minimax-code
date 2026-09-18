/** Stable Application error contract consumed by transport error boundaries. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly key: string,
    message: string,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotImplementedError extends AppError {
  constructor(method: string) {
    super(501, 'NOT_IMPLEMENTED', `${method} is not implemented in local-runtime-v2`);
  }
}
