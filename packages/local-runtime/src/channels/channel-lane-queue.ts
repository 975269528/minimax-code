import type { LocalChannelLaneName } from './infra.js';

export class LocalChannelLaneQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly queued = new Map<string, number>();
  private readonly active = new Map<string, number>();

  async enqueue<T>(lane: LocalChannelLaneName, task: () => Promise<T>): Promise<T> {
    const laneName = normalizeLane(lane);
    const previous = this.tails.get(laneName) ?? Promise.resolve();
    this.queued.set(laneName, (this.queued.get(laneName) ?? 0) + 1);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(laneName, tail);
    await previous.catch(() => undefined);
    this.queued.set(laneName, Math.max(0, (this.queued.get(laneName) ?? 1) - 1));
    this.active.set(laneName, (this.active.get(laneName) ?? 0) + 1);
    try {
      return await task();
    } finally {
      this.active.set(laneName, Math.max(0, (this.active.get(laneName) ?? 1) - 1));
      release();
      if (this.tails.get(laneName) === tail) this.tails.delete(laneName);
    }
  }

  stats(): Record<string, { queued: number; active: number }> {
    const lanes = new Set([...this.queued.keys(), ...this.active.keys(), ...this.tails.keys()]);
    const out: Record<string, { queued: number; active: number }> = {};
    for (const lane of lanes) {
      out[lane] = {
        queued: this.queued.get(lane) ?? 0,
        active: this.active.get(lane) ?? 0,
      };
    }
    return out;
  }
}

function normalizeLane(value: unknown): LocalChannelLaneName {
  return typeof value === 'string' && value.trim() ? value.trim() : 'interactive';
}
