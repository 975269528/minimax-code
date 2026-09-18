import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { readAgentPluginPackage } from './agent-plugin-reader.js';
import { readCompatiblePluginPackage } from './compatibility-reader.js';
import { canonicalizePluginRoot, pluginPathExists } from './filesystem.js';
import { readMiniMaxPluginPackage } from './minimax-reader.js';
import {
  computeMiniAppPackageDigests,
  computePluginDirectoryDigest,
  PluginPackageContractError,
} from './package-contract.js';
import { PluginReaderError } from './reader-errors.js';
import type {
  LocalPluginScanDiagnostic,
  LocalPluginScanResult,
  ReadPluginPackage,
  ScannedLocalPluginPackage,
  ScannedReadPluginPackage,
} from './types.js';

const LOCAL_PLUGIN_SCAN_CONCURRENCY = 4;

interface LocalPluginCandidate {
  readonly directoryName: string;
  readonly rootPath: string;
}

export function readMiniMaxPlugin(
  packageRoot: string,
  options: { source: 'OFFICIAL' | 'LOCAL_MINIMAX' },
): Promise<ReadPluginPackage> {
  return readMiniMaxPluginPackage(packageRoot, options);
}

export async function readImportedPluginPackage(
  rootPath: string,
  options: { dataDir: string; createPluginData?: boolean },
): Promise<ReadPluginPackage> {
  const root = await canonicalizePluginRoot(rootPath, { rejectSymlink: true });
  const hasAgentPlugin = await pluginPathExists(root, 'plugin.json', 'file');
  let agentPluginError: unknown;
  if (hasAgentPlugin) {
    try {
      return await readAgentPluginPackage(root.path, {
        dataDir: options.dataDir,
        createPluginData: options.createPluginData ?? false,
      });
    } catch (error) {
      agentPluginError = error;
    }
  }
  const hasMiniMax = await pluginPathExists(root, '.minimax-plugin/plugin.json', 'file');
  const compatibleManifestPath = '.\u0063\u006c\u0061\u0075\u0064\u0065-plugin/plugin.json';
  const hasCompatible = await pluginPathExists(root, compatibleManifestPath, 'file');
  const hasCodex = await pluginPathExists(root, '.codex-plugin/plugin.json', 'file');
  if (hasMiniMax) return readMiniMaxPluginPackage(root.path, { source: 'LOCAL_MINIMAX' });
  if (hasCompatible) return readCompatiblePluginPackage(root.path);
  if (hasCodex) return readCompatiblePluginPackage(root.path, { kind: 'CODEX' });
  if (agentPluginError) throw agentPluginError;
  throw new PluginReaderError('PLUGIN_MANIFEST_MISSING', 'Plugin manifest is missing');
}

/** Reads and digests one Host-selected MiniMax package outside the installed-package catalog. */
export async function readLocalMiniMaxPluginPackage(
  packageRoot: string,
  options: {
    readonly rejectHardlinks?: boolean;
    readonly requireMiniApp?: boolean;
  } = {},
): Promise<ScannedLocalPluginPackage> {
  const root = await canonicalizePluginRoot(packageRoot, { rejectSymlink: true });
  const plugin = await readMiniMaxPluginPackage(root.path, {
    source: 'LOCAL_MINIMAX',
    requireMiniApp: options.requireMiniApp,
  });
  return digestScannedPackage(plugin, options);
}

export async function scanLocalPluginPackages(pluginsRoot: string): Promise<LocalPluginScanResult> {
  try {
    await lstat(pluginsRoot);
  } catch (error) {
    if (isMissing(error)) return { plugins: [], diagnostics: [] };
    throw error;
  }
  const root = await canonicalizePluginRoot(pluginsRoot, { rejectSymlink: true });
  const candidates = await listLocalPluginCandidates(root.path);

  const plugins: ScannedLocalPluginPackage[] = [];
  const diagnostics: LocalPluginScanDiagnostic[] = [];
  const results = await mapWithConcurrency(
    candidates,
    LOCAL_PLUGIN_SCAN_CONCURRENCY,
    readLocalPluginCandidate,
  );
  for (const result of results) {
    if (result.plugin) plugins.push(result.plugin);
    if (result.diagnostic) diagnostics.push(result.diagnostic);
  }
  return { plugins, diagnostics };
}

async function listLocalPluginCandidates(rootPath: string): Promise<LocalPluginCandidate[]> {
  const candidates: LocalPluginCandidate[] = [];
  for (const child of await readdir(rootPath, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const childPath = path.join(rootPath, child.name);
    try {
      const childStat = await lstat(childPath);
      if (childStat.isSymbolicLink() || !childStat.isDirectory()) continue;
      candidates.push({ directoryName: child.name, rootPath: await realpath(childPath) });
    } catch {
      continue;
    }
  }
  candidates.sort(
    (left, right) =>
      normalizePath(left.rootPath).localeCompare(normalizePath(right.rootPath)) ||
      left.directoryName.localeCompare(right.directoryName),
  );
  return candidates;
}

async function readLocalPluginCandidate(candidate: LocalPluginCandidate): Promise<{
  plugin?: ScannedLocalPluginPackage;
  diagnostic?: LocalPluginScanDiagnostic;
}> {
  try {
    const candidateRoot = await canonicalizePluginRoot(candidate.rootPath, {
      rejectSymlink: true,
    });
    const pluginPackage = await detectLocalPluginPackage(candidate.rootPath, candidateRoot);
    if (!pluginPackage) return {};
    return { plugin: await digestScannedPackage(pluginPackage) };
  } catch (error) {
    return {
      diagnostic: {
        code: localScanErrorCode(error),
        directoryName: candidate.directoryName,
      },
    };
  }
}

async function detectLocalPluginPackage(
  rootPath: string,
  root: Awaited<ReturnType<typeof canonicalizePluginRoot>>,
): Promise<ReadPluginPackage | undefined> {
  if (await pluginPathExists(root, 'plugin.json', 'file')) {
    const agentPlugin = await tryReadAgentPluginPackage(rootPath);
    if (agentPlugin) return agentPlugin;
  }
  const compatibleManifestPath = '.\u0063\u006c\u0061\u0075\u0064\u0065-plugin/plugin.json';
  const manifests = {
    hasMiniMax: await pluginPathExists(root, '.minimax-plugin/plugin.json', 'file'),
    hasCompatible: await pluginPathExists(root, compatibleManifestPath, 'file'),
    hasCodex: await pluginPathExists(root, '.codex-plugin/plugin.json', 'file'),
  };
  if (!manifests.hasMiniMax && !manifests.hasCompatible && !manifests.hasCodex) return undefined;
  return readCandidatePackage(rootPath, manifests);
}

async function digestScannedPackage(
  pluginPackage: ReadPluginPackage,
  options: { readonly rejectHardlinks?: boolean } = {},
): Promise<ScannedLocalPluginPackage> {
  const miniapp = pluginPackage.miniapp;
  if (miniapp) {
    const hasStdioMcp = pluginPackage.mcpServers.some(
      (server) => server.resolvedServer.transport.type === 'stdio',
    );
    const digests = await computeMiniAppPackageDigests(pluginPackage.rootPath, miniapp.artifacts, {
      ...options,
      includeOrdinaryContentDigest: hasStdioMcp,
    });
    return {
      plugin: {
        ...pluginPackage,
        miniapp: {
          ...miniapp,
          contentDigest: digests.contentDigest,
          clientDigest: digests.clientDigest,
          nodeDigest: digests.nodeDigest,
        },
      },
      contentDigest: digests.ordinaryContentDigest ?? digests.contentDigest,
    };
  }
  const { contentDigest } = await computePluginDirectoryDigest(pluginPackage.rootPath, {
    pathPolicy: pluginPackage.manifestKind === 'MINIMAX' ? 'minimax-portable' : 'agent-plugin',
    ...options,
  });
  return { plugin: withoutMiniAppContribution(pluginPackage), contentDigest };
}

function withoutMiniAppContribution(
  plugin: ReadPluginPackage,
): Omit<ScannedReadPluginPackage, 'miniapp'> {
  const copy = { ...plugin };
  delete copy.miniapp;
  return copy;
}

function localScanErrorCode(error: unknown): string {
  return error instanceof PluginReaderError || error instanceof PluginPackageContractError
    ? error.code
    : 'PLUGIN_SCAN_FAILED';
}

async function readCandidatePackage(
  rootPath: string,
  manifests: {
    readonly hasMiniMax: boolean;
    readonly hasCompatible: boolean;
    readonly hasCodex: boolean;
  },
): Promise<ReadPluginPackage> {
  if (manifests.hasMiniMax) {
    return readMiniMaxPluginPackage(rootPath, { source: 'LOCAL_MINIMAX' });
  }
  if (manifests.hasCompatible) return readCompatiblePluginPackage(rootPath);
  if (manifests.hasCodex) return readCompatiblePluginPackage(rootPath, { kind: 'CODEX' });
  throw new PluginReaderError('PLUGIN_MANIFEST_MISSING', 'Plugin manifest is missing');
}

async function tryReadAgentPluginPackage(rootPath: string): Promise<ReadPluginPackage | undefined> {
  try {
    // A root plugin.json wins only after the Agent Plugins reader accepts the
    // complete portable manifest. An ordinary or malformed root plugin.json
    // therefore cannot shadow a valid MiniMax or compatible vendor manifest.
    return await readAgentPluginPackage(rootPath, {
      dataDir: path.dirname(path.dirname(rootPath)),
      createPluginData: true,
    });
  } catch {
    return undefined;
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await mapper(value);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => worker()),
  );
  return results;
}

function normalizePath(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
