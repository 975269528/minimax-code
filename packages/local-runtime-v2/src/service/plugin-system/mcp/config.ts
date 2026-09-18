import { realpath } from 'node:fs/promises';
import path from 'node:path';

import type { ResolvedMcpServer, TransportConfig } from '@mavis/mcp';

import {
  isRecord,
  readPluginJsonObject,
  type CanonicalPluginRoot,
} from '../plugin/package/filesystem.js';
import { PluginReaderError, readerFail } from '../plugin/package/reader-errors.js';
import type {
  PluginDeclaredTool,
  PluginMcpServer,
  PluginReaderDiagnostic,
} from '../plugin/package/types.js';
import type { ParsedMcpServers } from './contracts.js';

export type { ParsedMcpServers } from './contracts.js';

const OFFICIAL_SERVER_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const TOOL_NAME = /^[A-Za-z0-9_.-]+$/u;
const OFFICIAL_STDIO_FIELDS = new Set([
  'type',
  'command',
  'args',
  'env',
  'description',
  'timeout',
  'tools',
]);
const OFFICIAL_REMOTE_FIELDS = new Set([
  'type',
  'url',
  'headers',
  'description',
  'timeout',
  'tools',
]);
const COMPATIBLE_FIELDS = new Set([...OFFICIAL_STDIO_FIELDS, ...OFFICIAL_REMOTE_FIELDS]);
const OAUTH_FIELDS = new Set([
  'auth',
  'oauth',
  'oauth2',
  'accessToken',
  'refreshToken',
  'clientId',
  'clientSecret',
]);
const COMPATIBLE_PLUGIN_ROOT_TOKEN = [
  '$',
  '{\u0043\u004c\u0041\u0055\u0044\u0045_PLUGIN_ROOT}',
].join('');

type McpConfigMode = 'official' | 'compatible';
type McpTransportType = 'stdio' | 'http' | 'streamable-http' | 'sse';

export async function readOfficialMcpFile(
  root: CanonicalPluginRoot,
  relativePath: string,
): Promise<ParsedMcpServers> {
  const { value } = await readPluginJsonObject(root, relativePath, { portable: true });
  assertExactFields(value, new Set(['$schema', 'schemaVersion', 'mcpServers']), 'MCP file');
  if (
    (value.$schema !== undefined && typeof value.$schema !== 'string') ||
    value.schemaVersion !== 1 ||
    !isRecord(value.mcpServers)
  ) {
    readerFail('MCP_SCHEMA_INVALID', `${relativePath} has an invalid V1 wrapper`);
  }
  if (Object.keys(value.mcpServers).length === 0) {
    readerFail('MCP_SCHEMA_INVALID', `${relativePath} contains no MCP server`);
  }
  const servers: PluginMcpServer[] = [];
  for (const [name, raw] of Object.entries(value.mcpServers)) {
    if (!OFFICIAL_SERVER_NAME.test(name) || name.length > 80 || !isRecord(raw)) {
      readerFail('MCP_SCHEMA_INVALID', `${relativePath} contains an invalid server entry`);
    }
    servers.push(await normalizeServer(root, name, raw, 'official'));
  }
  return { servers, diagnostics: [] };
}

export async function parseCompatibleMcpObject(
  root: CanonicalPluginRoot,
  value: Record<string, unknown>,
): Promise<ParsedMcpServers> {
  const map = isRecord(value.mcpServers) ? value.mcpServers : value;
  const servers: PluginMcpServer[] = [];
  const diagnostics: PluginReaderDiagnostic[] = [];
  for (const [name, raw] of Object.entries(map)) {
    if (!name.trim() || name.length > 80 || !isRecord(raw)) {
      diagnostics.push({ code: 'MCP_SCHEMA_INVALID', capability: 'MCP', name });
      continue;
    }
    try {
      servers.push(await normalizeServer(root, name, raw, 'compatible'));
    } catch (error) {
      if (!(error instanceof PluginReaderError)) throw error;
      diagnostics.push({ code: error.code, capability: 'MCP', name });
    }
  }
  return { servers, diagnostics };
}

async function normalizeServer(
  root: CanonicalPluginRoot,
  name: string,
  raw: Record<string, unknown>,
  mode: McpConfigMode,
): Promise<PluginMcpServer> {
  assertNoMcpOauth(raw, name, mode);
  const transportType = resolveTransportType(raw, name, mode);
  const allowedFields = fieldsForTransport(transportType, mode);
  const unknown = Object.keys(raw).find((key) => !allowedFields.has(key));
  if (unknown !== undefined) {
    if (mode === 'official') {
      readerFail('MCP_SCHEMA_INVALID', `${name} contains an unknown field`);
    }
    readerFail('MCP_CONFIG_UNSUPPORTED', `${name} contains an unsupported field`);
  }

  const timeout = optionalPositiveInteger(raw.timeout, name);
  const description = optionalString(raw.description, name);
  const declaredTools = readDeclaredTools(raw.tools, name);
  const transport = await normalizeTransport({ root, raw, type: transportType, mode, name });
  const resolvedServer: ResolvedMcpServer = {
    name,
    transport,
    enabled: true,
    ...(timeout !== undefined ? { timeout } : {}),
  };
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    resolvedServer,
    declaredTools,
    configJson: JSON.stringify(raw),
  };
}

function assertNoMcpOauth(raw: Record<string, unknown>, name: string, mode: McpConfigMode): void {
  if (!Object.keys(raw).some((key) => OAUTH_FIELDS.has(key))) return;
  if (mode === 'official') readerFail('MCP_SCHEMA_INVALID', `${name} declares MCP OAuth`);
  readerFail('MCP_OAUTH_UNSUPPORTED', `${name} declares MCP OAuth`);
}

function resolveTransportType(
  raw: Record<string, unknown>,
  name: string,
  mode: McpConfigMode,
): McpTransportType {
  const declaredType = readDeclaredTransportType(raw.type, mode);
  if (mode === 'official' && declaredType === undefined) {
    readerFail('MCP_SCHEMA_INVALID', `${name} has no transport type`);
  }
  const inferredType = declaredType ?? inferCompatibleTransport(raw);
  if (!isMcpTransportType(inferredType) || (mode === 'official' && inferredType === 'http')) {
    if (mode === 'official') readerFail('MCP_SCHEMA_INVALID', `${name} has an invalid transport`);
    readerFail('MCP_TRANSPORT_UNSUPPORTED', `${name} has an unsupported transport`);
  }
  return inferredType;
}

function readDeclaredTransportType(value: unknown, mode: McpConfigMode): string | undefined {
  if (mode === 'official') return typeof value === 'string' ? value : undefined;
  return stringValue(value);
}

function inferCompatibleTransport(raw: Record<string, unknown>): string | undefined {
  if (stringValue(raw.command)) return 'stdio';
  if (stringValue(raw.url)) return 'http';
  return undefined;
}

function isMcpTransportType(value: string | undefined): value is McpTransportType {
  return value === 'stdio' || value === 'http' || value === 'streamable-http' || value === 'sse';
}

function fieldsForTransport(type: McpTransportType, mode: McpConfigMode): ReadonlySet<string> {
  if (mode === 'compatible') return COMPATIBLE_FIELDS;
  return type === 'stdio' ? OFFICIAL_STDIO_FIELDS : OFFICIAL_REMOTE_FIELDS;
}

async function normalizeTransport(input: {
  root: CanonicalPluginRoot;
  raw: Record<string, unknown>;
  type: McpTransportType;
  mode: McpConfigMode;
  name: string;
}): Promise<TransportConfig> {
  if (input.type === 'stdio') {
    return normalizeStdioTransport(input.root, input.raw, input.mode, input.name);
  }
  return normalizeRemoteTransport({ ...input, type: input.type });
}

async function normalizeStdioTransport(
  root: CanonicalPluginRoot,
  raw: Record<string, unknown>,
  mode: McpConfigMode,
  name: string,
): Promise<TransportConfig> {
  const command = stringValue(raw.command);
  if (!command) readerFail('MCP_SCHEMA_INVALID', `${name} has no stdio command`);
  if (mode === 'official' && /[/\\]/u.test(command)) {
    readerFail(
      'MCP_SCHEMA_INVALID',
      `${name} must launch package files through a PATH interpreter`,
    );
  }
  const args = raw.args === undefined ? [] : stringArray(raw.args, `${name}.args`);
  if (mode === 'official' && args.some(isCrossPlatformAbsolutePath)) {
    readerFail('MCP_SCHEMA_INVALID', `${name} contains an absolute stdio argument`);
  }
  const env = raw.env === undefined ? undefined : stringRecord(raw.env, `${name}.env`);
  return {
    type: 'stdio',
    command: await resolveRuntimeString(root, command, mode, true),
    args: await Promise.all(args.map((arg) => resolveRuntimeString(root, arg, mode))),
    ...(env
      ? {
          env: Object.fromEntries(
            Object.entries(env).map(([key, value]) => [
              key,
              expandCompatibleRoot(value, root.path, mode),
            ]),
          ),
        }
      : {}),
  };
}

function normalizeRemoteTransport(input: {
  root: CanonicalPluginRoot;
  raw: Record<string, unknown>;
  type: Exclude<McpTransportType, 'stdio'>;
  mode: McpConfigMode;
  name: string;
}): TransportConfig {
  const { root, raw, type, mode, name } = input;
  const url = stringValue(raw.url);
  if (!url || !isHttpUrl(url)) readerFail('MCP_SCHEMA_INVALID', `${name} has an invalid URL`);
  const headers =
    raw.headers === undefined ? undefined : stringRecord(raw.headers, `${name}.headers`);
  return {
    type: type === 'sse' ? 'sse' : 'http',
    url,
    ...(headers
      ? {
          headers: Object.fromEntries(
            Object.entries(headers).map(([key, value]) => [
              key,
              expandCompatibleRoot(value, root.path, mode),
            ]),
          ),
        }
      : {}),
  };
}

async function resolveRuntimeString(
  root: CanonicalPluginRoot,
  value: string,
  mode: McpConfigMode,
  mustExist = false,
): Promise<string> {
  const containsRoot = mode === 'compatible' && value.includes(COMPATIBLE_PLUGIN_ROOT_TOKEN);
  const expanded = expandCompatibleRoot(value, root.path, mode);
  const isExplicitRelative = /^\.{1,2}[/\\]/u.test(value);
  if (!containsRoot && !isExplicitRelative) return expanded;
  const candidate = containsRoot
    ? path.resolve(expanded)
    : path.resolve(root.path, ...expanded.split(/[\\/]/u));
  if (!isInside(root.path, candidate))
    readerFail('PATH_OUTSIDE_ROOT', 'MCP path escapes Plugin root');
  try {
    const canonical = await realpath(candidate);
    if (!isInside(root.path, canonical)) {
      readerFail('PATH_OUTSIDE_ROOT', 'MCP path resolves outside Plugin root');
    }
    return canonical;
  } catch (error) {
    if (error instanceof PluginReaderError) throw error;
    if (mustExist) {
      readerFail('MCP_SCHEMA_INVALID', 'MCP command path does not exist');
    }
    return candidate;
  }
}

function isCrossPlatformAbsolutePath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function expandCompatibleRoot(value: string, root: string, mode: McpConfigMode): string {
  return mode === 'compatible' ? value.replaceAll(COMPATIBLE_PLUGIN_ROOT_TOKEN, root) : value;
}

function readDeclaredTools(value: unknown, serverName: string): PluginDeclaredTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    readerFail('MCP_SCHEMA_INVALID', `${serverName}.tools is not an array`);
  const names = new Set<string>();
  return value.map((raw, index) => {
    if (!isRecord(raw)) {
      readerFail('MCP_SCHEMA_INVALID', `${serverName}.tools[${index}] is not an object`);
    }
    assertExactFields(raw, new Set(['name', 'description', 'inputSchema']), 'MCP tool');
    const name = stringValue(raw.name);
    if (!name || name.length > 80 || !TOOL_NAME.test(name)) {
      readerFail('MCP_SCHEMA_INVALID', `${serverName} has an invalid declared tool`);
    }
    if (names.has(name)) {
      readerFail('MCP_SCHEMA_INVALID', `${serverName} contains duplicate declared tool names`);
    }
    names.add(name);
    const description = optionalString(raw.description, `${serverName}.${name}`);
    if (raw.inputSchema !== undefined && !isRecord(raw.inputSchema)) {
      readerFail('MCP_SCHEMA_INVALID', `${serverName}.${name} inputSchema is not an object`);
    }
    return {
      name,
      ...(description !== undefined ? { description } : {}),
      inputSchema: (raw.inputSchema as Record<string, unknown> | undefined) ?? {},
    };
  });
}

function assertExactFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    readerFail('MCP_SCHEMA_INVALID', `${label} has an unknown field`);
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    readerFail('MCP_SCHEMA_INVALID', `${label} must contain only strings`);
  }
  return value as string[];
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'string')) {
    readerFail('MCP_SCHEMA_INVALID', `${label} must map strings to strings`);
  }
  return value as Record<string, string>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = stringValue(value);
  if (!parsed) readerFail('MCP_SCHEMA_INVALID', `${label} must be a non-empty string`);
  return parsed;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) {
    readerFail('MCP_SCHEMA_INVALID', `${label} timeout must be a positive integer`);
  }
  return value as number;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
