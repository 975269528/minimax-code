/**
 * Merge caller + safety abort signals into the one signal passed to Pi. The
 * first source wins and its bounded reason is preserved for turn metrics.
 */
export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener(
      'abort',
      () => {
        if (!controller.signal.aborted) controller.abort(signal.reason);
      },
      { once: true },
    );
  }
  return controller.signal;
}
