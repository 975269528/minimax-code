import type { PluginSnapshotBuildInputs, PluginSnapshotBuildOptions } from '../../../contracts.js';
import { PluginSystemError } from '../../../errors.js';
import type { PluginSnapshot } from '../snapshot-builder.js';
import {
  listEnabledMiniAppDefinitions,
  miniAppCandidateFromPackage,
  sameMiniAppCandidate,
  type PluginMiniAppCandidate,
} from './candidate.js';

export type PackageInput = PluginSnapshotBuildInputs['localPackages'][number];

export interface MiniAppSnapshotBuildContext {
  readonly input: PluginSnapshotBuildInputs;
  readonly options: PluginSnapshotBuildOptions;
}

/** Keeps authored definitions discoverable while removing every cold runtime contribution. */
export function projectColdMiniAppPublication(input: {
  readonly snapshot: PluginSnapshot;
  readonly buildContext: MiniAppSnapshotBuildContext;
  readonly buildSnapshot: (
    snapshotInput: PluginSnapshotBuildInputs,
    buildOptions: PluginSnapshotBuildOptions,
  ) => PluginSnapshot;
}): PluginSnapshot {
  const localPackages = input.buildContext.input.localPackages.map(ordinaryPackageContribution);
  const officialPackages = input.buildContext.input.officialPackages.map(
    ordinaryPackageContribution,
  );
  const projected = input.buildSnapshot(
    { ...input.buildContext.input, localPackages, officialPackages },
    input.buildContext.options,
  );
  return withEnabledPluginRoster(projected, input.snapshot);
}

/**
 * Rebuilds a targeted publication from the accepted runtime context. The fresh
 * catalog contributes only the requested package; every unrelated input remains
 * exactly as it was in the current publication.
 */
export function buildTargetedMiniAppInputs(input: {
  readonly base: PluginSnapshotBuildInputs;
  readonly available: PluginSnapshotBuildInputs;
  readonly availableSnapshot: PluginSnapshot;
  readonly target: PluginMiniAppCandidate;
}): PluginSnapshotBuildInputs {
  const validatedTarget = listEnabledMiniAppDefinitions(input.availableSnapshot).find(
    ({ candidate }) => sameMiniAppCandidate(candidate, input.target),
  );
  if (!validatedTarget) throw invalidTargetError();
  const matchesTarget = (candidate: PackageInput) =>
    candidate.plugin.name === input.target.pluginId &&
    candidate.plugin.rootPath === input.target.packageRoot &&
    candidate.plugin.miniapp !== undefined &&
    sameMiniAppCandidate(miniAppCandidateFromPackage(candidate), input.target);
  const officialTarget = input.available.officialPackages.find(matchesTarget);
  if (officialTarget) {
    return {
      ...input.base,
      officialPackages: replaceTargetPackage(input.base.officialPackages, officialTarget),
    };
  }
  const targetPackage = input.available.localPackages.find(matchesTarget);
  if (!targetPackage) throw invalidTargetError();
  return {
    ...input.base,
    localPackages: replaceTargetPackage(input.base.localPackages, targetPackage),
  };
}

function replaceTargetPackage(
  packages: readonly PackageInput[],
  target: PackageInput,
): readonly PackageInput[] {
  let replaced = false;
  const next: PackageInput[] = [];
  for (const current of packages) {
    if (current.plugin.name !== target.plugin.name) {
      next.push(current);
      continue;
    }
    if (!replaced) next.push(target);
    replaced = true;
  }
  if (!replaced) next.push(target);
  return next;
}

export function buildSelectiveMiniAppInputs(input: {
  readonly available: PluginSnapshotBuildInputs;
  readonly availableSnapshot: PluginSnapshot;
  readonly activePluginIds: ReadonlySet<string>;
  readonly target?: PluginMiniAppCandidate;
}): PluginSnapshotBuildInputs {
  const definitions = new Map(
    listEnabledMiniAppDefinitions(input.availableSnapshot).map(({ candidate }) => [
      candidate.pluginId,
      candidate,
    ]),
  );
  const target = input.target;
  if (
    target &&
    ![...definitions.values()].some((candidate) => sameMiniAppCandidate(candidate, target))
  ) {
    throw invalidTargetError();
  }
  const localPackages = input.available.localPackages.map((candidate) =>
    retainRuntimeMiniAppContribution(candidate, definitions, input)
      ? candidate
      : ordinaryPackageContribution(candidate),
  );
  const officialPackages = input.available.officialPackages.map((candidate) =>
    retainRuntimeMiniAppContribution(candidate, definitions, input)
      ? candidate
      : ordinaryPackageContribution(candidate),
  );
  return { ...input.available, localPackages, officialPackages };
}

export function retainRuntimeMiniAppContribution(
  candidate: PackageInput,
  definitions: ReadonlyMap<string, PluginMiniAppCandidate>,
  input: {
    readonly activePluginIds: ReadonlySet<string>;
    readonly target?: PluginMiniAppCandidate;
  },
): boolean {
  const definition = definitions.get(candidate.plugin.name);
  if (!definition || !candidate.plugin.miniapp) return false;
  if (candidate.plugin.rootPath !== definition.packageRoot) return false;
  if (!sameMiniAppCandidate(miniAppCandidateFromPackage(candidate), definition)) return false;
  return (
    input.activePluginIds.has(candidate.plugin.name) ||
    Boolean(input.target && sameMiniAppCandidate(definition, input.target))
  );
}

export function ordinaryPackageContribution(candidate: PackageInput): PackageInput {
  const miniapp = candidate.plugin.miniapp;
  if (!miniapp) return candidate;
  const managedServers = miniAppManagedServerNames(miniapp);
  const plugin = { ...candidate.plugin };
  delete plugin.miniapp;
  return {
    ...candidate,
    plugin: {
      ...plugin,
      mcpServers: plugin.mcpServers.filter((server) => !managedServers.has(server.name)),
    },
  };
}

export function withEnabledPluginRoster(
  runtimeSnapshot: PluginSnapshot,
  rosterSource: PluginSnapshot,
): PluginSnapshot {
  if (
    runtimeSnapshot.enabledPlugins === rosterSource.enabledPlugins &&
    runtimeSnapshot.turnCapabilities.plugins === rosterSource.turnCapabilities.plugins
  ) {
    return runtimeSnapshot;
  }
  return Object.freeze({
    ...runtimeSnapshot,
    enabledPlugins: rosterSource.enabledPlugins,
    turnCapabilities: Object.freeze({
      ...runtimeSnapshot.turnCapabilities,
      plugins: rosterSource.turnCapabilities.plugins,
    }),
  });
}

export function miniAppManagedServerNames(
  miniapp: NonNullable<PackageInput['plugin']['miniapp']>,
): ReadonlySet<string> {
  return new Set(miniapp.mcpEndpoints.map(({ server }) => server));
}

function invalidTargetError(): PluginSystemError {
  return new PluginSystemError(
    'MINIAPP_TARGET_DEFINITION_MISSING',
    'Mini App publication preparation failed',
  );
}
