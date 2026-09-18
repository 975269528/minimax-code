import { watch, type FSWatcher } from 'node:fs';
import { mkdir } from 'node:fs/promises';

import {
  deferred,
  settleInBackground,
  waitUntilSettledOrDeadline,
  type Deferred,
} from '../../plugin-system-helpers.js';

const DEFAULT_DEBOUNCE_MS = 150;
const EVENT_DELIVERY_GRACE_MS = 20;
const DEFAULT_ADMISSION_WAIT_TIMEOUT_MS = 20_000;

export interface LocalPluginDirectoryWatcherPort {
  start(): Promise<void>;
  whenIdle(): Promise<void>;
  close(): void;
}

/** Coalesces external changes below `<dataDir>/plugins` into one runtime rebuild. */
export class LocalPluginDirectoryWatcher implements LocalPluginDirectoryWatcherPort {
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private idle: Deferred<void> | undefined;
  private requestedGeneration = 0;
  private running = false;
  private closed = false;

  constructor(
    private readonly root: string,
    private readonly onChange: () => Promise<void>,
    private readonly debounceMs = DEFAULT_DEBOUNCE_MS,
    private readonly admissionWaitTimeoutMs = DEFAULT_ADMISSION_WAIT_TIMEOUT_MS,
  ) {}

  async start(): Promise<void> {
    if (this.watcher || this.closed) return;
    try {
      await mkdir(this.root, { recursive: true });
      if (this.closed) return;
      this.watcher = this.createWatcher(this.root, () => this.markChanged());
    } catch {
      // Native watching is an optimization. Explicit Marketplace refresh and
      // mutation APIs remain available when the platform cannot create it.
      return;
    }
    // A watcher error must not surface as an uncaught EventEmitter error and
    // terminate the Desktop process. Keep the last published snapshot; the
    // explicit Marketplace refresh remains the recovery path.
    this.watcher.on('error', () => {
      this.watcher?.close();
      this.watcher = undefined;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      if (!this.running) this.settleIdle();
    });
  }

  protected createWatcher(root: string, onChange: () => void): FSWatcher {
    return watch(root, { persistent: false, recursive: true }, onChange);
  }

  async whenIdle(): Promise<void> {
    // A filesystem write can resolve before its native watch event is
    // delivered. Give the OS a short delivery window before observing `idle`
    // so a turn admitted immediately after Plugin Creator finishes sees the
    // resulting publication. The debounce wait is paid only after a change.
    await new Promise<void>((resolve) => setTimeout(resolve, EVENT_DELIVERY_GRACE_MS));
    const idle = this.idle?.promise;
    if (idle) await waitUntilSettledOrDeadline(idle, this.admissionWaitTimeoutMs);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.running) this.settleIdle();
  }

  private markChanged(): void {
    if (this.closed) return;
    this.requestedGeneration += 1;
    this.idle ??= deferred<void>();
    this.schedule();
  }

  private schedule(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // The callback owns its fail-open boundary; the watcher must stay alive
      // after a malformed, partially-written custom Plugin is observed.
      settleInBackground(this.flushSafely());
    }, this.debounceMs);
  }

  private async flushSafely(): Promise<void> {
    try {
      await this.flush();
    } catch {
      // The next filesystem event retries after an incomplete external write.
    }
  }

  private async flush(): Promise<void> {
    if (this.closed || this.running) return;
    this.running = true;
    const generation = this.requestedGeneration;
    try {
      await this.onChange();
    } finally {
      this.running = false;
      if (!this.closed && generation !== this.requestedGeneration) {
        this.schedule();
      } else {
        this.settleIdle();
      }
    }
  }

  private settleIdle(): void {
    this.idle?.resolve();
    this.idle = undefined;
  }
}
