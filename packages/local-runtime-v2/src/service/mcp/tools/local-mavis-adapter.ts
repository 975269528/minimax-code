import { LocalMcpSettingsError } from '../errors.js';
import type {
  ConfiguredMcpServerSummary,
  ConfiguredMcpServerDetail,
  ConfiguredMcpServerInput,
} from '../contracts.js';
import type {
  LocalMavisMcpAdapter,
  LocalMavisMcpCreateRequest,
  LocalMavisMcpUpdateRequest,
} from '@mavis/agent-tools/desktop';

type EmitBusEvent = (type: string, payload: Record<string, unknown>) => void;

export class LocalMavisMcpServiceAdapter implements LocalMavisMcpAdapter {
  constructor(
    private readonly service: {
      listConfiguredServers(keyword?: string): Promise<ConfiguredMcpServerSummary[]>;
      getConfiguredServer(name: string): Promise<ConfiguredMcpServerDetail | undefined>;
      createConfiguredServer(
        name: string,
        config: ConfiguredMcpServerInput,
        enabled?: boolean,
      ): Promise<ConfiguredMcpServerDetail>;
      updateConfiguredServer(
        name: string,
        config: ConfiguredMcpServerInput,
        enabled?: boolean,
      ): Promise<ConfiguredMcpServerDetail>;
      deleteConfiguredServer(name: string): Promise<boolean>;
    },
    private readonly emitBusEvent: EmitBusEvent,
  ) {}

  async listServers(
    req: { search?: string },
    signal?: AbortSignal,
  ): Promise<{ servers: unknown[] }> {
    throwIfAborted(signal);
    const servers = await this.service.listConfiguredServers(req.search);
    return {
      servers: servers.map(({ configJson: _configJson, ...server }) => server),
    };
  }

  async getServer(req: { name: string }, signal?: AbortSignal): Promise<{ server?: unknown }> {
    throwIfAborted(signal);
    const server = await this.service.getConfiguredServer(req.name);
    return server ? { server: toSafeServer(server) } : {};
  }

  async createServer(
    req: LocalMavisMcpCreateRequest,
    signal?: AbortSignal,
  ): Promise<{ server: unknown }> {
    throwIfAborted(signal);
    const server = await this.service.createConfiguredServer(
      req.name,
      createInput(req),
      req.enabled ?? true,
    );
    this.emitChanged('create', req.name);
    return { server: toSafeServer(server) };
  }

  async updateServer(
    req: LocalMavisMcpUpdateRequest,
    signal?: AbortSignal,
  ): Promise<{ server: unknown }> {
    throwIfAborted(signal);
    const current = await this.service.getConfiguredServer(req.name);
    if (!current) {
      throw new LocalMcpSettingsError(404, 'MCP server not found.', 'MCP_SERVER_NOT_FOUND');
    }
    const config = mergeInput(current.config, req);
    const server = await this.service.updateConfiguredServer(req.name, config, req.enabled);
    this.emitChanged('update', req.name);
    return { server: toSafeServer(server) };
  }

  async deleteServer(req: { name: string }, signal?: AbortSignal): Promise<{ success: boolean }> {
    throwIfAborted(signal);
    const success = await this.service.deleteConfiguredServer(req.name);
    this.emitChanged('delete', req.name);
    return { success };
  }

  private emitChanged(operation: 'create' | 'update' | 'delete', name: string): void {
    this.emitBusEvent('mcp.settings.changed', { operation, name });
  }
}

function createInput(req: LocalMavisMcpCreateRequest): ConfiguredMcpServerInput {
  const common = {
    ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
    ...(req.description !== undefined ? { description: req.description } : {}),
  };
  if (req.transport === 'stdio') {
    if (!req.command) throw invalidConfig('A command is required for stdio MCP servers.');
    return {
      transport: 'stdio',
      command: req.command,
      ...(req.args !== undefined ? { args: req.args } : {}),
      ...(req.env !== undefined ? { env: req.env } : {}),
      ...common,
    };
  }
  if (!req.url) throw invalidConfig('A URL is required for remote MCP servers.');
  return {
    transport: req.transport,
    url: req.url,
    ...(req.headers !== undefined ? { headers: req.headers } : {}),
    ...common,
  };
}

function mergeInput(
  current: ConfiguredMcpServerInput,
  patch: LocalMavisMcpUpdateRequest,
): ConfiguredMcpServerInput {
  const transport = patch.transport ?? current.transport;
  if (transport !== current.transport) return createInputForTransportSwitch(transport, patch);

  const timeoutMs = resolveTimeoutMs(current.timeoutMs, patch);
  const description = resolveDescription(current.description, patch);
  const common = {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(description !== undefined ? { description } : {}),
  };
  return mergeTransportInput(current, patch, common);
}
function mergeTransportInput(
  current: ConfiguredMcpServerInput,
  patch: LocalMavisMcpUpdateRequest,
  common: { timeoutMs?: number; description?: string },
): ConfiguredMcpServerInput {
  if (current.transport === 'stdio') {
    if (patch.url !== undefined || patch.headers !== undefined) {
      throw invalidConfig('stdio MCP servers do not accept remote fields.');
    }
    return {
      transport: 'stdio',
      command: patch.command ?? current.command,
      ...optionalField('args', patch.args !== undefined ? patch.args : current.args),
      ...optionalField('env', patch.env !== undefined ? patch.env : current.env),
      ...common,
    };
  }
  if (hasStdioFields(patch)) {
    throw invalidConfig('Remote MCP servers do not accept stdio fields.');
  }
  return {
    transport: current.transport,
    url: patch.url ?? current.url,
    ...optionalField('headers', patch.headers !== undefined ? patch.headers : current.headers),
    ...common,
  };
}

function createInputForTransportSwitch(
  transport: ConfiguredMcpServerInput['transport'],
  patch: LocalMavisMcpUpdateRequest,
): ConfiguredMcpServerInput {
  if (transport === 'stdio') return switchToStdio(patch);

  if (!patch.url?.trim()) throw invalidConfig('Switching to a remote transport requires a URL.');
  if (hasStdioFields(patch)) {
    throw invalidConfig('Remote MCP servers do not accept stdio fields.');
  }
  return {
    transport,
    url: patch.url,
    ...(patch.headers !== undefined ? { headers: patch.headers } : {}),
    ...switchCommon(patch),
  };
}

function resolveTimeoutMs(
  current: number | undefined,
  patch: LocalMavisMcpUpdateRequest,
): number | undefined {
  if (!Object.hasOwn(patch, 'timeoutMs')) return current;
  return patch.timeoutMs ?? undefined;
}

function resolveDescription(
  current: string | undefined,
  patch: LocalMavisMcpUpdateRequest,
): string | undefined {
  if (!Object.hasOwn(patch, 'description')) return current;
  return patch.description ?? undefined;
}

function toSafeServer(server: ConfiguredMcpServerDetail): Record<string, unknown> {
  const common = {
    name: server.name,
    enabled: server.enabled,
  };
  if (server.config.transport === 'stdio') {
    return {
      ...common,
      config: {
        transport: 'stdio',
        command: server.config.command,
        ...(server.config.args !== undefined ? { args: server.config.args } : {}),
        ...(server.config.env !== undefined
          ? { envKeys: Object.keys(server.config.env).sort() }
          : {}),
        ...(server.config.timeoutMs !== undefined ? { timeoutMs: server.config.timeoutMs } : {}),
        ...(server.config.description !== undefined
          ? { description: server.config.description }
          : {}),
      },
    };
  }
  return {
    ...common,
    config: {
      transport: server.config.transport,
      endpoint: safeEndpoint(server.config.url),
      ...(server.config.headers !== undefined
        ? { headerKeys: Object.keys(server.config.headers).sort() }
        : {}),
      ...(server.config.timeoutMs !== undefined ? { timeoutMs: server.config.timeoutMs } : {}),
      ...(server.config.description !== undefined
        ? { description: server.config.description }
        : {}),
    },
  };
}

function safeEndpoint(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return '';
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function invalidConfig(message: string): LocalMcpSettingsError {
  return new LocalMcpSettingsError(400, message, 'MCP_CONFIG_INVALID');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException('Operation aborted', 'AbortError');
}

function switchToStdio(patch: LocalMavisMcpUpdateRequest): ConfiguredMcpServerInput {
  if (!patch.command?.trim()) throw invalidConfig('Switching to stdio requires a command.');
  if (patch.url !== undefined || patch.headers !== undefined)
    throw invalidConfig('stdio MCP servers do not accept remote fields.');
  return {
    transport: 'stdio',
    command: patch.command,
    ...optionalField('args', patch.args),
    ...optionalField('env', patch.env),
    ...switchCommon(patch),
  };
}
function switchCommon(patch: LocalMavisMcpUpdateRequest) {
  return {
    ...(patch.timeoutMs !== undefined && patch.timeoutMs !== null
      ? { timeoutMs: patch.timeoutMs }
      : {}),
    ...(patch.description !== undefined && patch.description !== null
      ? { description: patch.description }
      : {}),
  };
}
function optionalField<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function hasStdioFields(patch: LocalMavisMcpUpdateRequest): boolean {
  return patch.command !== undefined || patch.args !== undefined || patch.env !== undefined;
}
