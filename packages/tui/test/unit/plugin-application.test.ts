import { describe, expect, it, vi } from 'vitest';

import { McodePluginApplication } from '../../src/plugin/application.js';

const plugin = (name: string, marketplace: 'official' | 'local', installed: boolean) => ({
  pluginId: `${name}@${marketplace}`,
  name,
  displayName: name,
  marketplace,
  installed,
  enabled: installed,
  capabilities: { appCount: 0, mcpServerCount: 0, skillCount: 1 },
});

describe('McodePluginApplication', () => {
  it('partitions installed and available Plugins across the real Runtime sources', async () => {
    const port = {
      listInstalledPlugins: vi.fn(async () => [plugin('legacy', 'official', true)]),
      listMarketplacePlugins: vi
        .fn()
        .mockResolvedValueOnce([plugin('docs', 'official', false)])
        .mockResolvedValueOnce([plugin('notes', 'local', false)]),
    };
    const application = new McodePluginApplication(port as never);

    await expect(application.catalog({ includeAvailable: true })).resolves.toEqual({
      installed: [plugin('legacy', 'official', true)],
      available: [plugin('docs', 'official', false), plugin('notes', 'local', false)],
    });
    expect(port.listMarketplacePlugins).toHaveBeenNthCalledWith(1, {
      marketplace: 'official',
    });
    expect(port.listMarketplacePlugins).toHaveBeenNthCalledWith(2, {
      marketplace: 'local',
    });
    expect(port.listInstalledPlugins).toHaveBeenCalledWith({ marketplace: undefined });
  });

  it('applies mutations through the Runtime owner and returns the committed state', async () => {
    const selected = plugin('docs', 'official', false);
    const port = {
      mutatePlugin: vi
        .fn()
        .mockResolvedValueOnce({ installed: true, enabled: true })
        .mockResolvedValueOnce({ installed: true, enabled: false })
        .mockResolvedValueOnce({ installed: false, enabled: false }),
      refreshPlugins: vi.fn(async () => undefined),
    };
    const application = new McodePluginApplication(port as never);

    const installed = await application.install(selected);
    await expect(application.setEnabled(installed, false)).resolves.toMatchObject({
      installed: true,
      enabled: false,
    });
    await expect(application.remove(installed)).resolves.toMatchObject({
      installed: false,
      enabled: false,
    });
    await expect(application.refresh()).resolves.toBeUndefined();

    expect(port.mutatePlugin).toHaveBeenNthCalledWith(1, {
      action: 'install',
      plugin: { name: 'docs', marketplace: 'official' },
    });
    expect(port.mutatePlugin).toHaveBeenNthCalledWith(2, {
      action: 'disable',
      plugin: { name: 'docs', marketplace: 'official' },
    });
    expect(port.mutatePlugin).toHaveBeenNthCalledWith(3, {
      action: 'remove',
      plugin: { name: 'docs', marketplace: 'official' },
    });
    expect(port.refreshPlugins).toHaveBeenCalledOnce();
  });
});
