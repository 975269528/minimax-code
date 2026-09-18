import { lstat } from 'node:fs/promises';
import { pluginMcpNameKey } from '@mavis/mcp';

import type { PluginSnapshotBuildInputs, PluginSnapshotBuildOptions } from '../../contracts.js';
import type { PluginMcpInventorySeed } from '../../mcp/runtime.js';
import type { PluginPackageStorage } from './package-storage.js';
import type { PluginRepositoryScope, SqlitePluginRepository } from './repository.js';
import type { PluginCapabilityReservations, PluginSnapshot } from './snapshot-builder.js';
import { PluginSnapshotBuilder } from './snapshot-builder.js';

interface ReadSnapshotInputsOptions {
  readonly packageStorage: PluginPackageStorage;
  readonly repository: SqlitePluginRepository;
  readonly listReservations: () => Promise<PluginCapabilityReservations>;
  readonly desiredSnapshot: PluginSnapshot;
  readonly scope: PluginRepositoryScope | undefined;
  readonly pruneMissingLocalPlugins: boolean;
  readonly buildOptions: PluginSnapshotBuildOptions;
}

/** Reads package state while retaining a last-good local package during partial writes. */
export async function readPluginSnapshotInputs(
  input: ReadSnapshotInputsOptions,
): Promise<PluginSnapshotBuildInputs> {
  const scanned = await input.packageStorage.scanLocalPackages();
  const localPackages = scanned.filter(
    (entry) => !input.buildOptions.excludedLocalRoots?.has(entry.plugin.rootPath),
  );
  const scannedRoots = new Set(localPackages.map((entry) => entry.plugin.rootPath));
  for (const previous of input.desiredSnapshot.localPlugins) {
    if (
      scannedRoots.has(previous.rootPath) ||
      input.buildOptions.excludedLocalRoots?.has(previous.rootPath) ||
      !(await isExistingLocalPluginDirectory(previous.rootPath))
    ) {
      continue;
    }
    localPackages.push({ plugin: previous.plugin, contentDigest: previous.contentDigest });
    scannedRoots.add(previous.rootPath);
  }
  const localRoots = new Set(localPackages.map((entry) => entry.plugin.rootPath));
  if (input.pruneMissingLocalPlugins) input.repository.pruneMissingLocalPlugins(localRoots);
  const [officialPackages, reservations] = await Promise.all([
    input.buildOptions.officialState
      ? input.packageStorage.restoreOfficialPackagesFromState(input.buildOptions.officialState)
      : input.packageStorage.restoreOfficialPackages(input.scope),
    input.listReservations(),
  ]);
  return { officialPackages, localPackages, reservations };
}

export function buildPluginSnapshotFromInputs(input: {
  readonly builder: PluginSnapshotBuilder;
  readonly snapshotInputs: PluginSnapshotBuildInputs;
  readonly buildOptions: PluginSnapshotBuildOptions;
  readonly isLocalEnabled: (root: string) => boolean;
}): PluginSnapshot {
  return input.builder.build({
    revision: 'plugin-snapshot-candidate',
    officialPackages: input.snapshotInputs.officialPackages,
    localPackages: input.snapshotInputs.localPackages.filter(
      (entry) => !input.buildOptions.excludedLocalRoots?.has(entry.plugin.rootPath),
    ),
    isLocalEnabled: (root) =>
      input.buildOptions.localEnabledOverrides?.get(root) ?? input.isLocalEnabled(root),
    reservations: input.snapshotInputs.reservations,
  });
}

export function buildPluginMarketplaceSnapshot(input: {
  readonly builder: PluginSnapshotBuilder;
  readonly revision: string;
  readonly snapshotInputs: PluginSnapshotBuildInputs;
  readonly isLocalEnabled: (root: string) => boolean;
}): PluginSnapshot {
  return input.builder.build({
    revision: input.revision,
    officialPackages: input.snapshotInputs.officialPackages,
    localPackages: input.snapshotInputs.localPackages,
    isLocalEnabled: input.isLocalEnabled,
    reservations: input.snapshotInputs.reservations,
  });
}

export function buildCustomOnlySnapshot(input: {
  readonly builder: PluginSnapshotBuilder;
  readonly revision: string;
  readonly source: PluginSnapshot;
  readonly isLocalEnabled: (root: string) => boolean;
  readonly reservations: PluginCapabilityReservations;
}): { readonly snapshot: PluginSnapshot; readonly inputs: PluginSnapshotBuildInputs } {
  const inputs: PluginSnapshotBuildInputs = {
    officialPackages: [],
    localPackages: input.source.localPlugins.map((entry) => ({
      plugin: entry.plugin,
      contentDigest: entry.contentDigest,
    })),
    reservations: input.reservations,
  };
  const snapshot = input.builder.build({
    revision: input.revision,
    officialPackages: inputs.officialPackages,
    localPackages: inputs.localPackages,
    isLocalEnabled: input.isLocalEnabled,
    reservations: inputs.reservations,
  });
  return { snapshot, inputs };
}

export function localSnapshotInventory(
  snapshot: PluginSnapshot,
  inventory: readonly PluginMcpInventorySeed[] | undefined,
): readonly PluginMcpInventorySeed[] | undefined {
  if (!inventory) return undefined;
  const serverNames = new Set(
    snapshot.mcpServers.map((entry) =>
      pluginMcpNameKey(entry.source, entry.pluginName, entry.server.name),
    ),
  );
  return inventory.filter((entry) => serverNames.has(entry.serverName));
}

export function removedPluginHookNames(
  current: PluginSnapshot,
  next: PluginSnapshot,
): readonly string[] {
  const nextNames = new Set(
    (next.turnCapabilities.hooks ?? []).map((handler) => handler.pluginName),
  );
  return [
    ...new Set(
      (current.turnCapabilities.hooks ?? [])
        .map((handler) => handler.pluginName)
        .filter((pluginName) => !nextNames.has(pluginName)),
    ),
  ];
}

async function isExistingLocalPluginDirectory(rootPath: string): Promise<boolean> {
  try {
    const stat = await lstat(rootPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
