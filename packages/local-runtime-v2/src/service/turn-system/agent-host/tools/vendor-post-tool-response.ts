import type { ToolResult } from '@mavis/agent-core/tools';
import {
  compatibleBashToolResponseFromPiDetails,
  compatibleReadToolResponseFromPiDetails,
  readPluginHookCompatibleToolResponse,
} from '@mavis/agent-tools';
import type { PluginHookEventInput } from '@mavis/plugin-hooks';

export interface VendorPostToolResponseInput {
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: Pick<ToolResult, 'details'> &
    Partial<Pick<ToolResult, 'content' | 'text' | 'isError'>>;
  readonly cwd: string;
  readonly toolProvenance?: PluginHookEventInput['toolProvenance'];
}

/**
 * Rebuild the tool-owned structured value Compatible Code exposes as
 * `PostToolUse.tool_response`, but only where Desktop still owns every field.
 *
 * When the complete Compatible output is unavailable, return no response. The
 * shared runner then skips the incompatible Compatible handler with a bounded
 * `HOOK_INVALID_INPUT` diagnostic instead of inventing vendor fields.
 */
export function buildCompatiblePostToolResponse(
  input: VendorPostToolResponseInput,
): Readonly<Record<string, unknown>> | undefined {
  const exactResponse = readPluginHookCompatibleToolResponse(input.result);
  if (exactResponse) return exactResponse;
  if (input.toolName === 'bash') {
    const bashResponse = compatibleBashToolResponseFromPiDetails(input.result.details);
    if (bashResponse) return bashResponse;
  }
  if (input.toolName === 'read') {
    const readResponse = compatibleReadToolResponseFromPiDetails(input.result.details);
    if (readResponse) return readResponse;
  }
  const mcpResponse = pluginMcpResponse(input);
  if (mcpResponse) return mcpResponse;

  // Unknown tools remain unsupported rather than receiving an invented
  // vendor result.
  return undefined;
}

export function pluginMcpResponse(
  input: VendorPostToolResponseInput,
): Readonly<Record<string, unknown>> | undefined {
  if (input.toolProvenance?.kind !== 'plugin_mcp') return undefined;
  const details = recordValue(input.result.details);
  return details ? recordValue(details.mcp) : undefined;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
