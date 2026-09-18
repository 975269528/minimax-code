import { isIP } from 'node:net';
import {
  getDefaultSandboxSettings,
  normalizeSandboxSettings,
  type SandboxFilesystemModeName,
} from './sandbox-settings.js';

export type SandboxFilesystemPolicy =
  | { mode: 'read_only' }
  | { mode: 'workspace_write' }
  | { mode: 'delete_guard' }
  | { mode: 'full_access' };

export type SandboxNetworkPolicy = { mode: 'deny' } | { mode: 'allow_all' };

export type SandboxLocalAccess = 'open' | 'restricted';

export interface SandboxConfig {
  enabled: boolean;
  filesystem: {
    policy: SandboxFilesystemPolicy;
    denyRead: string[];
    denyWrite: string[];
  };
  network: {
    policy: SandboxNetworkPolicy;
    deniedDomains: string[];
  };
  localAccess: SandboxLocalAccess;
}

export function getSandboxConfigDefaults(platform: NodeJS.Platform): SandboxConfig {
  const settings = getDefaultSandboxSettings(platform);
  return {
    enabled: settings.enabled,
    filesystem: {
      policy: { mode: settings.filesystemMode },
      denyRead: [],
      denyWrite: [],
    },
    network: {
      policy: { mode: 'allow_all' },
      deniedDomains: [],
    },
    localAccess: 'open',
  };
}

export const SANDBOX_CONFIG_DEFAULTS = getSandboxConfigDefaults(process.platform);

const FILESYSTEM_MODES = new Set(['read_only', 'workspace_write', 'delete_guard', 'full_access']);
const NETWORK_MODES = new Set(['deny', 'allow_all']);

export function parseSandboxConfig(
  raw: unknown,
  platform: NodeJS.Platform = process.platform,
): SandboxConfig {
  const defaults = getSandboxConfigDefaults(platform);
  if (raw === undefined) return defaults;
  const root = strictRecord(raw, 'sandbox', ['enabled', 'filesystem', 'network', 'localAccess']);
  const filesystem =
    root.filesystem === undefined
      ? {}
      : strictRecord(root.filesystem, 'sandbox.filesystem', [
          'policy',
          'denyRead',
          'denyWrite',
          // Legacy key: older releases persisted `allowGitConfig` when the
          // settings UI saved the full sandbox object. Git config writes are
          // now always allowed and the toggle no longer exists, so any
          // persisted value (including `false`) is deliberately ignored
          // instead of rejected.
          'allowGitConfig',
        ]);
  const filesystemPolicy =
    filesystem.policy === undefined
      ? {}
      : strictRecord(filesystem.policy, 'sandbox.filesystem.policy', ['mode']);
  const network =
    root.network === undefined
      ? {}
      : strictRecord(root.network, 'sandbox.network', ['policy', 'deniedDomains']);
  const networkPolicy =
    network.policy === undefined
      ? {}
      : strictRecord(network.policy, 'sandbox.network.policy', ['mode']);

  const enabled =
    root.enabled === undefined ? defaults.enabled : booleanValue(root.enabled, 'sandbox.enabled');
  // If explicitly enabled without a level, use deletion protection and let the runtime reject unsupported platforms.
  const filesystemMode = filesystemPolicy.mode ?? (enabled ? 'delete_guard' : 'full_access');
  if (typeof filesystemMode !== 'string' || !FILESYSTEM_MODES.has(filesystemMode)) {
    throw new Error(`Invalid sandbox.filesystem.policy.mode "${String(filesystemMode)}"`);
  }
  const networkMode = networkPolicy.mode ?? defaults.network.policy.mode;
  if (typeof networkMode !== 'string' || !NETWORK_MODES.has(networkMode)) {
    throw new Error(`Invalid sandbox.network.policy.mode "${String(networkMode)}"`);
  }
  const deniedDomains =
    network.deniedDomains === undefined
      ? [...defaults.network.deniedDomains]
      : stringArray(network.deniedDomains, 'sandbox.network.deniedDomains');
  for (const pattern of deniedDomains) assertDeniedDomainPattern(pattern);

  const settings = normalizeSandboxSettings({
    enabled,
    filesystemMode: filesystemMode as SandboxFilesystemModeName,
  });

  return {
    enabled: settings.enabled,
    filesystem: {
      policy: { mode: settings.filesystemMode },
      denyRead:
        filesystem.denyRead === undefined
          ? [...defaults.filesystem.denyRead]
          : stringArray(filesystem.denyRead, 'sandbox.filesystem.denyRead'),
      denyWrite:
        filesystem.denyWrite === undefined
          ? [...defaults.filesystem.denyWrite]
          : stringArray(filesystem.denyWrite, 'sandbox.filesystem.denyWrite'),
    },
    // Legacy network settings (deny mode and deniedDomains blocklist) are supported only for reading:
    // after validation, normalize to unrestricted access. Desktop Sandbox no longer actively restricts networking.
    network: {
      policy: { mode: 'allow_all' },
      deniedDomains: [],
    },
    localAccess:
      root.localAccess === undefined
        ? defaults.localAccess
        : root.localAccess === 'open' || root.localAccess === 'restricted'
          ? root.localAccess
          : (() => {
              throw new Error(`Invalid sandbox.localAccess "${String(root.localAccess)}"`);
            })(),
  };
}

function strictRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${path}: expected object`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !allowedKeys.includes(key));
  if (unknown) throw new Error(`Unknown ${path}.${unknown}`);
  return record;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${path}: expected boolean`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Invalid ${path}: expected string array`);
  }
  return [...value];
}

function assertDeniedDomainPattern(pattern: string): void {
  const reject = () => {
    throw new Error(`Invalid sandbox.network.deniedDomains entry "${pattern}"`);
  };
  const bracketedIpv6 = pattern.match(/^\[([^\]]+)\](?::(.+))?$/);
  if (bracketedIpv6) {
    if (isIP(bracketedIpv6[1] ?? '') !== 6) reject();
    assertPort(bracketedIpv6[2], pattern);
    return;
  }
  if ((pattern.match(/:/g) ?? []).length > 1) {
    reject();
  }

  const portSeparator = pattern.lastIndexOf(':');
  const host = portSeparator > -1 ? pattern.slice(0, portSeparator) : pattern;
  const port = portSeparator > -1 ? pattern.slice(portSeparator + 1) : undefined;
  assertPort(port, pattern);
  if (host === '*') return;
  if (!isValidDomainPattern(host)) reject();
}

function isValidDomainPattern(host: string): boolean {
  if (host.includes('://') || host.includes('/') || host.includes(':')) return false;
  if (host === 'localhost') return true;
  if (host.startsWith('*.')) {
    const domain = host.slice(2);
    const parts = domain.split('.');
    return parts.length >= 2 && parts.every((part) => part.length > 0);
  }
  if (host.includes('*')) return false;
  return host.includes('.') && !host.startsWith('.') && !host.endsWith('.');
}

function assertPort(port: string | undefined, pattern: string): void {
  if (port === undefined) return;
  const value = Number(port);
  if (!/^[1-9][0-9]{0,4}$/.test(port) || !Number.isInteger(value) || value > 65_535) {
    throw new Error(`Invalid sandbox.network.deniedDomains entry "${pattern}"`);
  }
}
