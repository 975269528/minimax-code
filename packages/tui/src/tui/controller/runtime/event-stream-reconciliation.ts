export interface ConsumeReconciledEventStreamOptions<T> {
  readonly stream: AsyncIterable<T>;
  readonly reconcile: () => Promise<void>;
  readonly onEvent: (event: T) => Promise<void>;
}

type StreamRead<T> =
  | { readonly ok: true; readonly result: IteratorResult<T> }
  | { readonly ok: false; readonly error: unknown };

function readNext<T>(iterator: AsyncIterator<T>): Promise<StreamRead<T>> {
  return iterator.next().then(
    (result) => ({ ok: true, result }),
    (error: unknown) => ({ ok: false, error }),
  );
}

/**
 * Arms the live iterator before reading authoritative snapshots. Events that
 * arrive while reconciliation is in flight remain buffered by the Runtime
 * stream and are projected only after the snapshots have been applied.
 */
export async function consumeReconciledEventStream<T>(
  options: ConsumeReconciledEventStreamOptions<T>,
): Promise<void> {
  const iterator = options.stream[Symbol.asyncIterator]();
  let pendingRead = readNext(iterator);

  try {
    await options.reconcile();
    for (;;) {
      const next = await pendingRead;
      if (!next.ok) throw next.error;
      if (next.result.done) return;

      pendingRead = readNext(iterator);
      await options.onEvent(next.result.value);
    }
  } finally {
    try {
      await iterator.return?.();
    } catch {
      // Stream termination is best-effort and must not replace the original failure.
    }
  }
}
