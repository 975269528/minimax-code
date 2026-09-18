export interface SessionHistoryIoLane {
  run<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
}

export interface SessionHistoryActivity {
  version(sessionId: string): number;
  notify(sessionId: string): void;
  waitForChange(sessionId: string, afterVersion: number, timeoutMs: number): Promise<boolean>;
}

/** Serializes physical history I/O shared by the canonical provider and mutation adapter. */
export function createSessionHistoryIoLane(): SessionHistoryIoLane {
  const lanes = new Map<string, Promise<void>>();
  return {
    async run(sessionId, operation) {
      const previous = lanes.get(sessionId) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      lanes.set(sessionId, current);
      try {
        await previous;
        return await operation();
      } finally {
        release();
        if (lanes.get(sessionId) === current) lanes.delete(sessionId);
      }
    },
  };
}

/** Lossless versioned notification used when Display commits just before canonical history. */
export function createSessionHistoryActivity(): SessionHistoryActivity {
  const versions = new Map<string, number>();
  const waiters = new Map<string, Set<HistoryActivityWaiter>>();
  return {
    version: (sessionId) => versions.get(sessionId) ?? 0,
    notify: (sessionId) => {
      const next = (versions.get(sessionId) ?? 0) + 1;
      versions.set(sessionId, next);
      for (const waiter of waiters.get(sessionId) ?? []) {
        if (next > waiter.afterVersion) waiter.settle(true);
      }
    },
    waitForChange: (sessionId, afterVersion, timeoutMs) => {
      if ((versions.get(sessionId) ?? 0) > afterVersion) return Promise.resolve(true);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const entries = waiters.get(sessionId) ?? new Set<HistoryActivityWaiter>();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waiter: HistoryActivityWaiter = {
          afterVersion,
          settle: (changed) => {
            if (!entries.delete(waiter)) return;
            if (timer) clearTimeout(timer);
            if (entries.size === 0) waiters.delete(sessionId);
            resolve(changed);
          },
        };
        entries.add(waiter);
        waiters.set(sessionId, entries);
        timer = setTimeout(() => waiter.settle(false), Math.floor(timeoutMs));
        timer.unref?.();
      });
    },
  };
}

interface HistoryActivityWaiter {
  readonly afterVersion: number;
  readonly settle: (changed: boolean) => void;
}
