import { mkdtemp, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createNodeAuthLeaseClient } from '@mavis/oauth-lease-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startMcodeToolsAuthLeaseBroker } from '../../src/lease-broker.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('mcode-tools auth lease broker', () => {
  it('serves fixed leases and removes the private capability on dispose', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'mtb-'));
    const stopWatching = vi.fn();
    const broker = await startMcodeToolsAuthLeaseBroker({
      dataDir,
      session: {
        getStatus: async () => ({ status: 'authenticated', generation: 3 }),
        getAccessToken: async () => ({
          accessToken: 'at-3',
          expiresAtMs: Date.now() + 120_000,
          generation: 3,
          audience: 'agent-backend',
          scopes: ['agent.default'],
        }),
        handleUnauthorized: async () => 'retry',
        watch: () => stopWatching,
      },
    });
    cleanups.push(() => broker.dispose());
    const client = createNodeAuthLeaseClient({
      endpoint: broker.endpoint,
      capabilityFile: broker.capabilityFile,
    });
    cleanups.push(async () => client.close());

    await expect(client.getLease(30_000)).resolves.toMatchObject({
      accessToken: 'at-3',
      generation: 3,
      audience: 'agent-backend',
      scopes: ['agent.default'],
    });
    expect((await readFile(broker.capabilityFile, 'utf8')).trim()).toHaveLength(43);
    if (process.platform !== 'win32') {
      expect((await stat(broker.capabilityFile)).mode & 0o777).toBe(0o600);
    }

    await broker.dispose();
    await expect(stat(broker.capabilityFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(stopWatching).toHaveBeenCalledOnce();
  });

  it('rejects a lease outside the fixed audience contract', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'mtb-'));
    const broker = await startMcodeToolsAuthLeaseBroker({
      dataDir,
      session: {
        getStatus: async () => ({ status: 'authenticated', generation: 1 }),
        getAccessToken: async () => ({
          accessToken: 'wrong-at',
          expiresAtMs: Date.now() + 120_000,
          generation: 1,
          audience: 'wrong-audience' as 'agent-backend',
          scopes: ['agent.default'],
        }),
        handleUnauthorized: async () => 'logout',
        watch: () => () => undefined,
      },
    });
    cleanups.push(() => broker.dispose());
    const client = createNodeAuthLeaseClient({
      endpoint: broker.endpoint,
      capabilityFile: broker.capabilityFile,
    });
    cleanups.push(async () => client.close());

    await expect(client.getLease(30_000)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
