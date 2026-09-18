import { PluginSystemError } from '../../../errors.js';
import type { RuntimeEligibleScannedReadPluginPackage } from '../../package/types.js';
import type { PluginSnapshot } from '../snapshot-builder.js';

/** Candidate projection consumed by PluginSystem's publication participant. */
export interface PluginMiniAppCandidate {
  readonly pluginId: string;
  readonly packageRoot: string;
  readonly packageDigest: string;
  readonly clientDigest: string;
  readonly surfacePath: string;
  readonly lifecycle: 'on-demand';
  readonly nodeDigest: string;
  readonly nodeEntry: string;
  readonly mcpEndpoints: readonly { readonly id: string; readonly path: string }[];
  readonly hostConnectorPolicy:
    | { readonly kind: 'deny-all' }
    | { readonly kind: 'allowlist'; readonly providers: readonly string[] };
}

export interface MiniAppDefinition {
  readonly source: 'official' | 'local';
  readonly displayName?: string;
  readonly description?: string;
  readonly iconPath?: string;
  readonly candidate: PluginMiniAppCandidate;
}

/** Host-facing name retained for the workspace publication interface. */
export type AcceptedMiniApp = MiniAppDefinition;

export function sameMiniAppCandidate(
  left: PluginMiniAppCandidate,
  right: PluginMiniAppCandidate,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Enabled and valid authored definitions, independent from Host runtime acceptance. */
export function listEnabledMiniAppDefinitions(
  snapshot: PluginSnapshot,
): readonly MiniAppDefinition[] {
  const packages = [
    ...snapshot.officialPackages.flatMap(({ plugin }) => (plugin?.miniapp ? [plugin] : [])),
    ...snapshot.localPlugins
      .filter((projection) => projection.enabled && projection.plugin.miniapp !== undefined)
      .map(({ plugin }) => plugin),
  ];
  return packages
    .map<MiniAppDefinition>((plugin) => ({
      source: plugin.source === 'OFFICIAL' ? 'official' : 'local',
      ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
      ...(plugin.description ? { description: plugin.description } : {}),
      ...(plugin.iconPath ? { iconPath: plugin.iconPath } : {}),
      candidate: miniAppCandidateFromPackage({ plugin }),
    }))
    .sort((left, right) => left.candidate.pluginId.localeCompare(right.candidate.pluginId));
}

/** Runtime-only projection after a publication snapshot has been admission-filtered. */
export function listAcceptedMiniApps(snapshot: PluginSnapshot): readonly MiniAppDefinition[] {
  return listEnabledMiniAppDefinitions(snapshot);
}

export function miniAppCandidateFromPackage(packageEntry: {
  readonly plugin: RuntimeEligibleScannedReadPluginPackage;
}): PluginMiniAppCandidate {
  const miniapp = packageEntry.plugin.miniapp;
  if (!miniapp) throw candidateError('MINIAPP_CONTRIBUTION_MISSING');
  return {
    pluginId: packageEntry.plugin.name,
    packageRoot: packageEntry.plugin.rootPath,
    // Runtime identity follows the authored MiniApp payload. Ordinary Skill,
    // App, and non-managed MCP changes must not force a service replacement.
    packageDigest: miniapp.contentDigest,
    clientDigest: miniapp.clientDigest,
    surfacePath: miniapp.surface.path,
    lifecycle: miniapp.runtime.lifecycle,
    nodeDigest: miniapp.nodeDigest,
    nodeEntry: miniapp.runtime.entry,
    mcpEndpoints: miniapp.mcpEndpoints.map(({ server, path }) => ({ id: server, path })),
    hostConnectorPolicy: miniapp.hostConnectorAccess?.providers.length
      ? { kind: 'allowlist', providers: [...miniapp.hostConnectorAccess.providers] }
      : { kind: 'deny-all' },
  };
}

function candidateError(code: string): PluginSystemError {
  return new PluginSystemError(code, 'Mini App publication preparation failed');
}
