/**
 * SystemReminderRegistry — chain-of-responsibility registry for reminder providers.
 *
 * Each provider is a ReminderProviderFn that receives SystemReminderInput and
 * returns a string block (or undefined to skip). Providers are executed in
 * registration order and their outputs are assembled into <system-reminder>.
 *
 * Different AgentFrameworkType can register different sets of providers via
 * `appendFor()`. At build time, default providers run first, followed by any
 * framework-specific providers.
 */

import type { AgentFrameworkType, ReminderProviderFn } from './types.js';

// ─── Named Provider ─────────────────────────────────────────────────────────

export interface NamedProvider {
  name: string;
  fn: ReminderProviderFn;
  critical: boolean;
}

// ─── Registry ───────────────────────────────────────────────────────────────

export class SystemReminderRegistry {
  private readonly defaults: NamedProvider[] = [];
  private readonly perFramework = new Map<AgentFrameworkType, NamedProvider[]>();

  /** Append a provider that runs for ALL framework types. */
  append(name: string, provider: ReminderProviderFn): this {
    this.defaults.push({ name, fn: provider, critical: false });
    return this;
  }

  /** Append a default provider that still runs when full SR is disabled for a model. */
  appendCritical(name: string, provider: ReminderProviderFn): this {
    this.defaults.push({ name, fn: provider, critical: true });
    return this;
  }

  /** Append a provider that runs ONLY for a specific framework type. */
  appendFor(frameworkType: AgentFrameworkType, name: string, provider: ReminderProviderFn): this {
    let list = this.perFramework.get(frameworkType);
    if (!list) {
      list = [];
      this.perFramework.set(frameworkType, list);
    }
    list.push({ name, fn: provider, critical: false });
    return this;
  }

  /** Append a framework-specific provider that still runs when full SR is disabled. */
  appendCriticalFor(
    frameworkType: AgentFrameworkType,
    name: string,
    provider: ReminderProviderFn,
  ): this {
    let list = this.perFramework.get(frameworkType);
    if (!list) {
      list = [];
      this.perFramework.set(frameworkType, list);
    }
    list.push({ name, fn: provider, critical: true });
    return this;
  }

  /**
   * Resolve the full provider chain for a given framework type.
   * Returns default providers followed by any framework-specific providers.
   */
  resolve(frameworkType: AgentFrameworkType): NamedProvider[] {
    return [...this.defaults, ...(this.perFramework.get(frameworkType) ?? [])];
  }

  /** Resolve only critical providers, preserving the normal provider order. */
  resolveCritical(frameworkType: AgentFrameworkType): NamedProvider[] {
    return this.resolve(frameworkType).filter((np) => np.critical);
  }
}
