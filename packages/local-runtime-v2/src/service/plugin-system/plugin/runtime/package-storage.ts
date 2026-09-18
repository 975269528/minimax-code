import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import lockfile from 'proper-lockfile';

import { PluginSystemError } from '../../errors.js';
import {
  findEnabledCachedPackage,
  normalizedPluginName,
  settleInBackground,
} from '../../plugin-system-helpers.js';
import {
  computeMiniAppPackageDigests,
  computePluginDirectoryDigest,
  pluginDigestCacheKey,
} from '../package/package-contract.js';
import { readMiniMaxPlugin, scanLocalPluginPackages } from '../package/package-readers.js';
import type {
  ReadPluginPackage,
  RuntimeEligibleScannedReadPluginPackage,
  ScannedReadPluginPackage,
} from '../package/types.js';
import {
  type StagedWorkspaceMiniAppCandidate,
  WorkspaceMiniAppStorage,
} from './miniapp/workspace-storage.js';
import type { WorkspaceMiniAppInitializationResult } from '../../contracts.js';
import type {
  OfficialPluginInstallationRecord,
  OfficialPluginRepositoryState,
  PluginRepositoryScope,
  SqlitePluginRepository,
} from './repository.js';

interface PluginPackageStorageMetrics {
  localScan(
    status: 'success' | 'partial' | 'error',
    startedAt: number,
    packageCount?: number,
    diagnosticCount?: number,
  ): void;
}

export interface PluginPackageSnapshotEntry {
  readonly plugin: RuntimeEligibleScannedReadPluginPackage;
  readonly contentDigest: string;
}

export interface LocalPluginPackageSnapshotEntry {
  readonly plugin: ScannedReadPluginPackage;
  readonly contentDigest: string;
}

export interface StagedLocalPluginRoot {
  readonly restore: () => Promise<void>;
  readonly discard: () => Promise<void>;
}

export interface AcceptedLocalPluginRoot {
  readonly rootPath: string;
  readonly restore: () => Promise<void>;
}

export type { StagedWorkspaceMiniAppCandidate } from './miniapp/workspace-storage.js';

interface PluginPackageStorageOptions {
  readonly dataDir: string;
  readonly officialCacheRoot: string;
  readonly repository: SqlitePluginRepository;
  readonly metrics: PluginPackageStorageMetrics;
  /** @internal Direct-module test seam. */
  readonly hookCacheTtlMs?: number;
  /** @internal Direct-module test seam. */
  readonly hookCacheMaxBytes?: number;
  /** @internal Direct-module test seam. */
  readonly hookCacheNow?: () => number;
  /** @internal Direct-module test seam. */
  readonly hookCacheIsProcessAlive?: (pid: number) => boolean;
}

/**
 * Hook roots are immutable and content-addressed. Returned Hook handler objects
 * retain a per-process, cross-process-visible lease for as long as a snapshot,
 * active turn, or SessionEnd generation can still reference them. GC removes
 * dead-PID markers, then applies a bounded TTL and byte quota only to roots with
 * no live lease; it never follows symbolic links or ambiguous temporary roots.
 */
const hookCacheStartupTasks = new Map<string, Promise<string>>();
const hookPackageMaterializationTasks = new Map<string, Promise<string>>();
const hookPackageReadOnlyTasks = new Map<string, Promise<void>>();
const hookCacheGcTasks = new Map<string, Promise<void>>();
const hookPackageLeaseOwner = Symbol('hookPackageLeaseOwner');
const hookProcessInstanceId = randomUUID();
const hookProcessLeaseStates = new Map<string, HookProcessLeaseState>();
const hookLeaseFinalizer = new FinalizationRegistry<HookProcessLeaseState>((state) => {
  settleInBackground(releaseHookProcessLease(state));
});

const DEFAULT_HOOK_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_HOOK_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const HOOK_CACHE_LOCK_STALE_MS = 30_000;
const HOOK_CACHE_KEY = /^sha256-tree-v1-[0-9a-f]{64}$/;
const OWNED_TEMPORARY_ROOT = /^\.tmp-([1-9]\d*)-[0-9a-f-]+-/;

interface HookProcessLeaseState {
  readonly key: string;
  readonly cacheRoot: string;
  readonly cacheKey: string;
  readonly markerPath: string;
  readonly ready: Promise<void>;
  referenceCount: number;
}

interface HookPackageLease {
  readonly owner: object;
  readonly release: () => Promise<void>;
}

interface HookCacheGcEntry {
  readonly name: string;
  readonly rootPath: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly leased: boolean;
  readonly safeToDelete: boolean;
}

/** Owns Plugin package discovery, cache restore, and local uninstall staging. */
export class PluginPackageStorage {
  private readonly officialPackageReads = new Map<string, Promise<ReadPluginPackage | undefined>>();
  private readonly workspaceMiniAppStorage: WorkspaceMiniAppStorage;

  constructor(private readonly options: PluginPackageStorageOptions) {
    this.workspaceMiniAppStorage = new WorkspaceMiniAppStorage(options.dataDir, {
      stageAccepted: (canonicalRoot) => this.stageAcceptedLocalRoot(canonicalRoot),
      acceptImported: (stagingRoot, pluginName) =>
        this.acceptImportedLocalRoot(stagingRoot, pluginName),
    });
  }

  async scanLocalPackages(): Promise<readonly LocalPluginPackageSnapshotEntry[]> {
    const startedAt = Date.now();
    try {
      const scan = await scanLocalPluginPackages(path.join(this.options.dataDir, 'plugins'));
      const materialized = await Promise.allSettled(
        scan.plugins.map((entry) => this.materializeHookPackage(entry)),
      );
      const plugins = materialized.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      await this.collectHookCacheGarbage();
      const diagnosticCount =
        scan.diagnostics.length +
        materialized.filter((result) => result.status === 'rejected').length;
      const status = diagnosticCount > 0 ? 'partial' : 'success';
      this.options.metrics.localScan(status, startedAt, plugins.length, diagnosticCount);
      return plugins;
    } catch (error) {
      this.options.metrics.localScan('error', startedAt);
      throw error;
    }
  }

  async readLocalMiniAppPackageRoot(packageRoot: string): Promise<LocalPluginPackageSnapshotEntry> {
    return this.workspaceMiniAppStorage.readPackageRoot(packageRoot);
  }

  async materializeMiniAppRuntimePackage(input: {
    readonly sourceRoot: string;
    readonly targetRoot: string;
  }): Promise<void> {
    await this.workspaceMiniAppStorage.materializeRuntimePackage(input);
  }

  async initializeWorkspaceMiniApp(input: {
    readonly workspaceRoot: string;
    readonly pluginId: string;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceMiniAppInitializationResult> {
    return this.workspaceMiniAppStorage.initialize(input);
  }

  async restoreOfficialPackages(
    scope: PluginRepositoryScope | undefined,
  ): Promise<readonly PluginPackageSnapshotEntry[]> {
    if (!scope) return [];
    let state: OfficialPluginRepositoryState | undefined;
    try {
      state = this.options.repository.loadOfficialState(scope);
    } catch {
      return [];
    }
    return state ? this.restoreOfficialPackagesFromState(state) : [];
  }

  async restoreOfficialPackagesFromState(
    state: OfficialPluginRepositoryState,
  ): Promise<readonly PluginPackageSnapshotEntry[]> {
    if (!state.currentSnapshot) return [];
    const installations = new Map(state.installations.map((item) => [item.name, item]));
    const restored: PluginPackageSnapshotEntry[] = [];
    for (const contentDigest of state.currentSnapshot.packageContentDigests) {
      const cached = findEnabledCachedPackage(installations, contentDigest);
      if (!cached) continue;
      const packageRoot = path.join(this.options.officialCacheRoot, cached.cacheKey);
      try {
        const plugin = await this.readOfficialPackage(packageRoot);
        if (!plugin || plugin.name !== cached.name || plugin.version !== cached.version) continue;
        restored.push(
          await this.materializeHookPackage({ plugin, contentDigest: cached.contentDigest }),
        );
      } catch {
        // Offline restore is per-package fail-closed; other cached packages and
        // custom Plugins remain available.
      }
    }
    await this.collectHookCacheGarbage();
    return restored;
  }

  async readCurrentOfficialPlugin(
    installation: OfficialPluginInstallationRecord,
  ): Promise<ReadPluginPackage | undefined> {
    const current = installation.package;
    const cached =
      (current
        ? installation.cachedPackages.find(
            (item) =>
              item.version === current.version &&
              item.archiveSha256 === current.archiveSha256 &&
              item.contentDigest === current.contentDigest,
          )
        : undefined) ?? installation.cachedPackages.at(-1);
    if (!cached) return undefined;
    const existing = this.officialPackageReads.get(cached.contentDigest);
    const read =
      existing ??
      this.readOfficialPackage(path.join(this.options.officialCacheRoot, cached.cacheKey));
    if (!existing) this.officialPackageReads.set(cached.contentDigest, read);
    const plugin = await read;
    if (!plugin) this.officialPackageReads.delete(cached.contentDigest);
    return plugin && normalizedPluginName(plugin.name) === normalizedPluginName(installation.name)
      ? plugin
      : undefined;
  }

  private async readOfficialPackage(
    packageRoot: string,
  ): Promise<RuntimeEligibleScannedReadPluginPackage | undefined> {
    try {
      const { miniapp, ...plugin } = await readMiniMaxPlugin(packageRoot, { source: 'OFFICIAL' });
      if (!miniapp) return plugin;
      const digests = await computeMiniAppPackageDigests(plugin.rootPath, miniapp.artifacts, {
        rejectHardlinks: true,
      });
      return {
        ...plugin,
        miniapp: {
          ...miniapp,
          contentDigest: digests.contentDigest,
          clientDigest: digests.clientDigest,
          nodeDigest: digests.nodeDigest,
        },
      };
    } catch {
      return undefined;
    }
  }

  private async materializeHookPackage(
    entry: LocalPluginPackageSnapshotEntry,
  ): Promise<LocalPluginPackageSnapshotEntry>;
  private async materializeHookPackage(
    entry: PluginPackageSnapshotEntry,
  ): Promise<PluginPackageSnapshotEntry>;
  private async materializeHookPackage(
    entry: PluginPackageSnapshotEntry,
  ): Promise<PluginPackageSnapshotEntry> {
    if (!entry.plugin.hooks?.length) return entry;
    let lease: HookPackageLease | undefined;
    try {
      const cacheRoot = await this.initializeHookCache();
      const cacheKey = pluginDigestCacheKey(entry.contentDigest);
      lease = await acquireHookPackageLease(cacheRoot, cacheKey);
      const taskKey = `${cacheRoot}\0${cacheKey}`;
      const existing = hookPackageMaterializationTasks.get(taskKey);
      const materialization =
        existing ?? this.ensureHookPackage(path.join(cacheRoot, cacheKey), cacheRoot, entry);
      if (!existing) hookPackageMaterializationTasks.set(taskKey, materialization);
      let immutableRoot: string;
      try {
        immutableRoot = await materialization;
      } finally {
        if (hookPackageMaterializationTasks.get(taskKey) === materialization) {
          hookPackageMaterializationTasks.delete(taskKey);
        }
      }
      await ensureReadOnlyHookPackage(immutableRoot);
      await touchHookCacheRoot(immutableRoot);
      const hooks = await Promise.all(
        entry.plugin.hooks.map(async (handler) => {
          const pluginDataDir = path.join(
            await realpath(this.options.dataDir),
            'v2',
            'plugin-data',
            'hooks',
            normalizedPluginName(entry.plugin.name),
          );
          await mkdir(pluginDataDir, { recursive: true, mode: 0o700 });
          const leasedHandler = {
            ...handler,
            pluginRoot: immutableRoot,
            pluginDataDir,
            activationKey: entry.contentDigest,
          };
          Object.defineProperty(leasedHandler, hookPackageLeaseOwner, {
            value: lease?.owner,
            enumerable: false,
          });
          return leasedHandler;
        }),
      );
      return {
        ...entry,
        plugin: {
          ...entry.plugin,
          hooks,
        },
      };
    } catch (error) {
      await lease?.release();
      if (error instanceof PluginSystemError && error.code === 'LOCAL_PLUGIN_CHANGED_DURING_SCAN') {
        throw error;
      }
      return {
        ...entry,
        plugin: {
          ...entry.plugin,
          hooks: [],
          diagnostics: [
            ...entry.plugin.diagnostics,
            { code: 'HOOK_MATERIALIZATION_FAILED', capability: 'HOOK' },
          ],
        },
      };
    }
  }

  private async ensureHookPackage(
    immutableRoot: string,
    cacheRoot: string,
    entry: PluginPackageSnapshotEntry,
  ): Promise<string> {
    if (!(await this.isValidHookCache(immutableRoot, entry))) {
      await rm(immutableRoot, { recursive: true, force: true });
      const stagingRoot = await mkdtemp(
        path.join(cacheRoot, `.tmp-${String(process.pid)}-${hookProcessInstanceId}-`),
      );
      await rmdir(stagingRoot);
      try {
        await cp(entry.plugin.rootPath, stagingRoot, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        const digest = await computePluginDirectoryDigest(stagingRoot, {
          pathPolicy: entry.plugin.manifestKind === 'MINIMAX' ? 'minimax-portable' : 'agent-plugin',
        });
        if (digest.contentDigest !== entry.contentDigest) {
          throw new PluginSystemError(
            'LOCAL_PLUGIN_CHANGED_DURING_SCAN',
            'local Plugin changed while its immutable Hook snapshot was materialized',
          );
        }
        await this.commitHookPackage(stagingRoot, immutableRoot, entry);
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    }
    return immutableRoot;
  }

  private async initializeHookCache(): Promise<string> {
    const physicalDataDir = await realpath(this.options.dataDir);
    const cacheRoot = path.join(physicalDataDir, 'v2', 'plugin-hook-cache');
    const existing = hookCacheStartupTasks.get(cacheRoot);
    if (existing) return existing;
    const initialization = (async () => {
      await ensureSafeDirectory(cacheRoot);
      await ensureSafeDirectory(path.join(cacheRoot, '.leases'));
      return cacheRoot;
    })();
    hookCacheStartupTasks.set(cacheRoot, initialization);
    try {
      return await initialization;
    } catch (error) {
      if (hookCacheStartupTasks.get(cacheRoot) === initialization) {
        hookCacheStartupTasks.delete(cacheRoot);
      }
      throw error;
    }
  }

  private async collectHookCacheGarbage(): Promise<void> {
    let cacheRoot: string;
    try {
      cacheRoot = await this.initializeHookCache();
    } catch {
      return;
    }
    const previous = hookCacheGcTasks.get(cacheRoot) ?? Promise.resolve();
    const collection = collectHookCacheGarbageAfter(previous, cacheRoot, {
      ttlMs: Math.max(0, this.options.hookCacheTtlMs ?? DEFAULT_HOOK_CACHE_TTL_MS),
      maxBytes: Math.max(0, this.options.hookCacheMaxBytes ?? DEFAULT_HOOK_CACHE_MAX_BYTES),
      now: this.options.hookCacheNow?.() ?? Date.now(),
      isProcessAlive: this.options.hookCacheIsProcessAlive ?? isProcessAlive,
    });
    hookCacheGcTasks.set(cacheRoot, collection);
    try {
      await collection;
    } catch {
      // GC is best-effort. Hook materialization remains protected by leases.
    } finally {
      if (hookCacheGcTasks.get(cacheRoot) === collection) hookCacheGcTasks.delete(cacheRoot);
    }
  }

  private async commitHookPackage(
    stagingRoot: string,
    immutableRoot: string,
    entry: PluginPackageSnapshotEntry,
  ): Promise<void> {
    try {
      await rename(stagingRoot, immutableRoot);
    } catch (error) {
      if (!(await this.isValidHookCache(immutableRoot, entry))) throw error;
    }
  }

  private async isValidHookCache(
    root: string,
    entry: PluginPackageSnapshotEntry,
  ): Promise<boolean> {
    try {
      const stat = await lstat(root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      const digest = await computePluginDirectoryDigest(root, {
        pathPolicy: entry.plugin.manifestKind === 'MINIMAX' ? 'minimax-portable' : 'agent-plugin',
      });
      return digest.contentDigest === entry.contentDigest;
    } catch {
      return false;
    }
  }

  async stageAcceptedLocalRoot(canonicalRoot: string): Promise<StagedLocalPluginRoot> {
    const pluginsRoot = await realpath(path.join(this.options.dataDir, 'plugins'));
    const target = await realpath(canonicalRoot);
    const stat = await lstat(canonicalRoot);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      target !== canonicalRoot ||
      path.dirname(target) !== pluginsRoot
    ) {
      throw new PluginSystemError(
        'LOCAL_DELETE_UNSAFE',
        'local Plugin root is not an accepted direct child',
      );
    }
    const quarantineRoot = path.join(
      path.dirname(this.options.officialCacheRoot),
      'uninstall-quarantine',
    );
    await mkdir(quarantineRoot, { recursive: true });
    const stagedRoot = await mkdtemp(path.join(quarantineRoot, 'local-plugin-'));
    await rmdir(stagedRoot);
    await rename(target, stagedRoot);
    let staged = true;
    return {
      restore: async () => {
        if (!staged) return;
        await rename(stagedRoot, target);
        staged = false;
      },
      discard: async () => {
        if (!staged) return;
        await rm(stagedRoot, { recursive: true, force: false });
        staged = false;
      },
    };
  }

  async acceptImportedLocalRoot(
    stagingRoot: string,
    pluginName: string,
  ): Promise<AcceptedLocalPluginRoot> {
    const pluginsRoot = path.join(this.options.dataDir, 'plugins');
    await mkdir(pluginsRoot, { recursive: true });
    const canonicalPluginsRoot = await realpath(pluginsRoot);
    const canonicalImportRoot = await realpath(
      path.join(this.options.dataDir, 'v2', 'plugin-import'),
    );
    const source = await realpath(stagingRoot);
    const sourceStat = await lstat(stagingRoot);
    if (
      sourceStat.isSymbolicLink() ||
      !sourceStat.isDirectory() ||
      !isWithin(canonicalImportRoot, source)
    ) {
      throw new PluginSystemError('LOCAL_IMPORT_UNSAFE', 'staged Plugin root is unsafe');
    }
    const target = path.join(canonicalPluginsRoot, pluginName);
    try {
      await lstat(target);
      throw new PluginSystemError('PLUGIN_ALREADY_EXISTS', 'local Plugin directory already exists');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await rename(source, target);
    let accepted = true;
    return {
      rootPath: target,
      restore: async () => {
        if (!accepted) return;
        await rename(target, source);
        accepted = false;
      },
    };
  }

  async stageWorkspaceMiniAppCandidate(input: {
    readonly workspaceRoot: string;
    readonly pluginId: string;
    readonly sourcePath?: string;
    readonly signal?: AbortSignal;
  }): Promise<StagedWorkspaceMiniAppCandidate> {
    return this.workspaceMiniAppStorage.stageCandidate(input);
  }
}

async function acquireHookPackageLease(
  cacheRoot: string,
  cacheKey: string,
): Promise<HookPackageLease> {
  const key = `${cacheRoot}\0${cacheKey}`;
  let state = hookProcessLeaseStates.get(key);
  if (!state) {
    const markerPath = path.join(
      cacheRoot,
      '.leases',
      cacheKey,
      `${String(process.pid)}-${hookProcessInstanceId}-${randomUUID()}.lease`,
    );
    state = {
      key,
      cacheRoot,
      cacheKey,
      markerPath,
      ready: createHookLeaseMarker(cacheRoot, cacheKey, markerPath),
      referenceCount: 0,
    };
    hookProcessLeaseStates.set(key, state);
  }
  state.referenceCount += 1;
  try {
    await state.ready;
  } catch (error) {
    await releaseHookProcessLease(state);
    throw error;
  }

  const owner = {};
  let released = false;
  hookLeaseFinalizer.register(owner, state, owner);
  return {
    owner,
    release: async () => {
      if (released) return;
      released = true;
      hookLeaseFinalizer.unregister(owner);
      await releaseHookProcessLease(state);
    },
  };
}

async function createHookLeaseMarker(
  cacheRoot: string,
  cacheKey: string,
  markerPath: string,
): Promise<void> {
  await withHookCacheLock(cacheRoot, async () => {
    await ensureSafeDirectory(path.join(cacheRoot, '.leases'));
    await ensureSafeDirectory(path.join(cacheRoot, '.leases', cacheKey));
    await writeFile(
      markerPath,
      JSON.stringify({ pid: process.pid, processInstanceId: hookProcessInstanceId }),
      { flag: 'wx', mode: 0o600 },
    );
  });
}

async function releaseHookProcessLease(state: HookProcessLeaseState): Promise<void> {
  if (state.referenceCount <= 0) return;
  state.referenceCount -= 1;
  if (state.referenceCount > 0) return;
  if (hookProcessLeaseStates.get(state.key) === state) hookProcessLeaseStates.delete(state.key);
  try {
    await state.ready;
    await withHookCacheLock(state.cacheRoot, async () => {
      await touchHookCacheRoot(path.join(state.cacheRoot, state.cacheKey));
      await rm(state.markerPath, { force: true });
      await removeEmptyDirectory(path.dirname(state.markerPath));
    });
  } catch {
    // A leaked marker is fail-safe and will be removed after this PID exits.
  }
}

async function collectHookCacheGarbageAfter(
  previous: Promise<void>,
  cacheRoot: string,
  options: {
    readonly ttlMs: number;
    readonly maxBytes: number;
    readonly now: number;
    readonly isProcessAlive: (pid: number) => boolean;
  },
): Promise<void> {
  try {
    await previous;
  } catch {
    // A previous best-effort collection must not block a later retry.
  }
  await collectHookCacheGarbage(cacheRoot, options);
}

async function collectHookCacheGarbage(
  cacheRoot: string,
  options: {
    readonly ttlMs: number;
    readonly maxBytes: number;
    readonly now: number;
    readonly isProcessAlive: (pid: number) => boolean;
  },
): Promise<void> {
  await withHookCacheLock(cacheRoot, async () => {
    const leasedCacheKeys = await collectLiveHookLeaseKeys(cacheRoot, options.isProcessAlive);
    const entries = await inspectHookCacheEntries(
      cacheRoot,
      leasedCacheKeys,
      options.isProcessAlive,
    );
    let totalBytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
    const removable = entries
      .filter((entry) => !entry.leased && entry.safeToDelete)
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
    const removed = new Set<string>();

    for (const entry of removable) {
      if (options.now - entry.mtimeMs < options.ttlMs) continue;
      if (await removeHookCacheEntry(entry)) {
        removed.add(entry.rootPath);
        totalBytes -= entry.sizeBytes;
      }
    }
    if (totalBytes <= options.maxBytes) return;
    for (const entry of removable) {
      if (removed.has(entry.rootPath)) continue;
      if (await removeHookCacheEntry(entry)) totalBytes -= entry.sizeBytes;
      if (totalBytes <= options.maxBytes) return;
    }
  });
}

async function collectLiveHookLeaseKeys(
  cacheRoot: string,
  processIsAlive: (pid: number) => boolean,
): Promise<ReadonlySet<string>> {
  const leasesRoot = path.join(cacheRoot, '.leases');
  await ensureSafeDirectory(leasesRoot);
  const live = new Set<string>();
  const cacheKeys = await readdir(leasesRoot, { withFileTypes: true });
  for (const cacheKey of cacheKeys) {
    if (!HOOK_CACHE_KEY.test(cacheKey.name)) continue;
    const leaseDirectory = path.join(leasesRoot, cacheKey.name);
    const hasLiveMarker = await leaseDirectoryHasLiveMarker(leaseDirectory, processIsAlive);
    if (hasLiveMarker) live.add(cacheKey.name);
    else await removeEmptyDirectory(leaseDirectory);
  }
  return live;
}

async function leaseDirectoryHasLiveMarker(
  leaseDirectory: string,
  processIsAlive: (pid: number) => boolean,
): Promise<boolean> {
  let directoryStat;
  try {
    directoryStat = await lstat(leaseDirectory);
  } catch {
    return true;
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return true;
  let markers;
  try {
    markers = await readdir(leaseDirectory, { withFileTypes: true });
  } catch {
    return true;
  }
  let hasLiveMarker = false;
  for (const marker of markers) {
    hasLiveMarker ||= await hookLeaseMarkerIsLive(
      path.join(leaseDirectory, marker.name),
      marker.name,
      processIsAlive,
    );
  }
  return hasLiveMarker;
}

async function hookLeaseMarkerIsLive(
  markerPath: string,
  markerName: string,
  processIsAlive: (pid: number) => boolean,
): Promise<boolean> {
  const pid = leaseMarkerPid(markerName);
  let markerStat;
  try {
    markerStat = await lstat(markerPath);
  } catch {
    return true;
  }
  if (markerStat.isSymbolicLink() || !markerStat.isFile() || pid === undefined) return true;
  if (processIsAlive(pid)) return true;
  await rm(markerPath, { force: true });
  return false;
}

async function inspectHookCacheEntries(
  cacheRoot: string,
  leasedCacheKeys: ReadonlySet<string>,
  processIsAlive: (pid: number) => boolean,
): Promise<readonly HookCacheGcEntry[]> {
  const entries = await readdir(cacheRoot, { withFileTypes: true });
  const inspected: HookCacheGcEntry[] = [];
  for (const entry of entries) {
    const candidate = await inspectHookCacheEntry(
      cacheRoot,
      entry.name,
      leasedCacheKeys,
      processIsAlive,
    );
    if (candidate) inspected.push(candidate);
  }
  return inspected;
}

async function inspectHookCacheEntry(
  cacheRoot: string,
  name: string,
  leasedCacheKeys: ReadonlySet<string>,
  processIsAlive: (pid: number) => boolean,
): Promise<HookCacheGcEntry | undefined> {
  if (name === '.leases') return undefined;
  const isCacheRoot = HOOK_CACHE_KEY.test(name);
  const temporaryOwnerPid = temporaryRootOwnerPid(name);
  const isTemporaryRoot = name.startsWith('.tmp-');
  if (!isCacheRoot && !isTemporaryRoot) return undefined;
  const rootPath = path.join(cacheRoot, name);
  const tree = await inspectHookCacheTree(rootPath);
  if (!tree) return undefined;
  const ambiguousTemporaryRoot = isTemporaryRoot && temporaryOwnerPid === undefined;
  return {
    name,
    rootPath,
    sizeBytes: tree.sizeBytes,
    mtimeMs: tree.mtimeMs,
    leased: isHookCacheEntryLeased({
      isCacheRoot,
      name,
      temporaryOwnerPid,
      ambiguousTemporaryRoot,
      leasedCacheKeys,
      processIsAlive,
    }),
    safeToDelete: tree.safeToDelete && !ambiguousTemporaryRoot,
  };
}

function isHookCacheEntryLeased(input: {
  readonly isCacheRoot: boolean;
  readonly name: string;
  readonly temporaryOwnerPid: number | undefined;
  readonly ambiguousTemporaryRoot: boolean;
  readonly leasedCacheKeys: ReadonlySet<string>;
  readonly processIsAlive: (pid: number) => boolean;
}): boolean {
  if (input.isCacheRoot && input.leasedCacheKeys.has(input.name)) return true;
  if (input.temporaryOwnerPid !== undefined && input.processIsAlive(input.temporaryOwnerPid))
    return true;
  return input.ambiguousTemporaryRoot;
}

async function inspectHookCacheTree(root: string): Promise<
  | {
      readonly sizeBytes: number;
      readonly mtimeMs: number;
      readonly safeToDelete: boolean;
    }
  | undefined
> {
  let stat;
  try {
    stat = await lstat(root);
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink()) {
    return { sizeBytes: stat.size, mtimeMs: stat.mtimeMs, safeToDelete: false };
  }
  if (stat.isFile()) {
    return { sizeBytes: stat.size, mtimeMs: stat.mtimeMs, safeToDelete: true };
  }
  if (!stat.isDirectory()) {
    return { sizeBytes: stat.size, mtimeMs: stat.mtimeMs, safeToDelete: false };
  }
  let sizeBytes = stat.size;
  let safeToDelete = true;
  let children;
  try {
    children = await readdir(root);
  } catch {
    return undefined;
  }
  for (const child of children) {
    const childTree = await inspectHookCacheTree(path.join(root, child));
    if (!childTree) return undefined;
    sizeBytes += childTree.sizeBytes;
    safeToDelete &&= childTree.safeToDelete;
  }
  return { sizeBytes, mtimeMs: stat.mtimeMs, safeToDelete };
}

async function removeHookCacheEntry(entry: HookCacheGcEntry): Promise<boolean> {
  try {
    const stat = await lstat(entry.rootPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    if (!(await makeHookCacheTreeRemovable(entry.rootPath))) return false;
    await rm(entry.rootPath, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

async function makeHookCacheTreeRemovable(root: string): Promise<boolean> {
  const stat = await lstat(root);
  if (stat.isSymbolicLink()) return false;
  if (stat.isFile()) {
    await chmod(root, 0o600);
    return true;
  }
  if (!stat.isDirectory()) return false;
  for (const child of await readdir(root)) {
    if (!(await makeHookCacheTreeRemovable(path.join(root, child)))) return false;
  }
  await chmod(root, 0o700);
  return true;
}

async function withHookCacheLock<T>(cacheRoot: string, operation: () => Promise<T>): Promise<T> {
  await ensureSafeDirectory(cacheRoot);
  const release = await lockfile.lock(cacheRoot, {
    realpath: false,
    stale: HOOK_CACHE_LOCK_STALE_MS,
    update: HOOK_CACHE_LOCK_STALE_MS / 3,
    retries: { retries: 20, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
  });
  try {
    await ensureSafeDirectory(cacheRoot);
    return await operation();
  } finally {
    await release();
  }
}

async function ensureSafeDirectory(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new PluginSystemError('HOOK_MATERIALIZATION_FAILED', 'Hook cache path is unsafe');
  }
}

async function touchHookCacheRoot(root: string): Promise<void> {
  try {
    const stat = await lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    const now = new Date();
    await utimes(root, now, now);
  } catch {
    // Usage timestamps are advisory; leases provide the safety boundary.
  }
}

async function removeEmptyDirectory(root: string): Promise<void> {
  try {
    await rmdir(root);
  } catch {
    // Another process may have acquired a lease concurrently.
  }
}

function leaseMarkerPid(name: string): number | undefined {
  const match = /^([1-9]\d*)-[0-9a-f-]+\.lease$/.exec(name);
  if (!match?.[1]) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

function temporaryRootOwnerPid(name: string): number | undefined {
  const match = OWNED_TEMPORARY_ROOT.exec(name);
  if (!match?.[1]) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ESRCH'
    );
  }
}

async function ensureReadOnlyHookPackage(root: string): Promise<void> {
  const existing = hookPackageReadOnlyTasks.get(root);
  if (existing) return existing;
  const task = makeTreeReadOnly(root);
  hookPackageReadOnlyTasks.set(root, task);
  try {
    await task;
  } finally {
    if (hookPackageReadOnlyTasks.get(root) === task) hookPackageReadOnlyTasks.delete(root);
  }
}

async function makeTreeReadOnly(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(root, entry.name);
      if (entry.isSymbolicLink()) {
        throw new PluginSystemError(
          'HOOK_MATERIALIZATION_FAILED',
          'immutable Hook package contains a symbolic link',
        );
      }
      if (entry.isDirectory()) await makeTreeReadOnly(target);
      else await chmod(target, 0o555);
    }),
  );
  await chmod(root, 0o555);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
