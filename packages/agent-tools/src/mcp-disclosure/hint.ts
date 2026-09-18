export function renderMcpToolSearchHintBlock(): string {
  return [
    '<system-reminder>',
    'Additional integration tools (from configured MCP servers) are available but NOT listed here.',
    'When a task needs an external capability your built-in tools do not cover, call `tool_search` with a',
    'keyword `query` and/or `regex` to discover relevant tools, then call `mcp_invoke` with the chosen',
    '`tool_name` and `arguments`. Prefer built-in tools when they suffice.',
    '</system-reminder>',
  ].join('\n');
}
