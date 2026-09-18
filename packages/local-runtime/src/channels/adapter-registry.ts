import type { ChannelPlatform } from './route-api.js';
import type { LocalChannelContext } from './infra.js';
import type { LocalChannelPlatformAdapter } from './adapter.js';

/**
 * Registry of concrete platform adapters, keyed by `(platform, clientName)`.
 *
 * Multi-instance is a first-class concern: a single platform (e.g. `telegram`)
 * may have several bound bots, each with its own stable `clientName`
 * (`telegram:support`, `telegram:ops`, …). The registry therefore keys on the
 * exact `${platform}:${clientName}` pair and NEVER silently falls back to a
 * different instance of the same platform — an unknown context returns
 * `undefined` so the caller can reject the missing exact edge or return 404
 * rather than mis-routing one bot's traffic to another.
 *
 * This is a distinct layer from `LocalMultiChannelClientRegistry` in
 * `runner.ts`: that one tracks exact outbound SDK clients, whereas this
 * registry tracks the unified `LocalChannelPlatformAdapter` instances that own
 * the full inbound/outbound platform edge. The two registries are deliberately
 * separate, and neither has a platform-level fallback.
 */
export class LocalChannelAdapterRegistry {
  private readonly adapters = new Map<string, LocalChannelPlatformAdapter>();

  /**
   * Register (or replace) the adapter for an exact `(platform, clientName)`
   * pair. Registering `telegram:a` never touches `telegram:b`.
   */
  register(adapter: LocalChannelPlatformAdapter): void {
    this.adapters.set(adapterKey(adapter.platform, adapter.clientName), adapter);
  }

  /**
   * Remove a single instance. Returns true if an adapter was removed. Removing
   * one instance leaves every other instance of the same platform intact.
   */
  unregister(platform: ChannelPlatform, clientName: string): boolean {
    return this.adapters.delete(adapterKey(platform, clientName));
  }

  /** Exact lookup by `(platform, clientName)`. */
  get(platform: ChannelPlatform, clientName: string): LocalChannelPlatformAdapter | undefined {
    return this.adapters.get(adapterKey(platform, clientName));
  }

  /**
   * List all adapters, optionally filtered to a single platform. Order is
   * insertion order (Map semantics); callers that need a stable order should
   * sort by `clientName`.
   */
  list(platform?: ChannelPlatform): LocalChannelPlatformAdapter[] {
    const all = [...this.adapters.values()];
    return platform ? all.filter((adapter) => adapter.platform === platform) : all;
  }

  /**
   * Resolve the adapter for an inbound/outbound context. Exact match on
   * `(ctx.platform, ctx.clientName)`. Returns `undefined` when no instance is
   * registered for that exact pair — by design, no cross-instance fallback.
   */
  getForContext(ctx: LocalChannelContext): LocalChannelPlatformAdapter | undefined {
    return this.get(ctx.platform, ctx.clientName);
  }

  /** Number of registered adapter instances. */
  get size(): number {
    return this.adapters.size;
  }
}

function adapterKey(platform: ChannelPlatform, clientName: string): string {
  return `${platform}:${clientName}`;
}
