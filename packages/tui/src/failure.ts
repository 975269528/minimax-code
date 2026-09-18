export type TuiFailureCategory =
  | 'invocation'
  | 'config'
  | 'runtime'
  | 'protocol'
  | 'internal'
  | 'cancelled'
  | 'brokenPipe';

export interface TuiFailureOptions extends ErrorOptions {
  code: string;
  retryable?: boolean;
  details?: Readonly<Record<string, unknown>>;
}

export class TuiFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    readonly category: TuiFailureCategory,
    message: string,
    options: TuiFailureOptions,
  ) {
    super(message, options);
    this.name = 'TuiFailure';
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function toTuiFailure(
  error: unknown,
  fallback: Pick<TuiFailureOptions, 'code' | 'retryable'> & {
    category: TuiFailureCategory;
  },
): TuiFailure {
  if (error instanceof TuiFailure) return error;
  return new TuiFailure(fallback.category, error instanceof Error ? error.message : String(error), {
    code: fallback.code,
    retryable: fallback.retryable,
    cause: error,
  });
}
