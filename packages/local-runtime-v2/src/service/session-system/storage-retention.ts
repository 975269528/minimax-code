const DAY_MS = 24 * 60 * 60 * 1_000;

const TURN_DIFF_RETENTION_MS = 7 * DAY_MS;
const TURN_DIFF_RETENTION_BATCH_SIZE = 250;

interface StorageRetentionLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface SessionStorageRetentionResult {
  readonly attempted: boolean;
  readonly cutoffMs?: number;
}

export interface SessionStorageRetentionOptions {
  readonly pruneTurnDiffs?: (cutoffMs: number, batchSize: number) => Promise<unknown>;
  readonly logger?: StorageRetentionLogger;
  readonly nowMs?: () => number;
}

/**
 * One bounded post-ready pass over current Turn Diff state. Migrated Session
 * history is intentionally outside automatic retention and is never read here.
 */
export function createSessionStorageRetention(options: SessionStorageRetentionOptions) {
  return {
    run: async (): Promise<SessionStorageRetentionResult> => {
      if (!options.pruneTurnDiffs) return { attempted: false };
      const cutoffMs = retentionCutoff(options);
      if (cutoffMs === undefined) return { attempted: false };
      try {
        await options.pruneTurnDiffs(cutoffMs, TURN_DIFF_RETENTION_BATCH_SIZE);
      } catch (error) {
        options.logger?.warn({ error }, 'Turn Diff retention failed');
      }
      return { attempted: true, cutoffMs };
    },
  };
}

function retentionCutoff(options: SessionStorageRetentionOptions): number | undefined {
  try {
    const nowMs = (options.nowMs ?? Date.now)();
    if (!Number.isSafeInteger(nowMs) || nowMs < TURN_DIFF_RETENTION_MS) return undefined;
    return nowMs - TURN_DIFF_RETENTION_MS;
  } catch (error) {
    options.logger?.warn({ error }, 'Turn Diff retention clock failed');
    return undefined;
  }
}
