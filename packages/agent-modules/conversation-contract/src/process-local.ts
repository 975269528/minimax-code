/** Caller-controlled cancellation context; accepts no network identity or HTTP headers. */
export interface ProcessLocalContext {
  readonly signal?: AbortSignal;
}

/** Session frames consumed in-process; consumers must end the iterator early when needed. */
export type ProcessLocalStreamResult<Frame, Failure = unknown> =
  | {
      readonly ok: true;
      readonly source: AsyncIterable<Frame> | Iterable<Frame>;
    }
  | { readonly ok: false; readonly status: number; readonly body: Failure };
