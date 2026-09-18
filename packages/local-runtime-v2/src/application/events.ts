import type { GlobalEvent, GlobalEventInput } from '@mavis/shared/global-events';

export type GlobalEventPublisher = (event: GlobalEventInput) => void;

export interface RuntimeGlobalEventWriterOptions {
  readonly isClosed: () => boolean;
  readonly nowMs: () => number;
  readonly notifyContextReset?: (sessionId: string) => void;
  readonly notifySessionDeleted?: (sessionId: string) => void;
  readonly notifyGreetingTurnTerminal?: (
    turnId: string,
    status: 'completed' | 'failed' | 'cancelled',
  ) => Promise<void> | undefined;
  readonly write: (event: GlobalEvent) => void;
}

export interface RuntimeGlobalEventCompositionOptions extends RuntimeGlobalEventWriterOptions {
  readonly observeTurn: (input: { readonly sessionId: string; readonly turnId: string }) => void;
}

const greetingNotificationObservations = new WeakSet<Promise<void>>();

export function createRuntimeGlobalEventWriter(
  options: RuntimeGlobalEventWriterOptions,
): GlobalEventPublisher {
  return (event) => {
    if (options.isClosed()) return;
    if (event.type === 'message.rewind' && event.payload.contextReset === true) {
      options.notifyContextReset?.(event.payload.sessionId);
    }
    if (event.type === 'session.deleted') {
      options.notifySessionDeleted?.(event.payload.sessionId);
    }
    notifyGreetingTurnTerminal(options.notifyGreetingTurnTerminal, event);
    options.write({ ...event, timestamp: options.nowMs(), source: 'local-runtime' } as GlobalEvent);
  };
}

/** Adds cross-capability Turn observation before the committed event reaches the process bus. */
export function composeRuntimeGlobalEventWriter(
  options: RuntimeGlobalEventCompositionOptions,
): GlobalEventPublisher {
  return createRuntimeGlobalEventWriter({
    ...options,
    write: (event) => {
      if (event.type === 'session.start' && event.payload.turnId) {
        options.observeTurn({
          sessionId: event.payload.sessionId,
          turnId: event.payload.turnId,
        });
      }
      options.write(event);
    },
  });
}

function notifyGreetingTurnTerminal(
  notify: RuntimeGlobalEventWriterOptions['notifyGreetingTurnTerminal'],
  event: GlobalEventInput,
): void {
  const terminal = terminalGreetingStatus(event);
  if (!terminal || !notify) return;
  let notification: Promise<void> | undefined;
  try {
    notification = notify(terminal.turnId, terminal.status);
  } catch {
    return;
  }
  if (notification === undefined) return;
  greetingNotificationObservations.add(consumeGreetingNotification(notification));
}

async function consumeGreetingNotification(notification: Promise<void>): Promise<void> {
  try {
    await notification;
  } catch {
    // Greeting persistence is a retryable observation after the terminal event.
  }
}

function terminalGreetingStatus(
  event: GlobalEventInput,
): { readonly turnId: string; readonly status: 'completed' | 'failed' | 'cancelled' } | undefined {
  switch (event.type) {
    case 'session.finish':
      return { turnId: event.payload.turnId, status: 'completed' };
    case 'session.error':
      return { turnId: event.payload.turnId, status: 'failed' };
    case 'session.abort':
      return { turnId: event.payload.turnId, status: 'cancelled' };
    default:
      return undefined;
  }
}

/** A committed business result remains primary when event publication or reporting fails. */
export function publishBestEffort(
  publisher: GlobalEventPublisher,
  event: GlobalEventInput,
  onFailure?: (event: GlobalEventInput, error: unknown) => void,
): void {
  try {
    publisher(event);
  } catch (error) {
    try {
      onFailure?.(event, error);
    } catch {
      // A committed business result remains primary.
    }
  }
}

/** Adapts the process EventBus to a cancellation-owned async iterator. */
export async function* watchGlobalEvents(
  subscribe: (subscriber: (event: GlobalEvent) => void) => () => void,
  signal?: AbortSignal,
): AsyncGenerator<GlobalEvent> {
  yield* watchProcessEvents(subscribe, signal);
}

/** Adapts a process-local subscription to a cancellation-owned async iterator. */
export async function* watchProcessEvents<T>(
  subscribe: (subscriber: (event: T) => void) => () => void,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  if (signal?.aborted) return;
  const queued: T[] = [];
  let wake: (() => void) | undefined;
  const unsubscribe = subscribe((event) => {
    queued.push(event);
    wake?.();
    wake = undefined;
  });
  const abort = () => {
    wake?.();
    wake = undefined;
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (!signal?.aborted) {
      const event = queued.shift();
      if (event) {
        yield event;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    unsubscribe();
  }
}
