import type { PluginServiceMetrics } from './contracts.js';
import type { PluginSnapshot } from './plugin/runtime/snapshot-builder.js';

/** Bounded, privacy-safe metrics emitted by the Desktop Plugin System. */
export class PluginSystemMetrics {
  private readonly publicationQueuedAt = new WeakMap<object, number>();

  constructor(private readonly client?: PluginServiceMetrics) {}

  officialSync(
    trigger: 'startup' | 'manual' | 'recovery',
    status: 'success' | 'error' | 'superseded',
    startedAt: number,
  ): void {
    const tags = { trigger, status };
    this.client?.incr('plugin_official_sync_total', tags);
    this.client?.latency('plugin_official_sync_duration_ms', Date.now() - startedAt, tags);
  }

  operation(operation: string, status: string, startedAt: number): void {
    const tags = { operation, status };
    this.client?.incr('plugin_operation_total', tags);
    this.client?.latency('plugin_operation_duration_ms', Date.now() - startedAt, tags);
  }

  localScan(
    status: 'success' | 'partial' | 'error',
    startedAt: number,
    packageCount?: number,
    diagnosticCount?: number,
  ): void {
    const tags = { status };
    this.client?.incr('plugin_local_scan_total', tags);
    this.client?.latency('plugin_local_scan_duration_ms', Date.now() - startedAt, tags);
    if (packageCount !== undefined) {
      this.client?.latency('plugin_local_scan_package_count', packageCount, tags);
    }
    if (diagnosticCount !== undefined) {
      this.client?.latency('plugin_local_scan_diagnostic_count', diagnosticCount, tags);
    }
  }

  publicationQueued(publication: object): void {
    this.publicationQueuedAt.set(publication, Date.now());
  }

  publication(publication: object, status: 'success' | 'error' | 'superseded'): void {
    const queuedAt = this.publicationQueuedAt.get(publication);
    if (queuedAt === undefined) return;
    this.publicationQueuedAt.delete(publication);
    this.client?.incr('plugin_publication_total', { status });
    this.client?.latency('plugin_publication_wait_duration_ms', Date.now() - queuedAt, { status });
  }

  snapshot(snapshot: PluginSnapshot): void {
    const appProviders = new Set(snapshot.enabledPlugins.flatMap((plugin) => plugin.appProviders));
    const counts: Record<string, number> = {
      official_plugin: snapshot.officialPackages.length,
      local_plugin: snapshot.localPlugins.length,
      enabled_plugin: snapshot.enabledPlugins.length,
      app_provider: appProviders.size,
      skill: snapshot.skills.length,
      mcp_server: snapshot.mcpServers.length,
      mcp_tool: snapshot.turnCapabilities.runtimeToolBindings.filter(
        (binding) => binding.kind === 'mcp',
      ).length,
      diagnostic: snapshot.diagnostics.length,
    };
    for (const [component, count] of Object.entries(counts)) {
      this.client?.gauge('plugin_snapshot_component_count', count, { component });
    }
  }
}
