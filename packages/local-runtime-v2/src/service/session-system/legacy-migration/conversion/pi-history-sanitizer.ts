/**
 * OpenCode conversion wrapper around the Session-owned legacy history normalizer.
 *
 * The caller must pass only rows produced by the current OpenCode migration round. Active or
 * mixed pi-agent history must never be sanitized.
 */
import {
  normalizeLegacyHistoryForMessages,
  type LegacyHistoryNormalizationOptions,
  type LegacyHistoryNormalizationStats,
} from '../../messages/history/legacy-history-normalizer.js';
import type { LegacyPiHistoryMessage } from './native-conversion-types.js';

export type SanitizeStats = LegacyHistoryNormalizationStats;
export type SanitizeOptions = LegacyHistoryNormalizationOptions;

export interface SanitizeResult {
  readonly messages: LegacyPiHistoryMessage[];
  readonly warnings: string[];
  readonly stats: SanitizeStats;
}

export function sanitizePiHistoryForMessages(
  messages: LegacyPiHistoryMessage[],
  options: SanitizeOptions = {},
): SanitizeResult {
  const result = normalizeLegacyHistoryForMessages(
    messages,
    {
      message: (value) => value,
      replaceAssistantContent: (value, content) => ({ ...value, content }),
    },
    options,
  );
  return {
    messages: [...result.items],
    warnings: [...result.warnings],
    stats: result.stats,
  };
}
