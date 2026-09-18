import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import { WebSearchToolDef, type WebSearchInput } from '../shared/web-search.js';
import type { LocalRuntimeToolContext, LocalWebSearchAdapter } from './types.js';

const LEGACY_MATRIX_SERVER_NAME = 'matrix';

@bindTool(WebSearchToolDef)
export class LocalWebSearchTool implements ToolImpl<
  typeof WebSearchToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly adapter: LocalWebSearchAdapter) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: WebSearchInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    try {
      if (signal?.aborted) throw new Error('Operation aborted');
      return wrapLegacyMatrixMcpResult(await this.adapter.search(ctx, input, signal));
    } catch (error) {
      return wrapLegacyMatrixMcpError(error);
    }
  }
}

function wrapLegacyMatrixMcpResult(result: ToolResult): ToolResult {
  // Electron no longer starts the Matrix MCP process, but model-visible content and
  // Tool events must remain byte/shape compatible with the old MCP runtime adapter.
  const mcpResult = {
    content: result.content,
    isError: result.isError === true,
    _meta: {
      matrix: { server: LEGACY_MATRIX_SERVER_NAME, tool: WebSearchToolDef.name },
      ...(result.details ? { details: result.details } : {}),
      ...(result.output ? { output: result.output } : {}),
    },
  };
  return wrapLegacyMatrixMcpCallResult(result.text, mcpResult);
}

function wrapLegacyMatrixMcpError(error: unknown): ToolResult {
  const text = `Matrix MCP tool failed: ${error instanceof Error ? error.message : String(error)}`;
  return wrapLegacyMatrixMcpCallResult(text, {
    content: [{ type: 'text' as const, text }],
    isError: true,
    _meta: {
      matrix: { server: LEGACY_MATRIX_SERVER_NAME, tool: WebSearchToolDef.name },
    },
  });
}

function wrapLegacyMatrixMcpCallResult(
  text: string,
  mcpResult: {
    content: ToolResult['content'];
    isError: boolean;
    _meta: Record<string, unknown>;
  },
): ToolResult {
  return {
    tool_name: WebSearchToolDef.name,
    text,
    content: mcpResult.content,
    isError: mcpResult.isError,
    details: {
      mcp: mcpResult,
      server: LEGACY_MATRIX_SERVER_NAME,
      tool: WebSearchToolDef.name,
    },
    output: { mcp: mcpResult },
  };
}
