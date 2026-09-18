export interface SessionUsageCommitSignal {
  publish(sessionId: string): void;
  subscribe(listener: (sessionId: string) => void): () => void;
}

/** Process-local notification emitted only after at least one Usage row is stored. */
export function createSessionUsageCommitSignal(): SessionUsageCommitSignal {
  const listeners = new Set<(sessionId: string) => void>();
  return {
    publish: (sessionId) => {
      for (const listener of listeners) {
        try {
          listener(sessionId);
        } catch {
          // Live consumers cannot affect the best-effort Usage projection.
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
