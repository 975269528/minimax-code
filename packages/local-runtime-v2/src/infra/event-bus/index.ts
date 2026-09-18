export interface EventSubscriber<T> {
  next(value: T): void;
  complete?(): void;
}

export type EventBusClient<T> = Pick<EventBus<T>, 'write' | 'subscribe'>;

/** Process-local, live-only fan-out with lifecycle owned by BackgroundRuntime. */
export class EventBus<T> {
  private readonly subscribers = new Set<EventSubscriber<T>>();
  private closed = false;

  write(value: T): void {
    if (this.closed) return;
    for (const subscriber of this.subscribers) {
      try {
        subscriber.next(value);
      } catch {
        // One faulty subscriber must not block the remaining live consumers.
      }
    }
  }

  subscribe(subscriber: EventSubscriber<T>): () => void {
    if (this.closed) {
      try {
        subscriber.complete?.();
      } catch {
        // Completion is best effort after shutdown.
      }
      return () => undefined;
    }
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const active = [...this.subscribers];
    this.subscribers.clear();
    for (const subscriber of active) {
      try {
        subscriber.complete?.();
      } catch {
        // Complete every subscriber even when one cleanup callback fails.
      }
    }
  }
}
