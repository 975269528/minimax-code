import type { LocalChannelBridgeInfra } from '../channels/infra.js';

export interface ChannelShutdownHostHandle {
  channelBridgeInfra: LocalChannelBridgeInfra;
  emitBusEvent(type: string, payload: Record<string, unknown>): void;
}

export async function shutdownChannelSubsystem(host: ChannelShutdownHostHandle): Promise<void> {
  const adapters = host.channelBridgeInfra.adapterRegistry.list();
  for (const adapter of adapters) {
    if (!adapter.shutdown) continue;
    try {
      await adapter.shutdown();
    } catch (err) {
      host.emitBusEvent('channel.shutdown_failed', {
        platform: adapter.platform,
        clientName: adapter.clientName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
