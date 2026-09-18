export function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function escapeMarkdownLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

export function invokedToolName(args: unknown): string | undefined {
  const record = readRecord(args);
  return (
    readNonEmptyString(record?.tool) ??
    readNonEmptyString(record?.tool_name) ??
    readNonEmptyString(record?.toolName)
  );
}

export function normalizeToolName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, '_');
}

export function parseMcpToolName(value: string): { server: string; tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/u.exec(value.trim());
  const server = match?.[1]?.trim();
  const tool = match?.[2]?.trim();
  return server && tool ? { server, tool } : undefined;
}
