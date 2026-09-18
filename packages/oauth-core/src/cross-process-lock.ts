import { open } from 'node:fs/promises';

import lockfile from 'proper-lockfile';

import { ensurePrivateDirectory } from './fs/atomic-write.js';
import { dirname } from 'node:path';

export interface CrossProcessAuthLockOptions {
  staleMs?: number;
  retries?: number;
}

export class CrossProcessAuthLock {
  private readonly staleMs: number;
  private readonly retries: number;

  constructor(
    private readonly lockPath: string,
    options: CrossProcessAuthLockOptions = {},
  ) {
    this.staleMs = options.staleMs ?? 30_000;
    this.retries = options.retries ?? 120;
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await ensurePrivateDirectory(dirname(this.lockPath));
    const handle = await open(this.lockPath, 'a', 0o600);
    await handle.close();
    let compromise: Error | undefined;
    const release = await lockfile.lock(this.lockPath, {
      realpath: false,
      stale: this.staleMs,
      retries: {
        retries: this.retries,
        factor: 1.15,
        minTimeout: 5,
        maxTimeout: 250,
      },
      onCompromised: (error) => {
        compromise ??= error;
      },
    });
    try {
      return await operation();
    } finally {
      try {
        await release();
      } catch (error) {
        if (!compromise) throw error;
      }
      if (compromise) throw compromise;
    }
  }
}
