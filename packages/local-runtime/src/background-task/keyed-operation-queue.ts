export class KeyedOperationQueue {
  private readonly operations = new Map<string, Promise<unknown>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.operations.set(key, current);
    try {
      return await current;
    } finally {
      if (this.operations.get(key) === current) this.operations.delete(key);
    }
  }
}
