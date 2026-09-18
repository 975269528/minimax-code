import { logger, backgroundCtx } from './host-utils.js';

/** TTL for queued entries — 30 minutes */
export const TTL_MS = 30 * 60 * 1000;

export type BusyQueueDrainResult = 'sent' | 'expired' | 'removed' | 'replaced' | 'failed';

export interface QueuedEntry {
  sendFn: () => Promise<void>;
  enqueuedAt: number;
  agentName: string;
  cronName: string;
  sessionId: string;
  resolveDrain: (result: BusyQueueDrainResult) => void;
}

/**
 * Busy-queue for cron messages when the target session is busy.
 *
 * Latest-wins dedup: per cron per session, only the last enqueued message is kept.
 * Key format: `${sessionId}:${agentName}:${cronName}`.
 *
 * Entries older than TTL_MS are discarded on drain.
 */
export class BusyQueue {
  private readonly queue = new Map<string, QueuedEntry>();

  private key(sessionId: string, agentName: string, cronName: string): string {
    return `${sessionId}:${agentName}:${cronName}`;
  }

  /**
   * Enqueue a send function for a busy session.
   * Latest-wins: replaces any existing entry for the same sessionId+cronName.
   */
  enqueue(
    sessionId: string,
    cronName: string,
    sendFn: () => Promise<void>,
  ): Promise<BusyQueueDrainResult>;
  enqueue(
    sessionId: string,
    agentName: string,
    cronName: string,
    sendFn: () => Promise<void>,
  ): Promise<BusyQueueDrainResult>;
  enqueue(
    sessionId: string,
    agentNameOrCronName: string,
    cronNameOrSendFn: string | (() => Promise<void>),
    maybeSendFn?: () => Promise<void>,
  ): Promise<BusyQueueDrainResult> {
    const legacySignature = typeof cronNameOrSendFn === 'function';
    const agentName = legacySignature ? '' : agentNameOrCronName;
    const cronName = legacySignature ? agentNameOrCronName : cronNameOrSendFn;
    const sendFn = legacySignature ? cronNameOrSendFn : maybeSendFn;
    if (typeof cronName !== 'string' || !sendFn) return Promise.resolve('removed');
    const k = this.key(sessionId, agentName, cronName);
    this.queue.get(k)?.resolveDrain('replaced');
    return new Promise<BusyQueueDrainResult>((resolveDrain) => {
      this.queue.set(k, {
        sendFn,
        enqueuedAt: Date.now(),
        agentName,
        cronName,
        sessionId,
        resolveDrain,
      });
    });
  }

  /**
   * Drop queued messages for a deleted cron task. Timers are stopped by the
   * registry, but a tick that already entered BusyQueue must be cancelled too;
   * otherwise it can drain after deletion and look like the cron kept running.
   */
  removeCron(agentName: string, cronName: string): number {
    let removed = 0;
    for (const [k, entry] of this.queue) {
      if (entry.agentName === agentName && entry.cronName === cronName) {
        this.queue.delete(k);
        entry.resolveDrain('removed');
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Drain all queued entries for a session.
   * Skips expired entries (older than TTL_MS).
   * Each sendFn is wrapped in try/catch so one failure doesn't block others.
   * All entries for the session are removed after drain (including expired).
   */
  async drain(sessionId: string): Promise<void> {
    const ctx = backgroundCtx();
    const now = Date.now();
    const toExecute: QueuedEntry[] = [];
    const toRemove: string[] = [];

    for (const [k, entry] of this.queue) {
      if (entry.sessionId === sessionId) {
        toRemove.push(k);
        if (now - entry.enqueuedAt < TTL_MS) {
          toExecute.push(entry);
        } else {
          entry.resolveDrain('expired');
          logger.debug(
            ctx,
            `[cron] Discarding expired queued entry: sessionId=${sessionId} cronName=${entry.cronName}`,
          );
        }
      }
    }

    // Remove all entries for this session (both valid and expired)
    for (const k of toRemove) {
      this.queue.delete(k);
    }

    // Execute surviving entries
    for (const entry of toExecute) {
      try {
        await entry.sendFn();
        entry.resolveDrain('sent');
        logger.info(
          ctx,
          `[cron] Drained queued message to now-idle session: sessionId=${sessionId} cronName=${entry.cronName}`,
        );
      } catch (err) {
        entry.resolveDrain('failed');
        logger.error(
          ctx,
          `[cron] Failed to drain queued message: sessionId=${sessionId} cronName=${entry.cronName} err=${(err as Error).message}`,
        );
      }
    }
  }

  /** Total entries in the queue */
  size(): number {
    return this.queue.size;
  }

  /** Entries queued for a specific session */
  getQueuedCount(sessionId: string): number {
    let count = 0;
    for (const entry of this.queue.values()) {
      if (entry.sessionId === sessionId) count++;
    }
    return count;
  }
}
