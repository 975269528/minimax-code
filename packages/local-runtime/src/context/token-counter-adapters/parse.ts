export function parseTopLevelInputTokens(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const inputTokens = (payload as { input_tokens?: unknown }).input_tokens;
  return typeof inputTokens === 'number' ? inputTokens : undefined;
}

export function parseUsageTotalTokens(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const totalTokens = (usage as { total_tokens?: unknown }).total_tokens;
  return typeof totalTokens === 'number' ? totalTokens : undefined;
}

export function parseDataTotalTokens(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const totalTokens = (data as { total_tokens?: unknown }).total_tokens;
  return typeof totalTokens === 'number' ? totalTokens : undefined;
}
