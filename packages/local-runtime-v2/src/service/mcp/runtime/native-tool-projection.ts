import { configuredMcpNameKey, type McpNameRegistry } from '@mavis/mcp';
import type {
  LocalMcpNativeToolInfo,
  LocalMcpServerConfig,
  LocalMcpToolInfo,
} from '../contracts.js';
import { isBuiltinMatrixConfig, BUILTIN_MATRIX_WEB_SEARCH_TOOL_NAME } from './builtin-matrix.js';
import { buildNativeToolName, inferTransport } from './config.js';

export function reserveConfiguredServerNames(
  registry: McpNameRegistry,
  servers: Readonly<Record<string, LocalMcpServerConfig>>,
  onError: (server: string, error: string) => void,
): ReadonlySet<string> {
  const invalid = new Set<string>();
  const assigned = registry.assignServers(
    Object.entries(servers)
      .filter(([server, config]) => !isBuiltinMatrixConfig(server, config))
      .map(([name]) => ({ key: configuredMcpNameKey(name), name })),
  );
  for (const server of Object.keys(servers)) {
    const error = assigned.errors.get(configuredMcpNameKey(server));
    if (error) {
      onError(server, error);
      invalid.add(server);
    }
  }
  return invalid;
}

export function projectNativeTools(input: {
  server: string;
  config: LocalMcpServerConfig;
  rawTools: LocalMcpToolInfo[];
  registry: McpNameRegistry;
  matrixWebSearchOnly: boolean;
  onError: (error: string) => void;
}): LocalMcpNativeToolInfo[] {
  const { server, config, rawTools, registry } = input;
  const matrix = isBuiltinMatrixConfig(server, config);
  // Live Matrix advertises every tool even when mcode-tools owns media generation.
  const tools =
    matrix && input.matrixWebSearchOnly
      ? rawTools.filter((tool) => tool.name === BUILTIN_MATRIX_WEB_SEARCH_TOOL_NAME)
      : rawTools;
  const names = matrix
    ? undefined
    : registry.assignTools(
        configuredMcpNameKey(server),
        tools.map((tool) => tool.name),
      );
  for (const error of names?.errors.values() ?? []) input.onError(error);
  return tools.flatMap((tool) => {
    const nativeName = matrix
      ? buildNativeToolName(server, tool.name, config)
      : names?.names.get(tool.name);
    return nativeName
      ? [
          {
            ...tool,
            server,
            toolName: tool.name,
            nativeName,
            transport: inferTransport(config),
            builtin: config.builtin === true,
            configured: config.configured !== false,
            source: nativeSource(matrix, config),
          },
        ]
      : [];
  });
}

function nativeSource(
  matrix: boolean,
  config: LocalMcpServerConfig,
): LocalMcpNativeToolInfo['source'] {
  if (matrix) return 'builtin-matrix';
  return config.builtin === true ? 'builtin' : 'configured';
}
