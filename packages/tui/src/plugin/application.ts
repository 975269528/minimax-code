import type {
  McodePluginCatalog,
  McodePluginMarketplace,
  McodePluginRuntimeAccess,
  McodePluginView,
} from './contract.js';

export class McodePluginApplication {
  constructor(private readonly access: McodePluginRuntimeAccess) {}

  async catalog(input: {
    readonly includeAvailable: boolean;
    readonly marketplace?: McodePluginMarketplace;
  }): Promise<McodePluginCatalog> {
    if (!input.includeAvailable) {
      return {
        installed: await this.access.listInstalledPlugins({
          marketplace: input.marketplace,
        }),
        available: [],
      };
    }
    const marketplaces: readonly McodePluginMarketplace[] = input.marketplace
      ? [input.marketplace]
      : ['official', 'local'];
    const [installed, ...marketplaceCatalogs] = await Promise.all([
      this.access.listInstalledPlugins({ marketplace: input.marketplace }),
      ...marketplaces.map((marketplace) => this.access.listMarketplacePlugins({ marketplace })),
    ]);
    const merged = new Map(
      marketplaceCatalogs.flat().map((plugin) => [plugin.pluginId, plugin] as const),
    );
    for (const plugin of installed) merged.set(plugin.pluginId, plugin);
    return partitionCatalog([...merged.values()]);
  }

  install(plugin: McodePluginView): Promise<McodePluginView> {
    return this.mutate(plugin, 'install');
  }

  remove(plugin: McodePluginView): Promise<McodePluginView> {
    return this.mutate(plugin, 'remove');
  }

  setEnabled(plugin: McodePluginView, enabled: boolean): Promise<McodePluginView> {
    return this.mutate(plugin, enabled ? 'enable' : 'disable');
  }

  refresh(): Promise<void> {
    return this.access.refreshPlugins();
  }

  private async mutate(
    plugin: McodePluginView,
    action: 'install' | 'remove' | 'enable' | 'disable',
  ): Promise<McodePluginView> {
    const result = await this.access.mutatePlugin({
      action,
      plugin: { name: plugin.name, marketplace: plugin.marketplace },
    });
    return { ...plugin, ...result };
  }
}

function partitionCatalog(plugins: readonly McodePluginView[]): McodePluginCatalog {
  const installed: McodePluginView[] = [];
  const available: McodePluginView[] = [];
  for (const plugin of plugins) {
    (plugin.installed ? installed : available).push(plugin);
  }
  return { installed, available };
}
