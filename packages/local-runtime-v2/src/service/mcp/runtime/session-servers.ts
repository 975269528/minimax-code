import type { McpConnectionPool } from '@mavis/mcp/runtime/connection-pool';
import type { McpConnectionTokenOverrides } from '@mavis/mcp/runtime/types';
import { sessionMcpConnectionKey, requireSessionId } from './settings-config.js';
import type { LocalMcpServerConfig, LocalMcpSessionServer } from '../contracts.js';
import { configToTransportConfig, normalizeServerName } from './config.js';

/** ACP-owned ephemeral configurations, independent of repository MCP configuration. */
export class SessionMcpServers {
  private readonly servers = new Map<string, Readonly<Record<string, LocalMcpServerConfig>>>();
  constructor(private readonly pool?: McpConnectionPool) {}
  get(sessionId: string): Readonly<Record<string, LocalMcpServerConfig>> | undefined {
    return this.servers.get(sessionId);
  }
  clear(): void {
    this.servers.clear();
  }

  async configure(sessionId: string, servers: readonly LocalMcpSessionServer[]): Promise<void> {
    const id = requireSessionId(sessionId);
    const next: Record<string, LocalMcpServerConfig> = Object.create(null);
    for (const server of servers) {
      const name = normalizeServerName(server.name);
      if (Object.hasOwn(next, name)) throw new Error(`Duplicate session MCP server name: ${name}`);
      const config = { ...server.config, enabled: true, configured: true, builtin: false };
      if (!configToTransportConfig(config))
        throw new Error(`Session MCP server "${name}" has no usable transport.`);
      next[name] = config;
    }
    await this.remove(id);
    if (Object.keys(next).length > 0) this.servers.set(id, Object.freeze(next));
  }

  async remove(sessionId: string): Promise<void> {
    const id = requireSessionId(sessionId);
    const current = this.servers.get(id);
    this.servers.delete(id);
    const pool = this.pool;
    if (!current || !pool) return;
    await Promise.allSettled(
      Object.keys(current).map((server) =>
        pool.disconnect(server, { connectionKey: sessionMcpConnectionKey(id, server) }),
      ),
    );
  }

  overrides(
    sessionId: string,
    server: string,
    config: LocalMcpServerConfig,
  ): McpConnectionTokenOverrides | undefined {
    const transport = configToTransportConfig(config);
    if (!transport) return undefined;
    return {
      connectionKey: sessionMcpConnectionKey(sessionId, server),
      serverOverride: {
        name: server,
        enabled: true,
        transport,
        ...(config.timeout && config.timeout > 0 ? { timeout: config.timeout } : {}),
      },
    };
  }
}
