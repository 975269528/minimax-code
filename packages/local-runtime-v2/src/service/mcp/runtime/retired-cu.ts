import type { LocalMcpServerConfig } from '../contracts.js';

const RETIRED_BUILTIN_CU_SERVER_NAME = 'cu';

export function isRetiredLegacyCuMcpServerConfig(
  server: string,
  config: LocalMcpServerConfig,
): boolean {
  if (server !== RETIRED_BUILTIN_CU_SERVER_NAME || config.builtin !== true) return false;

  if (
    config.metadata?.['mavisBuiltinMcpServer'] === RETIRED_BUILTIN_CU_SERVER_NAME &&
    config.metadata?.['managedBy'] === 'local-runtime'
  ) {
    return true;
  }

  return isRetiredLoopbackCuEndpoint(config.url);
}

function isRetiredLoopbackCuEndpoint(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return (
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1') &&
      (url.pathname === '/mavis/mcp/cu' || url.pathname === '/mcp/cu')
    );
  } catch {
    return false;
  }
}
