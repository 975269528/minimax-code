import path from 'node:path';

import {
  isRecord,
  resolvePluginDirectory,
  resolvePluginFile,
  type CanonicalPluginRoot,
} from '../filesystem.js';
import { validatePluginPortablePath } from '../package-contract.js';
import { PluginReaderError, readerFail } from '../reader-errors.js';
import type {
  MiniAppArtifacts,
  MiniAppContribution,
  MiniAppMcpEndpoint,
  MiniAppProcessRuntime,
} from '../types.js';
import { isMiniAppRuntimePayloadExcludedPath, isPathCoveredByRoots } from './path.js';

const MINIAPP_FIELDS = new Set([
  'schemaVersion',
  'artifacts',
  'runtime',
  'surface',
  'mcpEndpoints',
  'hostConnectorAccess',
]);
const ARTIFACT_FIELDS = new Set(['client', 'node']);
const PROCESS_RUNTIME_FIELDS = new Set(['kind', 'entry', 'lifecycle']);
const SURFACE_FIELDS = new Set(['path']);
const MCP_ENDPOINT_FIELDS = new Set(['server', 'path']);
const HOST_CONNECTOR_ACCESS_FIELDS = new Set(['providers']);
const CONNECTOR_PROVIDER = /^[a-z0-9_-]{1,64}$/u;
const MCP_SERVER = /^[a-zA-Z0-9_-]{1,128}$/u;

export async function readMiniAppManifest(
  root: CanonicalPluginRoot,
  value: Record<string, unknown>,
  mcpServerNames: readonly string[],
  payloadDirectory: 'liveboard' | 'miniapp',
): Promise<Omit<MiniAppContribution, 'manifestPath'>> {
  if (hasUnknownField(value, MINIAPP_FIELDS) || value.schemaVersion !== 1) {
    miniAppFail('MANIFEST_SCHEMA_INVALID', 'Mini App manifest must use strict schemaVersion 1');
  }
  const artifacts = await readArtifacts(root, value.artifacts, payloadDirectory);
  const runtime = await readRuntime(root, value.runtime, artifacts);
  const surface = readSurface(value.surface);
  const mcpEndpoints = readMcpEndpoints(value.mcpEndpoints, mcpServerNames);
  const hostConnectorAccess = readHostConnectorAccess(value.hostConnectorAccess);
  return {
    artifacts,
    runtime,
    surface,
    mcpEndpoints,
    ...(hostConnectorAccess ? { hostConnectorAccess } : {}),
  };
}

async function readArtifacts(
  root: CanonicalPluginRoot,
  value: unknown,
  payloadDirectory: 'liveboard' | 'miniapp',
): Promise<MiniAppArtifacts> {
  if (!isRecord(value) || hasUnknownField(value, ARTIFACT_FIELDS)) {
    miniAppFail('ARTIFACTS_INVALID', 'artifacts must be an object');
  }
  const client = await readArtifactRoots(root, value.client, 'artifacts.client', payloadDirectory);
  const node = await readArtifactRoots(root, value.node, 'artifacts.node', payloadDirectory);
  return { client, node };
}

async function readArtifactRoots(
  root: CanonicalPluginRoot,
  value: unknown,
  label: string,
  payloadDirectory: 'liveboard' | 'miniapp',
): Promise<string[]> {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string')
  ) {
    miniAppFail('ARTIFACTS_INVALID', `${label} must be a non-empty string array`);
  }
  const roots = (value as string[]).map((item) => normalizePluginPath(item, label));
  if (new Set(roots).size !== roots.length) {
    miniAppFail('ARTIFACTS_INVALID', `${label} contains a duplicate`);
  }
  for (const artifactRoot of roots) {
    if (!artifactRoot.startsWith(`${payloadDirectory}/`)) {
      miniAppFail('ARTIFACTS_INVALID', `${label} must stay under ${payloadDirectory}/`);
    }
    if (isMiniAppRuntimePayloadExcludedPath(artifactRoot)) {
      miniAppFail('ARTIFACTS_EXCLUDED', `${artifactRoot} is excluded from runtime payloads`);
    }
    await resolveFileOrDirectory(root, artifactRoot);
  }
  return roots;
}

async function readRuntime(
  root: CanonicalPluginRoot,
  value: unknown,
  artifacts: MiniAppArtifacts,
): Promise<MiniAppProcessRuntime> {
  if (!isRecord(value)) miniAppFail('RUNTIME_INVALID', 'runtime must be an object');
  if (value.kind === 'process') {
    return readProcessRuntime(root, value, artifacts);
  }
  miniAppFail('RUNTIME_INVALID', 'runtime.kind must be process');
}

async function readProcessRuntime(
  root: CanonicalPluginRoot,
  value: Record<string, unknown>,
  artifacts: MiniAppArtifacts,
): Promise<MiniAppProcessRuntime> {
  if (hasUnknownField(value, PROCESS_RUNTIME_FIELDS)) {
    miniAppFail('RUNTIME_INVALID', 'process runtime contains an unknown field');
  }
  const entry = normalizePluginPath(value.entry, 'runtime.entry');
  if (!/\.(?:[cm]?js)$/u.test(entry)) {
    miniAppFail('RUNTIME_INVALID', 'process runtime entry must end in .js, .mjs, or .cjs');
  }
  await resolveDeclaredFile(root, entry);
  if (!isPathCoveredByRoots(entry, artifacts.node)) {
    miniAppFail('RUNTIME_ENTRY_NOT_ARTIFACT', 'process entry must be covered by node artifacts');
  }
  const lifecycle = value.lifecycle ?? 'on-demand';
  if (lifecycle !== 'on-demand' && lifecycle !== 'background') {
    miniAppFail('RUNTIME_INVALID', 'process lifecycle is invalid');
  }
  // `background` was briefly documented before Host admission shipped. Keep
  // accepting the spelling at the reader seam without exporting runtime policy.
  return { kind: 'process', entry, lifecycle: 'on-demand' };
}

function readSurface(value: unknown): { path: string } {
  if (!isRecord(value) || hasUnknownField(value, SURFACE_FIELDS)) {
    miniAppFail('SURFACE_INVALID', 'surface must contain only path');
  }
  return { path: normalizeRoutePath(value.path, 'surface.path') };
}

function readMcpEndpoints(value: unknown, mcpServerNames: readonly string[]): MiniAppMcpEndpoint[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    miniAppFail('MCP_ENDPOINTS_INVALID', 'mcpEndpoints must be an array');
  }
  const knownServers = new Set(mcpServerNames);
  const serverKeys = new Set<string>();
  const pathKeys = new Set<string>();
  return value.map((item) => {
    if (
      !isRecord(item) ||
      hasUnknownField(item, MCP_ENDPOINT_FIELDS) ||
      typeof item.server !== 'string' ||
      !MCP_SERVER.test(item.server)
    ) {
      miniAppFail('MCP_ENDPOINTS_INVALID', 'MCP endpoint is invalid');
    }
    const routePath = normalizeRoutePath(item.path, 'mcpEndpoints.path');
    if (!knownServers.has(item.server)) {
      miniAppFail(
        'MCP_ENDPOINTS_INVALID',
        `MCP server ${item.server} is not declared by the Plugin`,
      );
    }
    if (serverKeys.has(item.server) || pathKeys.has(routePath)) {
      miniAppFail('MCP_ENDPOINTS_INVALID', 'MCP endpoint server and path must be unique');
    }
    serverKeys.add(item.server);
    pathKeys.add(routePath);
    return { server: item.server, path: routePath };
  });
}

function readHostConnectorAccess(value: unknown): { providers: string[] } | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    hasUnknownField(value, HOST_CONNECTOR_ACCESS_FIELDS) ||
    !Array.isArray(value.providers) ||
    value.providers.some(
      (provider) => typeof provider !== 'string' || !CONNECTOR_PROVIDER.test(provider),
    )
  ) {
    miniAppFail('HOST_CONNECTOR_ACCESS_INVALID', 'hostConnectorAccess.providers is invalid');
  }
  const providers = value.providers as string[];
  if (new Set(providers).size !== providers.length) {
    miniAppFail(
      'HOST_CONNECTOR_ACCESS_INVALID',
      'hostConnectorAccess.providers contains a duplicate',
    );
  }
  return { providers };
}

async function resolveFileOrDirectory(
  root: CanonicalPluginRoot,
  relativePath: string,
): Promise<void> {
  try {
    await resolvePluginFile(root, relativePath, { portable: true });
    return;
  } catch (error) {
    if (
      !(error instanceof PluginReaderError) ||
      !['PLUGIN_FILE_INVALID', 'PLUGIN_FILE_NOT_FOUND', 'PLUGIN_PATH_NOT_FOUND'].includes(
        error.code,
      )
    ) {
      miniAppFail('ARTIFACTS_INVALID', `${relativePath} is not a valid artifact path`);
    }
  }
  try {
    await resolvePluginDirectory(root, relativePath);
  } catch (error) {
    miniAppFail('ARTIFACTS_INVALID', `${relativePath} is not a valid artifact path`);
  }
}

async function resolveDeclaredFile(root: CanonicalPluginRoot, relativePath: string): Promise<void> {
  try {
    await resolvePluginFile(root, relativePath, { portable: true });
  } catch {
    miniAppFail('RUNTIME_INVALID', `${relativePath} is not a valid runtime file`);
  }
}

function normalizePluginPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\\')) {
    miniAppFail('PATH_INVALID', `${label} must be a plugin-relative path`);
  }
  const withoutDot = value.trim().replace(/^\.\//u, '');
  const normalized = path.posix.normalize(withoutDot);
  try {
    validatePluginPortablePath(normalized);
  } catch {
    miniAppFail('PATH_INVALID', `${label} must be a canonical portable path`);
  }
  if (normalized !== withoutDot) {
    miniAppFail('PATH_INVALID', `${label} must be canonical`);
  }
  return normalized;
}

function normalizeRoutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    miniAppFail('ROUTE_PATH_INVALID', `${label} must be a non-empty route path`);
  }
  const route = value.trim();
  assertRouteIsHostRelative(route, label);
  const withSlash = route.startsWith('/') ? route : `/${route}`;
  if (path.posix.normalize(withSlash) !== withSlash) {
    miniAppFail('ROUTE_PATH_INVALID', `${label} must be canonical`);
  }
  return withSlash;
}

function assertRouteIsHostRelative(route: string, label: string): void {
  const hasOrigin = route.includes('://') || route.startsWith('//');
  const hasTransportSyntax = route.includes('\\') || route.includes('?') || route.includes('#');
  if (hasOrigin || hasTransportSyntax) {
    miniAppFail('ROUTE_PATH_INVALID', `${label} must not contain an origin, query, or fragment`);
  }
}

function hasUnknownField(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).some((key) => !fields.has(key));
}

function miniAppFail(code: string, detail: string): never {
  readerFail(`MINIAPP_${code}`, detail);
}
