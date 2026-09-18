import type { TuiSessionUsageSummary } from '../runtime/port.js';

export interface TuiSessionCacheMetrics {
  readonly freshInputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly promptTokens: number;
  readonly cacheReadRatio: number;
}

/** Derives the Session-wide prompt-cache read ratio from Runtime-owned aggregates. */
export function resolveTuiSessionCacheMetrics(
  summary: TuiSessionUsageSummary | undefined,
): TuiSessionCacheMetrics | undefined {
  if (!summary) return undefined;
  const freshInputTokens = normalizeTokenCount(summary.inputTokens);
  const cacheReadTokens = normalizeTokenCount(summary.cacheReadTokens);
  const cacheWriteTokens = normalizeTokenCount(summary.cacheWriteTokens);
  const promptTokens = freshInputTokens + cacheReadTokens + cacheWriteTokens;
  if (promptTokens <= 0) return undefined;
  return {
    freshInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    promptTokens,
    cacheReadRatio: cacheReadTokens / promptTokens,
  };
}

function normalizeTokenCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
