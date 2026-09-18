export interface TurnReleasedSignal {
  publish(sessionId: string): Promise<void>;
  subscribe(listener: (sessionId: string) => void | Promise<void>): () => void;
}

/** In-process release notification for Queue-blocking Session ownership. */
export function createTurnReleasedSignal(): TurnReleasedSignal {
  const listeners = new Set<(sessionId: string) => void | Promise<void>>();
  return {
    publish: async (sessionId) => {
      await Promise.allSettled([...listeners].map((listener) => listener(sessionId)));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
