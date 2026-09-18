import type { PiEventWriter } from '@mavis/agent-core/pi-turn-runner';
import { RuntimeEventStatus, RuntimeEventType } from '@mavis/protocol';

/** Only terminal delivery waits for input review; approved output can still stream. */
export function gateTerminalOnInputReview(
  inner: PiEventWriter,
  review: Promise<void>,
  shouldDiscard: () => boolean,
  signal?: AbortSignal,
): PiEventWriter {
  const isTerminal = (event: Parameters<PiEventWriter['pushRuntime']>[0]): boolean =>
    event.type === RuntimeEventType.SESSION_STATUS &&
    (event.payload?.status === RuntimeEventStatus.COMPLETED ||
      event.payload?.status === RuntimeEventStatus.ABORTED ||
      event.payload?.status === RuntimeEventStatus.FAILED);
  const shouldDiscardTerminal = (event: Parameters<PiEventWriter['pushRuntime']>[0]): boolean =>
    isTerminal(event) &&
    (shouldDiscard() ||
      (signal?.aborted === true && event.payload?.status !== RuntimeEventStatus.ABORTED));
  return {
    pushRuntime: async (event) => {
      if (isTerminal(event)) {
        await review;
        if (shouldDiscardTerminal(event)) return;
      }
      await inner.pushRuntime(event);
    },
    appendEvents: async (events) => {
      if (!events.some(isTerminal)) {
        await inner.appendEvents(events);
        return;
      }
      await review;
      const accepted = events.filter((event) => !shouldDiscardTerminal(event));
      if (accepted.length > 0) await inner.appendEvents(accepted);
    },
  };
}

export async function waitForInputReview(
  review: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return review;
  if (signal.aborted) return;
  let onAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
  });
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([review, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
