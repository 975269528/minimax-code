import type { RuntimeTool, ToolResult } from '@mavis/agent-core/tools';

export function applyProcessLocalToolResultPolicy(
  tools: readonly RuntimeTool[],
  enabled: boolean,
): readonly RuntimeTool[] {
  if (!enabled) return tools;
  return tools.map((tool) =>
    tool.source === 'builtin-matrix' ? wrapBuiltinMatrixTool(tool) : tool,
  );
}

function wrapBuiltinMatrixTool(tool: RuntimeTool): RuntimeTool {
  return {
    ...tool,
    impl: {
      execute: async (context, input, signal, onUpdate) =>
        markMatrixBusinessFailure(await tool.impl.execute(context, input, signal, onUpdate)),
    },
  };
}

function markMatrixBusinessFailure(result: ToolResult): ToolResult {
  return isMatrixBusinessFailure(result) ? { ...result, isError: true } : result;
}

function isMatrixBusinessFailure(result: ToolResult): boolean {
  if (readRecord(result.details)?.['ok'] === false) return true;
  const mcp = readRecord(readRecord(result.details)?.['mcp']);
  const meta = readRecord(mcp?.['_meta']);
  return readRecord(meta?.['details'])?.['ok'] === false;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
