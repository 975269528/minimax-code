import type { ContextManagerSettings } from './types.js';

export const DEFAULT_CONTEXT_MANAGER_SETTINGS = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  minMessagesToCompact: 4,
  contextWindowFallback: 128_000,
  safetyMarginTokens: 2_048,
  strategyVersion: 'agent-modules-context-manager-v1',
} satisfies ContextManagerSettings;

/**
 * Shared compaction trigger threshold. MiniMax-M3's 512K and 1M context modes
 * use the product-defined 90% line. Other models reserve the greater of the
 * configured reserve and one turn's output budget plus the safety margin.
 */
export function computeCompactionTriggerAt(input: {
  modelId?: string;
  contextWindow: number;
  perTurnMaxTokens: number;
  reserveTokens: number;
  safetyMarginTokens: number;
}): number {
  if (
    input.modelId === 'MiniMax-M3' &&
    (input.contextWindow === 512_000 || input.contextWindow === 1_000_000)
  ) {
    return Math.floor(input.contextWindow * 0.9);
  }
  const perTurnMaxTokens =
    Number.isFinite(input.perTurnMaxTokens) && input.perTurnMaxTokens > 0
      ? input.perTurnMaxTokens
      : 0;
  const reserve = Math.max(input.reserveTokens, perTurnMaxTokens + input.safetyMarginTokens);
  return Math.max(1, input.contextWindow - reserve);
}
