/** Serializes operations per key without coupling unrelated keys. */
export class KeyedOperationLane<Key> {
  private readonly tails = new Map<Key, Promise<void>>();

  async acquire(key: Key): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const current = waitForLane(previous, gate);
    this.tails.set(key, current);
    await ignoreLaneFailure(previous);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      if (this.tails.get(key) === current) this.tails.delete(key);
    };
  }

  async run<T>(key: Key, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

async function waitForLane(previous: Promise<void>, gate: Promise<void>): Promise<void> {
  await ignoreLaneFailure(previous);
  await gate;
}

async function ignoreLaneFailure(lane: Promise<void>): Promise<void> {
  try {
    await lane;
  } catch {
    // A failed predecessor must not poison later operations for the same key.
  }
}
