import { randomUUID } from 'node:crypto';

export interface RingEntry<T> {
  readonly cursor: string;
  readonly identity: string;
  readonly value: T;
  readonly byteSize: number;
}

export interface RingAppendInput<T> {
  readonly identity: string;
  readonly value: T;
  readonly byteSize?: number;
}

export interface RingAppendResult<T> extends RingEntry<T> {
  readonly appended: boolean;
  readonly retained: boolean;
  readonly evictedCount: number;
}

export type RingReplayResult<T> =
  | { readonly status: 'ok'; readonly entries: readonly RingEntry<T>[] }
  | { readonly status: 'evicted' | 'invalid-cursor'; readonly entries: readonly [] };

export interface BoundedRingOptions {
  readonly maxItems?: number;
  readonly maxBytes?: number;
  readonly measure?: (value: unknown) => number;
  /** Business-owned cursor namespace; cursors from another scope are invalid. */
  readonly cursorScope?: string;
  /** Injectable for deterministic tests. Production should use the random default. */
  readonly cursorEpoch?: string;
}

export interface RingRetentionSnapshot<T> {
  readonly entries: readonly RingEntry<T>[];
  readonly retainedBytes: number;
  readonly maxItems: number;
  readonly maxBytes: number;
}

/**
 * Selects how many entries to evict from the front of a ring.
 *
 * The ring owns cursor and bound enforcement; callers may use this generic
 * prefix policy to preserve application-level grouping without teaching the
 * SSE primitive about those groups.
 */
export type RingEvictionPolicy<T> = (snapshot: RingRetentionSnapshot<T>) => number;

const DEFAULT_MAX_ITEMS = 512;
const DEFAULT_MAX_BYTES = 2 * 1_024 * 1_024;

export class BoundedRing<T> {
  private readonly entries: RingEntry<T>[] = [];
  private readonly identities = new Map<string, RingEntry<T>>();
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private readonly measure: (value: unknown) => number;
  private readonly cursorPrefix: string;
  private nextCursor = 1n;
  private droppedThrough = 0n;
  private retainedBytes = 0;

  constructor(
    options: BoundedRingOptions = {},
    private readonly evictionPolicy?: RingEvictionPolicy<T>,
  ) {
    this.maxItems = positiveInteger(options.maxItems, DEFAULT_MAX_ITEMS);
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.measure = options.measure ?? measureValue;
    this.cursorPrefix = createCursorPrefix(options.cursorScope, options.cursorEpoch);
  }

  append(input: RingAppendInput<T>): RingAppendResult<T> {
    const duplicate = this.identities.get(input.identity);
    if (duplicate) {
      return { ...duplicate, appended: false, retained: true, evictedCount: 0 };
    }
    const entry: RingEntry<T> = {
      cursor: this.formatCursor(this.nextCursor),
      identity: input.identity,
      value: input.value,
      byteSize: normalizedByteSize(input.byteSize ?? this.measure(input.value)),
    };
    this.nextCursor += 1n;
    this.entries.push(entry);
    this.identities.set(entry.identity, entry);
    this.retainedBytes += entry.byteSize;
    const evictedCount = this.enforceRetention();
    const retained = this.identities.has(entry.identity);
    return {
      ...entry,
      appended: true,
      retained,
      evictedCount: retained ? evictedCount : Math.max(0, evictedCount - 1),
    };
  }

  replay(afterCursor?: string): RingReplayResult<T> {
    if (afterCursor === undefined || afterCursor.length === 0) {
      return { status: 'ok', entries: [...this.entries] };
    }
    const parsed = this.parseCursor(afterCursor);
    if (parsed === undefined || parsed >= this.nextCursor) {
      return { status: 'invalid-cursor', entries: [] };
    }
    if (parsed < this.droppedThrough) return { status: 'evicted', entries: [] };
    return {
      status: 'ok',
      entries: this.entries.filter((entry) => {
        const sequence = this.parseCursor(entry.cursor);
        return sequence !== undefined && sequence > parsed;
      }),
    };
  }

  latestCursor(): string {
    return this.formatCursor(this.nextCursor - 1n);
  }

  isAfter(cursor: string | undefined, watermark: string): boolean {
    if (!cursor) return false;
    const selected = this.parseCursor(cursor);
    const boundary = this.parseCursor(watermark);
    return selected !== undefined && boundary !== undefined && selected > boundary;
  }

  private enforceRetention(): number {
    let evictedCount = 0;
    while (this.entries.length > 0) {
      const selected = normalizedEvictionCount(
        this.evictionPolicy?.({
          entries: [...this.entries],
          retainedBytes: this.retainedBytes,
          maxItems: this.maxItems,
          maxBytes: this.maxBytes,
        }),
        this.entries.length,
      );
      const overBounds = this.entries.length > this.maxItems || this.retainedBytes > this.maxBytes;
      let count = selected;
      if (count === 0 && overBounds) count = 1;
      if (count === 0) break;
      evictedCount += this.evictPrefix(count);
    }
    return evictedCount;
  }

  private evictPrefix(count: number): number {
    return Array.from({ length: count }).reduce<number>((evictedCount) => {
      const evicted = this.entries.shift();
      if (!evicted) return evictedCount;
      this.identities.delete(evicted.identity);
      this.retainedBytes -= evicted.byteSize;
      const sequence = this.parseCursor(evicted.cursor);
      if (sequence !== undefined) this.droppedThrough = sequence;
      return evictedCount + 1;
    }, 0);
  }

  private formatCursor(sequence: bigint): string {
    return `${this.cursorPrefix}${sequence}`;
  }

  private parseCursor(value: string): bigint | undefined {
    if (!value.startsWith(this.cursorPrefix)) return undefined;
    const sequence = value.slice(this.cursorPrefix.length);
    if (!/^\d+$/.test(sequence)) return undefined;
    try {
      return BigInt(sequence);
    } catch {
      return undefined;
    }
  }
}

export function measureValue(value: unknown): number {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return new TextEncoder().encode(serialized ?? 'undefined').byteLength;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizedByteSize(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizedEvictionCount(value: number | undefined, retainedCount: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), retainedCount);
}

function createCursorPrefix(scope: string | undefined, epoch: string | undefined): string {
  return `sse1:${encodeURIComponent(scope ?? 'ring')}:${encodeURIComponent(epoch ?? randomUUID())}:`;
}
