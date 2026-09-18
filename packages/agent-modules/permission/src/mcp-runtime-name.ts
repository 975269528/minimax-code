const MCP_SEGMENT_SEPARATOR = '__';

/**
 * Match one canonical `mcp__<server>__<tool>` name to a server-level
 * `mcp__<server>` permission rule.
 *
 * Extra separators make the legacy name ambiguous, so matching fails closed
 * instead of treating a shorter prefix as the owning server.
 */
export function matchesMcpServerRuntimeName(
  toolRuntimeName: string,
  serverRuntimeName: string,
): boolean {
  const toolParts = toolRuntimeName.split(MCP_SEGMENT_SEPARATOR);
  const serverParts = serverRuntimeName.split(MCP_SEGMENT_SEPARATOR);
  return (
    toolParts.length === 3 &&
    serverParts.length === 2 &&
    toolParts[0] === 'mcp' &&
    serverParts[0] === 'mcp' &&
    Boolean(toolParts[1]) &&
    Boolean(toolParts[2]) &&
    toolParts[1] === serverParts[1]
  );
}
