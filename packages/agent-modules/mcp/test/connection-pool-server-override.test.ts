import { beforeEach, describe, expect, it, vi } from 'vitest';

import { McpConnectionPool } from '../src/runtime/connection-pool.js';

const state = vi.hoisted(() => ({
  transports: [] as unknown[],
  clients: [] as Array<{ transport?: unknown }>,
}));

vi.mock('../src/runtime/transport/factory.js', () => ({
  createTransport: vi.fn((transport: unknown) => {
    const created = { transport, close: vi.fn(async () => undefined) };
    state.transports.push(created);
    return created;
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    transport?: unknown;

    constructor() {
      state.clients.push(this);
    }

    setRequestHandler(): void {}

    async connect(transport: unknown): Promise<void> {
      this.transport = transport;
    }

    async listTools(): Promise<{ tools: Array<{ name: string; inputSchema: object }> }> {
      return { tools: [{ name: 'ping', inputSchema: {} }] };
    }

    async close(): Promise<void> {}
  },
}));

describe('McpConnectionPool session server override', () => {
  beforeEach(() => {
    state.transports.length = 0;
    state.clients.length = 0;
  });

  it('connects from the ephemeral descriptor and isolates connections by explicit key', async () => {
    const pool = new McpConnectionPool({ getResolvedServer: () => null });
    const descriptor = {
      name: 'client-tools',
      enabled: true,
      transport: {
        type: 'stdio' as const,
        command: process.execPath,
        args: ['server.mjs'],
      },
    };

    await pool.listTools('client-tools', {
      connectionKey: 'acp-session:one:client-tools',
      serverOverride: descriptor,
    });
    await pool.listTools('client-tools', {
      connectionKey: 'acp-session:two:client-tools',
      serverOverride: descriptor,
    });

    expect(state.transports).toHaveLength(2);
    expect(state.clients).toHaveLength(2);
    expect(state.transports).toEqual([
      expect.objectContaining({ transport: descriptor.transport }),
      expect.objectContaining({ transport: descriptor.transport }),
    ]);

    await pool.shutdown();
  });

  it('separates raw server names from another server scope and disconnects only that server', async () => {
    const pool = new McpConnectionPool({
      getResolvedServer: (name) => ({
        name,
        enabled: true,
        transport: { type: 'http', url: `https://example.com/${name}` },
      }),
    });
    try {
      await pool.listTools('docs:scope');
      await pool.listTools('docs', { connectionKey: 'scope' });
      expect(state.clients).toHaveLength(2);
      await pool.disconnect('docs:scope');
      await pool.listTools('docs', { connectionKey: 'scope' });
      expect(state.clients).toHaveLength(2);
      await pool.listTools('docs:scope');
      expect(state.clients).toHaveLength(3);
    } finally {
      await pool.shutdown();
    }
  });

  it('does not mistake a JSON-shaped raw server for an encoded key during disconnect', async () => {
    const pool = new McpConnectionPool({
      getResolvedServer: (name) => ({
        name,
        enabled: true,
        transport: { type: 'http', url: 'https://example.com' },
      }),
    });
    try {
      await pool.listTools('docs', { connectionKey: 'scope' });
      await pool.disconnect('["docs","scope"]');
      await pool.listTools('docs', { connectionKey: 'scope' });
      expect(state.clients).toHaveLength(1);
      await pool.listTools('["docs","scope"]');
      expect(state.clients).toHaveLength(2);
      await pool.disconnect('["docs","scope"]');
      await pool.listTools('docs', { connectionKey: 'scope' });
      expect(state.clients).toHaveLength(2);
    } finally {
      await pool.shutdown();
    }
  });

  it('keeps relative and once-prefixed scopes equivalent without merging an explicit empty scope', async () => {
    const pool = new McpConnectionPool({
      getResolvedServer: (name) => ({
        name,
        enabled: true,
        transport: { type: 'http', url: 'https://example.com' },
      }),
    });
    try {
      await pool.listTools('docs');
      await pool.listTools('docs', { connectionKey: '' });
      expect(state.clients).toHaveLength(1);
      await pool.listTools('docs', { connectionKey: 'scope' });
      await pool.listTools('docs', { connectionKey: 'docs:scope' });
      expect(state.clients).toHaveLength(2);
      await pool.listTools('docs', { connectionKey: 'docs:' });
      expect(state.clients).toHaveLength(3);
      await pool.listTools('docs', { connectionKey: 'docs:docs:scope' });
      expect(state.clients).toHaveLength(4);
      await pool.disconnect('docs', { connectionKey: 'docs:scope' });
      await pool.listTools('docs');
      await pool.listTools('docs', { connectionKey: 'docs:' });
      expect(state.clients).toHaveLength(4);
      await pool.listTools('docs', { connectionKey: 'scope' });
      expect(state.clients).toHaveLength(5);
    } finally {
      await pool.shutdown();
    }
  });
});
