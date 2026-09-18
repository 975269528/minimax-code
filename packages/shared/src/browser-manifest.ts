/**
 * Shared native messaging manifest helpers for browser bridge installers.
 *
 * Keep this module side-effect free: CLI commands, daemon install APIs, and
 * tests import it before touching the filesystem. The browser bridge has one
 * stable Chrome extension ID, while each Mavis profile gets an isolated native
 * messaging host name and manifest path.
 */

import os from 'node:os';
import path from 'node:path';

/**
 * Fixed Chrome extension ID derived from the public key embedded in
 * `extension/manifest.json`. Chrome derives the ID by hashing the manifest
 * `key`; `scripts/verify-extension-id.sh` guards this constant against drift.
 */
export const MAVIS_BROWSER_EXTENSION_ID = 'ppnnfacnjgokfmbngkgbdgiigpbfgdba';

export interface NativeMessagingManifest {
  name: string;
  description: string;
  path: string;
  type: 'stdio';
  allowed_origins: string[];
}

export interface ManifestOptions {
  /** Mavis profile name (e.g. "default", "dev") */
  profile: string;
  /** Absolute path to the host wrapper script */
  hostPath: string;
}

/** Supported Chromium-based browsers. */
export type BrowserName = 'chrome' | 'chromium' | 'brave' | 'edge' | 'arc';

export interface BrowserHostDir {
  browser: BrowserName;
  dir: string;
}

/** Registry key path for a given browser's NativeMessagingHosts. */
export interface WindowsRegistryEntry {
  browser: BrowserName;
  /** Full registry key, e.g. HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\<host> */
  key: string;
}

/**
 * Compute the native messaging host name for a Mavis profile.
 *
 * Native messaging host names are global per browser profile. Encoding the
 * Mavis profile into the host name lets `default`, worktree, and test daemons
 * register independently instead of clobbering each other's manifests.
 */
export function getHostName(profile: string): string {
  const sanitized = profile.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `com.mavis.browser_${sanitized}`;
}

/** Generate a native messaging manifest object for a given profile. */
export function generateManifest(opts: ManifestOptions): NativeMessagingManifest {
  return {
    name: getHostName(opts.profile),
    description: `Mavis browser native messaging host (profile: ${opts.profile})`,
    path: opts.hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${MAVIS_BROWSER_EXTENSION_ID}/`],
  };
}

/** Serialize a manifest to JSON string with a trailing newline. */
export function serializeManifest(manifest: NativeMessagingManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Get NativeMessagingHosts directories for all supported Chromium browsers.
 *
 * macOS/Linux discover manifests by scanning per-browser directories. Windows
 * discovers manifests via registry keys; the directory returned here is the
 * shared file location those registry values point at.
 */
export function getNativeHostDirs(platform: string = process.platform): BrowserHostDir[] {
  if (platform === 'win32') {
    // Chrome-family browsers on Windows do not scan arbitrary filesystem
    // locations. We write all manifests to one stable user-local directory,
    // then register one HKCU key per browser in getWindowsRegistryEntries().
    const base = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Mavis',
      'NativeMessagingHosts',
    );
    return [
      { browser: 'chrome', dir: base },
      { browser: 'chromium', dir: base },
      { browser: 'brave', dir: base },
      { browser: 'edge', dir: base },
    ];
  }

  if (platform === 'darwin') {
    const base = path.join(os.homedir(), 'Library', 'Application Support');
    return [
      { browser: 'chrome', dir: path.join(base, 'Google', 'Chrome', 'NativeMessagingHosts') },
      { browser: 'chromium', dir: path.join(base, 'Chromium', 'NativeMessagingHosts') },
      {
        browser: 'brave',
        dir: path.join(base, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      },
      { browser: 'edge', dir: path.join(base, 'Microsoft Edge', 'NativeMessagingHosts') },
      { browser: 'arc', dir: path.join(base, 'Arc', 'User Data', 'NativeMessagingHosts') },
    ];
  }

  const base = path.join(os.homedir(), '.config');
  return [
    { browser: 'chrome', dir: path.join(base, 'google-chrome', 'NativeMessagingHosts') },
    { browser: 'chromium', dir: path.join(base, 'chromium', 'NativeMessagingHosts') },
    {
      browser: 'brave',
      dir: path.join(base, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
    },
    { browser: 'edge', dir: path.join(base, 'microsoft-edge', 'NativeMessagingHosts') },
  ];
}

/** Get the manifest file name for a given profile. */
export function getManifestFileName(profile: string): string {
  return `${getHostName(profile)}.json`;
}

/** Get the full manifest file path for a given browser host dir and profile. */
export function getManifestPath(hostDir: string, profile: string): string {
  return path.join(hostDir, getManifestFileName(profile));
}

/**
 * Generate a wrapper script that launches native-host.cjs with profile env.
 *
 * Chrome's native messaging manifest accepts a single executable path only;
 * the wrapper injects MAVIS_PROFILE and MAVIS_BROWSER_BROKER_SOCKET before
 * handing control to Node/native-host.cjs.
 */
export function generateHostWrapper(opts: {
  nodePath: string;
  nativeHostCjsPath: string;
  profile: string;
  brokerSocketPath: string;
}): string {
  if ((process.platform as string) === 'win32') {
    return [
      '@echo off',
      `set MAVIS_PROFILE=${opts.profile}`,
      `set MAVIS_BROWSER_BROKER_SOCKET=${opts.brokerSocketPath}`,
      `"${opts.nodePath}" "${opts.nativeHostCjsPath}"`,
      '',
    ].join('\r\n');
  }

  return [
    '#!/bin/sh',
    `# Mavis browser native host wrapper (profile: ${opts.profile})`,
    '# Auto-generated by Mavis desktop browser integration — do not edit manually',
    `export MAVIS_PROFILE="${opts.profile}"`,
    `export MAVIS_BROWSER_BROKER_SOCKET="${opts.brokerSocketPath}"`,
    `exec "${opts.nodePath}" "${opts.nativeHostCjsPath}"`,
    '',
  ].join('\n');
}

/**
 * Return the per-browser HKCU registry keys used on Windows.
 *
 * The default value of each key must be the absolute manifest JSON path for
 * that browser. Install/uninstall code owns writing/removing those values.
 */
export function getWindowsRegistryEntries(hostName: string): WindowsRegistryEntry[] {
  const base = 'HKCU\\SOFTWARE';
  return [
    {
      browser: 'chrome',
      key: `${base}\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`,
    },
    {
      browser: 'chromium',
      key: `${base}\\Chromium\\NativeMessagingHosts\\${hostName}`,
    },
    {
      browser: 'brave',
      key: `${base}\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${hostName}`,
    },
    {
      browser: 'edge',
      key: `${base}\\Microsoft\\Edge\\NativeMessagingHosts\\${hostName}`,
    },
  ];
}
