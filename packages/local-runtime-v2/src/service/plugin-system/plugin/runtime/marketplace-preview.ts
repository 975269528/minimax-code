import type { PluginSnapshotBuildInputs, PluginSnapshotBuildOptions } from '../../contracts.js';
import { scopeKey as pluginScopeKey } from '../../plugin-system-helpers.js';
import type { PluginRepositoryScope } from './repository.js';
import { buildPluginMarketplaceSnapshot } from './snapshot-inputs.js';
import type { PluginSnapshot, PluginSnapshotBuilder } from './snapshot-builder.js';

/** Coalesces one local scan and reuses it for the page's search/filter/pagination requests. */
export class MarketplacePreviewCache {
  private preview: { readonly scopeKey: string; readonly snapshot: PluginSnapshot } | undefined;
  private lastGood: { readonly scopeKey: string; readonly snapshot: PluginSnapshot } | undefined;
  private task:
    | {
        readonly scopeKey: string;
        readonly generation: number;
        readonly promise: Promise<PluginSnapshot>;
      }
    | undefined;
  private generation = 0;

  invalidate(): void {
    this.generation += 1;
    this.preview = undefined;
  }

  lastGoodSnapshot(scopeKey: string): PluginSnapshot | undefined {
    return this.lastGood?.scopeKey === scopeKey ? this.lastGood.snapshot : undefined;
  }

  async read(
    scopeKey: string,
    reuseCached: boolean,
    build: () => Promise<PluginSnapshot>,
  ): Promise<PluginSnapshot> {
    if (reuseCached && this.preview?.scopeKey === scopeKey) return this.preview.snapshot;
    const generation = this.generation;
    if (this.task?.scopeKey === scopeKey && this.task.generation === generation) {
      return this.task.promise;
    }
    const promise = build();
    this.task = { scopeKey, generation, promise };
    try {
      const snapshot = await promise;
      if (this.generation !== generation) {
        return this.read(scopeKey, true, build);
      }
      this.preview = { scopeKey, snapshot };
      this.lastGood = { scopeKey, snapshot };
      return snapshot;
    } finally {
      if (this.task?.promise === promise) this.task = undefined;
    }
  }
}

/** Owns the read-only Marketplace projection without widening PluginSystem's publication API. */
export class PluginMarketplacePreview {
  constructor(
    private readonly options: {
      readonly cache: MarketplacePreviewCache;
      readonly initialize: () => Promise<void>;
      readonly assertUsable: () => void;
      readonly readScope: () => PluginRepositoryScope | undefined;
      readonly desiredScopeKey: () => string;
      readonly activateScopeBoundary: (scope: PluginRepositoryScope | undefined) => void;
      readonly scheduleCachedRestore: () => void;
      readonly currentSnapshot: () => PluginSnapshot;
      readonly desiredSnapshot: () => PluginSnapshot;
      readonly readSnapshotBuildInputs: (
        scope: PluginRepositoryScope | undefined,
        desiredSnapshot: PluginSnapshot,
      ) => Promise<PluginSnapshotBuildInputs>;
      readonly builder: PluginSnapshotBuilder;
      readonly isLocalEnabled: (root: string) => boolean;
      readonly recordBuildContext: (
        snapshot: PluginSnapshot,
        context: {
          readonly input: PluginSnapshotBuildInputs;
          readonly options: PluginSnapshotBuildOptions;
        },
      ) => void;
    },
  ) {}

  invalidate(): void {
    this.options.cache.invalidate();
  }

  async read(options: { readonly reuseCached?: boolean } = {}): Promise<PluginSnapshot> {
    await this.options.initialize();
    this.options.assertUsable();
    const scope = this.options.readScope();
    if (pluginScopeKey(scope) !== this.options.desiredScopeKey()) {
      this.options.activateScopeBoundary(scope);
      this.options.scheduleCachedRestore();
    }
    const requestedScopeKey = pluginScopeKey(scope);
    const snapshot = await this.options.cache.read(
      requestedScopeKey,
      options.reuseCached === true,
      () => this.build(scope, requestedScopeKey),
    );
    return pluginScopeKey(scope) === this.options.desiredScopeKey()
      ? snapshot
      : this.options.currentSnapshot();
  }

  buildFromInputs(input: PluginSnapshotBuildInputs): PluginSnapshot {
    const snapshot = buildPluginMarketplaceSnapshot({
      builder: this.options.builder,
      revision: this.options.currentSnapshot().revision,
      snapshotInputs: input,
      isLocalEnabled: this.options.isLocalEnabled,
    });
    this.options.recordBuildContext(snapshot, { input, options: {} });
    return snapshot;
  }

  private async build(
    scope: PluginRepositoryScope | undefined,
    requestedScopeKey: string,
  ): Promise<PluginSnapshot> {
    const input = await this.options.readSnapshotBuildInputs(
      scope,
      this.options.cache.lastGoodSnapshot(requestedScopeKey) ?? this.options.desiredSnapshot(),
    );
    return this.buildFromInputs(input);
  }
}
