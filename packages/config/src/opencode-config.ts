import type {
  OpenCodeAdapterConfig,
  OpenCodeKeepAliveConfig,
  OpenCodeStartupImportMode,
  OpenCodeXdgConfig,
} from './config.js';

export interface OpenCodeAdapterDefaults {
  keepAlive: OpenCodeKeepAliveConfig;
  xdg: OpenCodeXdgConfig;
  spawnConcurrency: number;
}

/**
 * Parse the legacy `opencode` adapter section of `config.yaml`.
 *
 * New local sessions no longer use this path; the types stay exported because
 * the daemon package is still in the workspace compile surface while existing
 * opencode sessions are kept resumable through the legacy boundary.
 */
export function parseOpenCodeAdapterConfig(
  raw: Record<string, unknown>,
  defaults: OpenCodeAdapterDefaults,
): OpenCodeAdapterConfig {
  const defaultKeepAlive = defaults.keepAlive;
  const defaultXdg = defaults.xdg;
  const defaultSpawnConcurrency = defaults.spawnConcurrency;
  const cloneDefault = (): OpenCodeKeepAliveConfig => ({
    enabled: defaultKeepAlive.enabled,
    maxProcesses: defaultKeepAlive.maxProcesses,
    maxLifetimeMs: defaultKeepAlive.maxLifetimeMs,
    agents: [...defaultKeepAlive.agents],
  });

  const rawOc = raw.opencode;
  if (rawOc == null || typeof rawOc !== 'object' || Array.isArray(rawOc)) {
    return {
      keepAlive: cloneDefault(),
      xdg: { ...defaultXdg },
      spawnConcurrency: defaultSpawnConcurrency,
    };
  }
  const ocObj = rawOc as Record<string, unknown>;

  const rawSc = ocObj.spawnConcurrency;
  const spawnConcurrency =
    typeof rawSc === 'number' && Number.isFinite(rawSc) && rawSc > 0 && Number.isInteger(rawSc)
      ? rawSc
      : defaultSpawnConcurrency;

  const xdg = parseXdgConfig(ocObj.xdg, defaultXdg);

  const rawKa = ocObj.keepAlive;
  if (rawKa == null || typeof rawKa !== 'object' || Array.isArray(rawKa)) {
    return { keepAlive: cloneDefault(), xdg, spawnConcurrency };
  }
  const ka = rawKa as Record<string, unknown>;

  const rawMaxP = ka.maxProcesses;
  const maxProcesses =
    typeof rawMaxP === 'number' &&
    Number.isFinite(rawMaxP) &&
    rawMaxP > 0 &&
    Number.isInteger(rawMaxP)
      ? rawMaxP
      : defaultKeepAlive.maxProcesses;

  const rawMaxL = ka.maxLifetimeMs;
  const maxLifetimeMs =
    typeof rawMaxL === 'number' &&
    Number.isFinite(rawMaxL) &&
    rawMaxL > 0 &&
    Number.isInteger(rawMaxL)
      ? rawMaxL
      : defaultKeepAlive.maxLifetimeMs;

  const rawAgents = ka.agents;
  let agents: string[];
  if (Array.isArray(rawAgents)) {
    agents = rawAgents.filter(
      (agent): agent is string => typeof agent === 'string' && agent.length > 0,
    );
    if (agents.length === 0) agents = [...defaultKeepAlive.agents];
  } else {
    agents = [...defaultKeepAlive.agents];
  }

  return {
    keepAlive: {
      enabled: typeof ka.enabled === 'boolean' ? ka.enabled : defaultKeepAlive.enabled,
      maxProcesses,
      maxLifetimeMs,
      agents,
    },
    xdg,
    spawnConcurrency,
  };
}

function parseXdgConfig(raw: unknown, defaults: OpenCodeXdgConfig): OpenCodeXdgConfig {
  const xdgObj =
    raw != null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  const rawStartupImport = xdgObj?.startupImport;
  const startupImport: OpenCodeStartupImportMode =
    rawStartupImport === 'background' ||
    rawStartupImport === 'blocking' ||
    rawStartupImport === 'off'
      ? rawStartupImport
      : defaults.startupImport;
  return {
    dataIsolation:
      typeof xdgObj?.dataIsolation === 'boolean' ? xdgObj.dataIsolation : defaults.dataIsolation,
    startupImport,
  };
}
