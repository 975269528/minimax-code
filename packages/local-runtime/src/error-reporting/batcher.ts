/**
 * In-memory batcher for desktop error events.
 *
 * Responsibilities (design §3):
 * - Buffer raw events in a process-local array without disk writes or persistence.
 * - Send when the buffer reaches `batchSize`.
 * - Flush partial batches after `flushIntervalMs` via an idle timer.
 * - Drop oldest events first above `maxBufferEvents`.
 * - Send at most `maxBatchEvents` per request, splitting larger backlogs.
 *
 * The batcher passes raw events to injected `onFlush` without handling authentication, encryption,
 * or fetch. Scheduling failures never affect the main flow. Timers call `unref` so they do not
 * prevent process exit; dropping events never throws.
 */

import { DESKTOP_ERROR_REPORTING_DEFAULTS, type DesktopErrorLog } from './types.js';

export interface DesktopErrorBatcherOptions {
  /** Receive raw event batches and encrypt/send them; the batcher awaits completion before sending the next batch. */
  onFlush: (events: DesktopErrorLog[]) => void | Promise<void>;
  batchSize?: number;
  flushIntervalMs?: number;
  maxBufferEvents?: number;
  maxBatchEvents?: number;
}

export class DesktopErrorBatcher {
  private readonly buffer: DesktopErrorLog[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private drainPromise: Promise<void> | undefined;
  private readonly onFlush: (events: DesktopErrorLog[]) => void | Promise<void>;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxBufferEvents: number;
  private readonly maxBatchEvents: number;

  constructor(options: DesktopErrorBatcherOptions) {
    this.onFlush = options.onFlush;
    this.batchSize = positiveOr(options.batchSize, DESKTOP_ERROR_REPORTING_DEFAULTS.batchSize);
    this.flushIntervalMs = positiveOr(
      options.flushIntervalMs,
      DESKTOP_ERROR_REPORTING_DEFAULTS.flushIntervalMs,
    );
    this.maxBufferEvents = positiveOr(
      options.maxBufferEvents,
      DESKTOP_ERROR_REPORTING_DEFAULTS.maxBufferEvents,
    );
    this.maxBatchEvents = positiveOr(
      options.maxBatchEvents,
      DESKTOP_ERROR_REPORTING_DEFAULTS.maxBatchEvents,
    );
  }

  /** Add an event, enforce the buffer limit, then immediately send full batches or start the idle timer. */
  add(event: DesktopErrorLog): void {
    this.buffer.push(event);
    // Bound memory usage: drop oldest events on overflow, retaining the latest failures.
    while (this.buffer.length > this.maxBufferEvents) {
      this.buffer.shift();
    }
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
      return;
    }
    this.armTimer();
  }

  /**
   * Serially drain events into `onFlush`, at most `maxBatchEvents` per batch. Reuse the same
   * Promise while sending to guarantee at most one upload request at a time.
   */
  flush(): void | Promise<void> {
    this.clearTimer();
    if (this.drainPromise) return this.drainPromise;
    if (this.buffer.length === 0) return;

    const drain = this.drainAll().finally(() => {
      if (this.drainPromise === drain) this.drainPromise = undefined;
      // Defensive: if events arrive at the send-completion boundary, schedule another idle window.
      if (this.buffer.length > 0) this.armTimer();
    });
    this.drainPromise = drain;
    return drain;
  }

  /** Whether buffered events or an inflight request remain, for graceful flushing. */
  hasPending(): boolean {
    return this.buffer.length > 0 || this.drainPromise !== undefined;
  }

  /** Stop the idle timer without a final flush; used by {@link DesktopErrorReporter.close}. */
  stop(): void {
    this.clearTimer();
  }

  private armTimer(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushIntervalMs);
    // Reporting timers must not keep the event loop or process alive.
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async drainAll(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.maxBatchEvents);
      try {
        await this.onFlush(batch);
      } catch {
        // Drop this batch and continue with the backlog; reporting failures must not affect business flows.
      }
    }
  }
}

/** Convert to a positive integer; use `fallback` for invalid input. */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
