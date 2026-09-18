import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  PluginInstallationPolicy,
  type PluginInstallationPolicy as PluginInstallationPolicyType,
} from '@mavis/protocol/local';

import { materializeOfficialPluginArchive } from '../package/archive-cache.js';
import { pluginDigestCacheKey } from '../package/package-contract.js';
import { readMiniMaxPlugin } from '../package/package-readers.js';
import type {
  CachedPluginPackage,
  OfficialPluginRepositoryState,
  PluginRepositoryScope,
  SqlitePluginRepository,
} from './repository.js';
import { effectiveInstallationPolicy } from './repository.js';
import type {
  PluginFullState,
  PluginPackageVersion,
  PluginRegistryClient,
} from './registry-client.js';

export interface OfficialPluginReconcilerOptions {
  readonly cacheRoot: string;
  readonly repository: SqlitePluginRepository;
  readonly client: PluginRegistryClient;
  readonly nowMs?: () => number;
}

export interface OfficialPluginMutationState {
  readonly pluginName: string;
  readonly installExists: boolean;
  readonly enabled: boolean;
  readonly installationPolicy: PluginInstallationPolicyType;
  readonly package?: PluginPackageVersion;
}

export interface PreparedOfficialPluginReconciliation {
  readonly state: OfficialPluginRepositoryState;
  readonly changed: boolean;
  readonly incomplete: boolean;
  readonly failedPackageCount: number;
  commit(): boolean;
  rollback(): void;
  abort(): Promise<void>;
  finalize(): Promise<void>;
}

/** Owns full and target-only reconciliation of the persisted official state. */
export class OfficialPluginReconciler {
  private readonly nowMs: () => number;
  private readonly activeCacheClaims = new Map<string, number>();
  private readonly pendingCacheCleanup = new Set<string>();
  private cacheCoordinationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: OfficialPluginReconcilerOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  async reconcile(
    scope: PluginRepositoryScope,
    shouldCommit: () => boolean = () => true,
  ): Promise<boolean> {
    const prepared = await this.prepareReconcile(scope, shouldCommit);
    if (!prepared.commit()) {
      await prepared.abort();
      return false;
    }
    await prepared.finalize();
    return prepared.changed;
  }

  async prepareReconcile(
    scope: PluginRepositoryScope,
    shouldCommit: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<PreparedOfficialPluginReconciliation> {
    const fullState = normalizeFullState(await this.options.client.getFullState(signal));
    const previous = loadPrevious(this.options.repository, scope);
    const prepared = new Map<string, CachedPluginPackage>();
    const claimedCacheKeys = new Set<string>();
    const materializedCacheKeys = new Set<string>();
    const failedPackageNames = new Set<string>();
    let repaired = false;
    try {
      for (const packageVersion of fullState.effectivePlugins) {
        const cached = await this.tryPrepareClaimedPackage(packageVersion, signal);
        if (!cached) {
          failedPackageNames.add(packageVersion.name);
          continue;
        }
        prepared.set(packageVersion.name, cached.package);
        for (const cacheKey of cached.claims) claimedCacheKeys.add(cacheKey);
        for (const cacheKey of cached.materialized) materializedCacheKeys.add(cacheKey);
        repaired ||= cached.repaired;
      }
    } catch (error) {
      await this.releaseCacheClaims(claimedCacheKeys, materializedCacheKeys);
      throw error;
    }
    const next = buildRepositoryState({
      fullState,
      previous,
      prepared,
      failedPackageNames,
      nowMs: this.nowMs(),
    });
    const durableChanged = durableState(next) !== durableState(previous);
    return preparedReconciliation({
      repository: this.options.repository,
      scope,
      state: next,
      previous,
      changed: durableChanged || repaired,
      incomplete: failedPackageNames.size > 0,
      failedPackageCount: failedPackageNames.size,
      durableChanged,
      shouldCommit,
      claimedCacheKeys,
      materializedCacheKeys,
      releaseCacheClaims: (claims, cleanup) => this.releaseCacheClaims(claims, cleanup),
    });
  }

  async reconcileMutation(
    scope: PluginRepositoryScope,
    mutation: OfficialPluginMutationState,
    shouldCommit: () => boolean = () => true,
  ): Promise<boolean> {
    const prepared = await this.prepareMutation(scope, mutation, shouldCommit);
    if (!prepared.commit()) {
      await prepared.abort();
      return false;
    }
    await prepared.finalize();
    return prepared.changed;
  }

  async prepareMutation(
    scope: PluginRepositoryScope,
    mutation: OfficialPluginMutationState,
    shouldCommit: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<PreparedOfficialPluginReconciliation> {
    const previous = loadPrevious(this.options.repository, scope);
    const byName = new Map(previous?.installations.map((item) => [item.name, item]) ?? []);
    const claimedCacheKeys = new Set<string>();
    const materializedCacheKeys = new Set<string>();
    try {
      if (!mutation.installExists) {
        byName.delete(mutation.pluginName);
      } else {
        if (!mutation.package || mutation.package.name !== mutation.pluginName) {
          throw new Error('installed Plugin mutation is missing its current package');
        }
        const prior = byName.get(mutation.pluginName);
        const prepared = mutation.enabled
          ? await this.prepareClaimedPackage(
              mutation.package,
              claimedCacheKeys,
              materializedCacheKeys,
              signal,
            )
          : undefined;
        byName.set(mutation.pluginName, {
          name: mutation.pluginName,
          installed: true,
          enabled: mutation.enabled,
          installationPolicy: mutation.installationPolicy,
          package: { ...mutation.package },
          cachedPackages: mergeCachedPackages(
            prepared?.package ?? currentCachedPackage(prior, mutation.package),
          ),
        });
      }
    } catch (error) {
      await this.releaseCacheClaims(claimedCacheKeys, materializedCacheKeys);
      throw error;
    }
    const next = buildMutationRepositoryState([...byName.values()], previous, this.nowMs());
    const durableChanged = durableState(next) !== durableState(previous);
    return preparedReconciliation({
      repository: this.options.repository,
      scope,
      state: next,
      previous,
      changed: durableChanged,
      incomplete: false,
      failedPackageCount: 0,
      durableChanged,
      shouldCommit,
      claimedCacheKeys,
      materializedCacheKeys,
      releaseCacheClaims: (claims, cleanup) => this.releaseCacheClaims(claims, cleanup),
    });
  }

  private async prepareClaimedPackage(
    packageVersion: PluginPackageVersion,
    claimedCacheKeys: Set<string>,
    materializedCacheKeys: Set<string>,
    signal?: AbortSignal,
  ): Promise<{ package: CachedPluginPackage; repaired: boolean }> {
    const cacheKey = pluginDigestCacheKey(packageVersion.contentDigest);
    if (!claimedCacheKeys.has(cacheKey)) {
      await this.claimCache(cacheKey);
      claimedCacheKeys.add(cacheKey);
    }
    const prepared = await this.preparePackage(packageVersion, signal);
    if (prepared.repaired) materializedCacheKeys.add(prepared.package.cacheKey);
    return prepared;
  }

  private async tryPrepareClaimedPackage(
    packageVersion: PluginPackageVersion,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly package: CachedPluginPackage;
        readonly repaired: boolean;
        readonly claims: ReadonlySet<string>;
        readonly materialized: ReadonlySet<string>;
      }
    | undefined
  > {
    const claims = new Set<string>();
    const materialized = new Set<string>();
    try {
      const prepared = await this.prepareClaimedPackage(
        packageVersion,
        claims,
        materialized,
        signal,
      );
      return { ...prepared, claims, materialized };
    } catch {
      await this.releaseCacheClaims(claims, materialized);
      signal?.throwIfAborted();
      return undefined;
    }
  }

  private async preparePackage(
    packageVersion: PluginPackageVersion,
    signal?: AbortSignal,
  ): Promise<{ package: CachedPluginPackage; repaired: boolean }> {
    const cacheKey = pluginDigestCacheKey(packageVersion.contentDigest);
    const packageRoot = path.join(this.options.cacheRoot, cacheKey);
    if (await isUsableCachedPackage(packageRoot, packageVersion)) {
      return { package: cachedPackage(packageVersion, cacheKey), repaired: false };
    }

    const authorization = await this.options.client.authorizeDownload(
      packageVersion.name,
      packageVersion.version,
      signal,
    );
    assertSamePackage(packageVersion, authorization.package);
    await mkdir(this.options.cacheRoot, { recursive: true });
    const tempRoot = await mkdtemp(path.join(this.options.cacheRoot, '.download-'));
    const archivePath = path.join(tempRoot, 'package.zip');
    try {
      await this.options.client.downloadToFile(authorization.downloadUrl, archivePath, signal);
      // A digest path may exist but fail validation after a truncated write or
      // local corruption. Repair that immutable slot before materialization.
      if (!(await isUsableCachedPackage(packageRoot, packageVersion))) {
        await rm(packageRoot, { recursive: true, force: true });
      }
      const materialized = await materializeOfficialPluginArchive({
        archivePath,
        cacheRoot: this.options.cacheRoot,
        expectedArchiveSha256: packageVersion.archiveSha256,
        expectedContentDigest: packageVersion.contentDigest,
        signal,
      });
      if (!(await isUsableCachedPackage(materialized.packageRoot, packageVersion))) {
        throw new Error('materialized Plugin package identity does not match full-state');
      }
      return { package: cachedPackage(packageVersion, materialized.cacheKey), repaired: true };
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  private claimCache(cacheKey: string): Promise<void> {
    return this.coordinateCacheCleanup(() => {
      this.activeCacheClaims.set(cacheKey, (this.activeCacheClaims.get(cacheKey) ?? 0) + 1);
    });
  }

  private releaseCacheClaims(
    claims: ReadonlySet<string>,
    cleanupCandidates: ReadonlySet<string>,
  ): Promise<void> {
    return this.coordinateCacheCleanup(async () => {
      for (const cacheKey of cleanupCandidates) this.pendingCacheCleanup.add(cacheKey);
      for (const cacheKey of claims) {
        const count = this.activeCacheClaims.get(cacheKey) ?? 0;
        if (count <= 1) this.activeCacheClaims.delete(cacheKey);
        else this.activeCacheClaims.set(cacheKey, count - 1);
      }
      const removable = new Set(
        [...this.pendingCacheCleanup].filter((cacheKey) => !this.activeCacheClaims.has(cacheKey)),
      );
      for (const cacheKey of removable) this.pendingCacheCleanup.delete(cacheKey);
      await pruneUnreferencedPluginCaches(
        this.options.cacheRoot,
        this.options.repository,
        removable,
      );
    });
  }

  private coordinateCacheCleanup<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = runAfterCacheCoordination(this.cacheCoordinationTail, operation);
    this.cacheCoordinationTail = settleCacheCoordination(result);
    return result;
  }
}

async function runAfterCacheCoordination<T>(
  prior: Promise<void>,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    await prior;
  } catch {
    // A failed cleanup must not poison later cache ownership changes.
  }
  return operation();
}

async function settleCacheCoordination(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {
    // The caller observes the failure while the coordination tail stays usable.
  }
}

function preparedReconciliation(input: {
  readonly repository: SqlitePluginRepository;
  readonly scope: PluginRepositoryScope;
  readonly state: OfficialPluginRepositoryState;
  readonly previous?: OfficialPluginRepositoryState;
  readonly changed: boolean;
  readonly incomplete: boolean;
  readonly failedPackageCount: number;
  readonly durableChanged: boolean;
  readonly shouldCommit: () => boolean;
  readonly claimedCacheKeys: ReadonlySet<string>;
  readonly materializedCacheKeys: ReadonlySet<string>;
  readonly releaseCacheClaims: (
    claims: ReadonlySet<string>,
    cleanupCandidates: ReadonlySet<string>,
  ) => Promise<void>;
}): PreparedOfficialPluginReconciliation {
  let committed = false;
  let finalized = false;
  let released = false;
  const obsoleteCacheKeys = discardedCacheKeys(input.previous, input.state);
  const release = async (cleanupCandidates: ReadonlySet<string>) => {
    if (released) return;
    released = true;
    await input.releaseCacheClaims(input.claimedCacheKeys, cleanupCandidates);
  };
  return {
    state: input.state,
    changed: input.changed,
    incomplete: input.incomplete,
    failedPackageCount: input.failedPackageCount,
    commit: () => {
      if (committed || !input.shouldCommit()) return false;
      committed = true;
      if (input.durableChanged) {
        input.repository.saveOfficialState(input.scope, input.state);
      }
      return true;
    },
    rollback: () => {
      if (!committed || !input.durableChanged) return;
      committed = false;
      if (input.previous) input.repository.saveOfficialState(input.scope, input.previous);
      else input.repository.deleteOfficialState(input.scope);
    },
    abort: async () => {
      if (committed) return;
      await release(input.materializedCacheKeys);
    },
    finalize: async () => {
      if (!committed || finalized) return;
      finalized = true;
      await release(obsoleteCacheKeys);
    },
  };
}

function normalizeFullState(fullState: PluginFullState): PluginFullState {
  const installations = [...fullState.installations].sort((left, right) =>
    normalizedName(left.package.name).localeCompare(normalizedName(right.package.name)),
  );
  const effectivePlugins = [...fullState.effectivePlugins].sort((left, right) =>
    normalizedName(left.name).localeCompare(normalizedName(right.name)),
  );
  assertUnique(
    installations.map((item) => item.package.name),
    'installation',
  );
  assertUnique(
    effectivePlugins.map((item) => item.name),
    'effective Plugin',
  );
  const installed = new Map(installations.map((item) => [normalizedName(item.package.name), item]));
  for (const item of effectivePlugins) {
    const installation = installed.get(normalizedName(item.name));
    if (!installation?.enabled || !samePackage(installation.package, item)) {
      throw new Error('effective Plugin is not an enabled current installation');
    }
  }
  return { runtimeEnabled: fullState.runtimeEnabled, installations, effectivePlugins };
}

function buildRepositoryState(input: {
  readonly fullState: PluginFullState;
  readonly previous: OfficialPluginRepositoryState | undefined;
  readonly prepared: ReadonlyMap<string, CachedPluginPackage>;
  readonly failedPackageNames: ReadonlySet<string>;
  readonly nowMs: number;
}): OfficialPluginRepositoryState {
  const { failedPackageNames, fullState, nowMs, prepared, previous } = input;
  const previousByName = new Map(previous?.installations.map((item) => [item.name, item]) ?? []);
  const installations = fullState.installations.map((item) => {
    const prior = previousByName.get(item.package.name);
    const current = prepared.get(item.package.name) ?? currentCachedPackage(prior, item.package);
    const cachedPackages = failedPackageNames.has(item.package.name)
      ? [...(prior?.cachedPackages ?? [])]
      : mergeCachedPackages(current);
    return {
      name: item.package.name,
      installed: true,
      enabled: item.enabled,
      installationPolicy: item.installationPolicy ?? PluginInstallationPolicy.USER_MANAGED,
      package: { ...item.package },
      cachedPackages,
    };
  });
  const fullStateJson = {
    runtimeEnabled: fullState.runtimeEnabled,
    installations: fullState.installations.map((item) => ({
      package: { ...item.package },
      enabled: item.enabled,
      installationPolicy: item.installationPolicy ?? PluginInstallationPolicy.USER_MANAGED,
      ...(item.updatedAtMs === undefined ? {} : { updatedAtMs: item.updatedAtMs }),
    })),
    effectivePlugins: fullState.effectivePlugins.map((item) => ({ ...item })),
  };
  const packageContentDigests = fullState.effectivePlugins.flatMap((item) =>
    prepared.has(item.name) ? [item.contentDigest] : [],
  );
  const snapshotIdentity = { fullState: fullStateJson, packageContentDigests };
  const lastSuccessfulFullState =
    failedPackageNames.size === 0 ? fullStateJson : previous?.lastSuccessfulFullState;
  return {
    schemaVersion: 1,
    installations,
    ...(lastSuccessfulFullState === undefined ? {} : { lastSuccessfulFullState }),
    currentSnapshot: {
      revision: `full-state-${sha256(JSON.stringify(snapshotIdentity))}`,
      publishedAtMs: nowMs,
      packageContentDigests,
    },
  };
}

function buildMutationRepositoryState(
  installationsInput: readonly OfficialPluginRepositoryState['installations'][number][],
  previous: OfficialPluginRepositoryState | undefined,
  nowMs: number,
): OfficialPluginRepositoryState {
  const installations = [...installationsInput]
    .sort((left, right) => normalizedName(left.name).localeCompare(normalizedName(right.name)))
    .map((installation) => ({
      ...installation,
      installationPolicy: effectiveInstallationPolicy(installation),
    }));
  const previousDigests = new Set(previous?.currentSnapshot?.packageContentDigests ?? []);
  const packageContentDigests = installations.flatMap((installation) => {
    if (!installation.installed || !installation.enabled) return [];
    if (installation.package) {
      const cached = currentCachedPackage(installation, installation.package);
      return cached ? [cached.contentDigest] : [];
    }
    return installation.cachedPackages
      .filter((item) => previousDigests.has(item.contentDigest))
      .map((item) => item.contentDigest);
  });
  const fullStateJson = {
    runtimeEnabled: true,
    installations: installations.flatMap((installation) =>
      installation.package
        ? [
            {
              package: { ...installation.package },
              enabled: installation.enabled,
              installationPolicy: effectiveInstallationPolicy(installation),
            },
          ]
        : [],
    ),
    effectivePlugins: installations.flatMap((installation) =>
      installation.enabled && installation.package ? [{ ...installation.package }] : [],
    ),
  };
  return {
    schemaVersion: 1,
    installations,
    lastSuccessfulFullState: fullStateJson,
    currentSnapshot: {
      revision: `target-state-${sha256(JSON.stringify(fullStateJson))}`,
      publishedAtMs: nowMs,
      packageContentDigests,
    },
  };
}

function mergeCachedPackages(current: CachedPluginPackage | undefined): CachedPluginPackage[] {
  return current ? [current] : [];
}

function discardedCacheKeys(
  previous: OfficialPluginRepositoryState | undefined,
  current: OfficialPluginRepositoryState,
): ReadonlySet<string> {
  const retained = new Set(
    current.installations.flatMap((item) => item.cachedPackages.map((cached) => cached.cacheKey)),
  );
  return new Set(
    (previous?.installations ?? []).flatMap((item) =>
      item.cachedPackages.flatMap((cached) =>
        retained.has(cached.cacheKey) ? [] : [cached.cacheKey],
      ),
    ),
  );
}

async function pruneUnreferencedPluginCaches(
  cacheRoot: string,
  repository: SqlitePluginRepository,
  candidates: ReadonlySet<string>,
): Promise<void> {
  if (candidates.size === 0) return;
  let referenced: ReadonlySet<string>;
  try {
    referenced = repository.listReferencedOfficialCacheKeys();
  } catch {
    // A corrupt row must never authorize deleting a cache still referenced by
    // another identity/deployment. Keep everything and let state loading
    // surface the corruption through its normal fail-closed path.
    return;
  }
  await Promise.allSettled(
    [...candidates].flatMap((cacheKey) =>
      !referenced.has(cacheKey)
        ? [rm(path.join(cacheRoot, cacheKey), { recursive: true, force: true })]
        : [],
    ),
  );
}

async function isUsableCachedPackage(
  packageRoot: string,
  expected: PluginPackageVersion,
): Promise<boolean> {
  try {
    await access(packageRoot);
    const plugin = await readMiniMaxPlugin(packageRoot, { source: 'OFFICIAL' });
    return plugin.name === expected.name && plugin.version === expected.version;
  } catch {
    return false;
  }
}

function currentCachedPackage(
  installation: OfficialPluginRepositoryState['installations'][number] | undefined,
  expected: PluginPackageVersion,
): CachedPluginPackage | undefined {
  return installation?.cachedPackages.find(
    (item) =>
      item.name === expected.name &&
      item.version === expected.version &&
      item.archiveSha256 === expected.archiveSha256 &&
      item.contentDigest === expected.contentDigest,
  );
}

function cachedPackage(
  packageVersion: PluginPackageVersion,
  cacheKey: string,
): CachedPluginPackage {
  return {
    name: packageVersion.name,
    version: packageVersion.version,
    archiveSha256: packageVersion.archiveSha256,
    contentDigest: packageVersion.contentDigest,
    cacheKey,
  };
}

function assertSamePackage(expected: PluginPackageVersion, actual: PluginPackageVersion): void {
  if (!samePackage(expected, actual)) {
    throw new Error('download authorization package does not match full-state');
  }
}

function samePackage(left: PluginPackageVersion, right: PluginPackageVersion): boolean {
  return (
    left.name === right.name &&
    left.version === right.version &&
    left.archiveSha256 === right.archiveSha256 &&
    left.contentDigest === right.contentDigest
  );
}

function loadPrevious(
  repository: SqlitePluginRepository,
  scope: PluginRepositoryScope,
): OfficialPluginRepositoryState | undefined {
  try {
    return repository.loadOfficialState(scope);
  } catch {
    return undefined;
  }
}

function durableState(state: OfficialPluginRepositoryState | undefined): string {
  if (!state) return '';
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    installations: state.installations,
    lastSuccessfulFullState: state.lastSuccessfulFullState,
    packageContentDigests: state.currentSnapshot?.packageContentDigests ?? [],
    revision: state.currentSnapshot?.revision ?? '',
  });
}

function assertUnique(values: readonly string[], label: string): void {
  const keys = values.map(normalizedName);
  if (new Set(keys).size !== keys.length) throw new Error(`duplicate ${label} name`);
}

function normalizedName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
