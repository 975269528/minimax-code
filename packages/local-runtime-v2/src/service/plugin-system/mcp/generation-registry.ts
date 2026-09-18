import { PluginSystemError } from '../errors.js';
import { ignoreFailure, settleInBackground } from '../plugin-system-helpers.js';

import type { PluginMcpRuntimePort } from './runtime.js';

interface PluginCapabilityGeneration {
  readonly revision: string;
  readonly runtime: PluginMcpRuntimePort;
  readonly finalizers: Array<() => Promise<void>>;
  leaseCount: number;
  retired: boolean;
  cleanupTask?: Promise<void>;
}

/** Keeps retired MCP runtimes alive until turns using their snapshot finish. */
export class PluginCapabilityGenerationRegistry {
  private current: PluginCapabilityGeneration;
  private readonly generations = new Map<string, PluginCapabilityGeneration>();
  private readonly cleanupTasks = new Set<Promise<void>>();

  constructor(revision: string, runtime: PluginMcpRuntimePort) {
    this.current = this.create(revision, runtime);
  }

  get currentLeaseCount(): number {
    return this.current.leaseCount;
  }

  retain(revision: string): void {
    const generation = this.generations.get(revision);
    if (!generation) {
      throw new PluginSystemError(
        'SNAPSHOT_GENERATION_MISSING',
        `Plugin snapshot generation ${revision} is unavailable`,
      );
    }
    generation.leaseCount += 1;
  }

  release(revision: string): void {
    const generation = this.generations.get(revision);
    if (!generation || generation.leaseCount <= 0) return;
    generation.leaseCount -= 1;
    this.tryCleanup(generation);
  }

  replace(revision: string, runtime: PluginMcpRuntimePort, finalize?: () => Promise<void>): void {
    const prior = this.current;
    this.current = this.create(revision, runtime);
    prior.retired = true;
    if (finalize) prior.finalizers.push(finalize);
    this.tryCleanup(prior);
  }

  replaceRevision(revision: string): void {
    this.generations.delete(this.current.revision);
    this.current = this.create(revision, this.current.runtime);
  }

  async dispose(): Promise<void> {
    for (const generation of this.generations.values()) {
      generation.retired = true;
      generation.leaseCount = 0;
      this.tryCleanup(generation);
    }
    await Promise.allSettled([...this.cleanupTasks]);
  }

  private create(revision: string, runtime: PluginMcpRuntimePort): PluginCapabilityGeneration {
    const generation: PluginCapabilityGeneration = {
      revision,
      runtime,
      finalizers: [],
      leaseCount: 0,
      retired: false,
    };
    this.generations.set(revision, generation);
    return generation;
  }

  private tryCleanup(generation: PluginCapabilityGeneration): void {
    if (!generation.retired || generation.leaseCount > 0 || generation.cleanupTask) return;
    const cleanup = this.cleanup(generation);
    generation.cleanupTask = cleanup;
    this.cleanupTasks.add(cleanup);
    settleInBackground(this.trackCleanup(cleanup));
  }

  private async trackCleanup(cleanup: Promise<void>): Promise<void> {
    try {
      await cleanup;
    } finally {
      this.cleanupTasks.delete(cleanup);
    }
  }

  private async cleanup(generation: PluginCapabilityGeneration): Promise<void> {
    await ignoreFailure(generation.runtime.close());
    for (const finalize of generation.finalizers) await ignoreFailure(finalize());
    if (this.generations.get(generation.revision) === generation) {
      this.generations.delete(generation.revision);
    }
  }
}
