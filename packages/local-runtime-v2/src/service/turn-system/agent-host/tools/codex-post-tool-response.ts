import {
  pluginMcpResponse,
  type VendorPostToolResponseInput,
} from './vendor-post-tool-response.js';

/**
 * Codex exposes the model-facing FunctionCallOutput body unless the tool owns
 * a more stable response. Desktop can reproduce that contract exactly for a
 * single text block, and Plugin MCP owns the original CallToolResult.
 */
export function buildCodexPostToolResponse(
  input: VendorPostToolResponseInput,
): Readonly<Record<string, unknown>> | string | undefined {
  const mcpResponse = pluginMcpResponse(input);
  if (mcpResponse) return mcpResponse;
  const content = input.result.content;
  if (!content?.length) return undefined;
  const text: string[] = [];
  for (const part of content) {
    if (part.type !== 'text') return undefined;
    text.push(part.text);
  }
  return text.join('\n');
}
