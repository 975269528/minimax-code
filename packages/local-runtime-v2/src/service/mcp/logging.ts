import type { McpRuntimeLogger } from '@mavis/mcp/runtime/types';
import type { ObservabilityLogger } from '@mavis/shared/local-runtime-diagnostics';

export function createMcpRuntimeLogger(
  diagnostics?: ObservabilityLogger,
  custom?: McpRuntimeLogger,
): McpRuntimeLogger | undefined {
  const sink = diagnostics?.child({ component: 'local-runtime.mcp' });
  if (!sink) return custom;
  return {
    info: (message, fields) => {
      custom?.info(message, fields);
      sink.info(message, fields);
    },
    warn: (message, fields) => {
      custom?.warn(message, fields);
      sink.warn(message, fields);
    },
    error: (message, fields) => {
      custom?.error(message, fields);
      sink.error(message, fields);
    },
  };
}
