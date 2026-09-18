import type { GlobalEventInput } from '@mavis/shared/global-events';

import { logger } from '../common/logger.js';

/** Typed write port for product events that cross the backend/frontend boundary. */
export type GlobalEventPublisher = (event: GlobalEventInput) => void;

/** Structured live source consumed by the generated SSE adapter and local-runtime-v2. */
export interface GlobalEventSubscriber {
  next(event: GlobalEventInput): void;
  complete?(): void;
}

export interface GlobalEventSource {
  publish(event: GlobalEventInput): void;
  subscribe(subscriber: GlobalEventSubscriber): () => void;
  close(): void;
}

/** Live frontend-event source used by the v1 compatibility host. */
export function createGlobalEventSource(): GlobalEventSource {
  const subscribers = new Set<GlobalEventSubscriber>();
  let closed = false;

  return {
    publish(event) {
      if (closed) return;
      for (const subscriber of subscribers) {
        try {
          subscriber.next(event);
        } catch (err) {
          logger.warn({ err, type: event.type }, 'Global event subscriber failed');
        }
      }
    },
    subscribe(subscriber) {
      if (closed) {
        subscriber.complete?.();
        return () => undefined;
      }
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    close() {
      if (closed) return;
      closed = true;
      const active = [...subscribers];
      subscribers.clear();
      for (const subscriber of active) {
        try {
          subscriber.complete?.();
        } catch (err) {
          logger.warn({ err }, 'Global event subscriber cleanup failed');
        }
      }
    },
  };
}
