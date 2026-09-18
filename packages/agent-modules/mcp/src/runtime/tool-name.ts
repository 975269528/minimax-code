/** Keep the existing runtime limit; changing provider limits is not part of this hotfix. */
export const MCP_RUNTIME_TOOL_NAME_MAX_LENGTH = 80;
/** Preserve the previous Server budget, leaving at least 25 characters for a Tool. */
export const MCP_RUNTIME_SERVER_SEGMENT_MAX_LENGTH = 48;

/** Public projection only. Routing must retain the original server/tool identity. */
export function normalizeMcpNameSegment(value: string, kind: 'server' | 'tool'): string {
  if (!value || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) {
    throw new Error(`Invalid MCP ${kind} name`);
  }
  const segment = value
    .replace(/[^a-zA-Z0-9_-]+/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  return /[a-zA-Z0-9]/u.test(segment) ? segment : kind;
}

/** Builds a candidate; hosts resolve collisions over their complete inventories. */
export function buildMcpToolRuntimeName(serverName: string, toolName: string): string {
  const server = buildMcpServerRuntimeName(serverName);
  const tool = shortenMcpNameSegment(
    normalizeMcpNameSegment(toolName, 'tool'),
    MCP_RUNTIME_TOOL_NAME_MAX_LENGTH - server.length - 2,
    'tool',
  );
  return `${server}__${tool}`;
}

export function buildMcpServerRuntimeName(serverName: string): string {
  const segment = shortenMcpNameSegment(
    normalizeMcpNameSegment(serverName, 'server'),
    MCP_RUNTIME_SERVER_SEGMENT_MAX_LENGTH,
    'server',
  );
  return `mcp__${segment}`;
}

/** Shorten a normalized projection only; the registry retains the full raw identity. */
export function shortenMcpNameSegment(
  segment: string,
  max: number,
  kind: 'server' | 'tool',
): string {
  if (max < 1) throw new Error(`MCP ${kind} name has no room for a readable prefix`);
  const prefix = segment.slice(0, max).replace(/_+$/u, '');
  return /[a-zA-Z0-9]/u.test(prefix) ? prefix : kind.slice(0, max);
}
