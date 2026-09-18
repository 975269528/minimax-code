import type { MetricsClient } from '@mavis/shared/local-runtime-logging/metrics';
import type { ObservabilityLogger } from '@mavis/shared/local-runtime-diagnostics';
import { createMcpRuntimeLogger } from './logging.js';
import { McpConnectionPool } from '@mavis/mcp/runtime/connection-pool';
import type { McpRuntimeLogger } from '@mavis/mcp/runtime/types';
import type {
  McpRuntimeCapability,
  McpSettingsService,
  McpServerConfig,
  ConfiguredMcpServerInput,
} from './contracts.js';
import { LocalMcpService } from './runtime/local-mcp.service.js';
import { resolveMatrixMcpStdioEntrypoint } from './runtime/builtin-matrix.js';
import { LocalMcpPublicFacade } from './tools/public-facade.js';

export interface InitializedMcpService {
  readonly service: McpSettingsService;
  readonly runtime: LocalMcpService;
  readonly public: LocalMcpPublicFacade;
  readonly capability: McpRuntimeCapability;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export interface InitializeMcpServiceOptions {
  readonly dataDir: string;
  readonly nowMs?: () => number;
  readonly enableLiveMcp: boolean;
  readonly builtinMatrix: boolean;
  readonly matrixWebSearchOnly: boolean;
  readonly logger?: McpRuntimeLogger;
  readonly diagnostics?: ObservabilityLogger;
  readonly metrics?: Pick<MetricsClient, 'counter' | 'histogram'>;
  readonly fetchImpl?: typeof fetch;
  /** Internal old-consumer binding; not a public host factory override. */
  readonly bindRuntime?: (capability: McpRuntimeCapability) => () => void;
}

export function initializeMcpService(options: InitializeMcpServiceOptions): InitializedMcpService {
  let runtime: LocalMcpService;
  const metrics = options.metrics;
  const logger = createMcpRuntimeLogger(options.diagnostics, options.logger);
  const pool = options.enableLiveMcp
    ? new McpConnectionPool(
        {
          getResolvedServer: (name) => runtime.getServerLookup().getResolvedServer(name),
        },
        {
          ...(logger ? { logger } : {}),
          ...(metrics
            ? {
                metrics: {
                  incr: (name, tags) => metrics.counter(name, 1, tags),
                  latency: (name, value, tags) => metrics.histogram(name, value, tags),
                },
              }
            : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        },
      )
    : undefined;
  runtime = new LocalMcpService(() => options.dataDir, {
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    ...(pool ? { connectionPool: pool } : {}),
    builtinMatrix: {
      enabled: options.builtinMatrix && Boolean(resolveMatrixMcpStdioEntrypoint()),
      webSearchOnly: options.matrixWebSearchOnly,
    },
  });
  const service: McpSettingsService = {
    list: (keyword) => runtime.listConfiguredServers(keyword),
    get: (name) => runtime.getConfiguredServer(name),
    create: (name, config, enabled) =>
      runtime.createConfiguredServer(name, mutableConfig(config), enabled),
    update: (name, config) => runtime.updateConfiguredServer(name, mutableConfig(config)),
    delete: (name) => runtime.deleteConfiguredServer(name),
    setEnabled: (name, enabled) => runtime.setConfiguredServerEnabled(name, enabled),
    test: (name) => runtime.testConfiguredServer(name),
  };
  const capability: McpRuntimeCapability = runtime;
  const unbind = options.bindRuntime?.(capability);
  let closePromise: Promise<void> | undefined;
  return {
    service,
    runtime,
    public: new LocalMcpPublicFacade(runtime),
    capability,
    // Reservations are built from the local configuration. Remote discovery remains lazy and bounded.
    ready: async () => {
      await runtime.listServers();
    },
    close: () => {
      closePromise ??= (async () => {
        unbind?.();
        await runtime.close();
      })();
      return closePromise;
    },
  };
}

function mutableConfig(config: McpServerConfig): ConfiguredMcpServerInput {
  const common = {
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.description === undefined ? {} : { description: config.description }),
  };
  return config.transport === 'stdio'
    ? {
        transport: config.transport,
        command: config.command,
        ...(config.args === undefined ? {} : { args: [...config.args] }),
        ...(config.env === undefined ? {} : { env: { ...config.env } }),
        ...common,
      }
    : {
        transport: config.transport,
        url: config.url,
        ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
        ...common,
      };
}
