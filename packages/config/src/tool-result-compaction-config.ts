export interface ToolResultCompactionSettings {
  /** Enables cumulative ToolResult archive/trim during automatic compaction. */
  readonly enabled: boolean;
  /** Per-result safety fuse applied before the result enters History. */
  readonly maxInlineKiB: number;
  /** Raw MCP detail safety fuse applied after Plugin hooks and before History. */
  readonly mcpDetailsMaxInlineKiB: number;
  /** Cumulative ToolResult text watermark for direct compaction. */
  readonly watermarkKiB: number;
  /** Minimum actual savings required before committing direct compaction. */
  readonly minSavingsKiB: number;
  /** Minimum size for one ToolResult to become a direct-compaction candidate. */
  readonly minCandidateKiB: number;
  /** Number of recent complete tool rounds protected from cumulative compaction. */
  readonly keepRecentRounds: number;
}

export const TOOL_RESULT_COMPACTION_DEFAULTS: Readonly<ToolResultCompactionSettings> = {
  enabled: true,
  maxInlineKiB: 64,
  mcpDetailsMaxInlineKiB: 32,
  watermarkKiB: 256,
  minSavingsKiB: 256,
  minCandidateKiB: 2,
  keepRecentRounds: 5,
};

const MAX_SAFE_KIB = Math.floor(Number.MAX_SAFE_INTEGER / 1_024);

/** Resolves the user-facing config.yaml block without allowing unsafe byte conversion. */
export function parseToolResultCompactionConfig(raw: unknown): ToolResultCompactionSettings {
  const value = isRecord(raw) ? raw : {};
  return {
    enabled:
      typeof value.enabled === 'boolean' ? value.enabled : TOOL_RESULT_COMPACTION_DEFAULTS.enabled,
    maxInlineKiB: positiveSafeKiB(value.maxInlineKiB, TOOL_RESULT_COMPACTION_DEFAULTS.maxInlineKiB),
    mcpDetailsMaxInlineKiB: positiveSafeKiB(
      value.mcpDetailsMaxInlineKiB,
      TOOL_RESULT_COMPACTION_DEFAULTS.mcpDetailsMaxInlineKiB,
    ),
    watermarkKiB: positiveSafeKiB(value.watermarkKiB, TOOL_RESULT_COMPACTION_DEFAULTS.watermarkKiB),
    minSavingsKiB: positiveSafeKiB(
      value.minSavingsKiB,
      TOOL_RESULT_COMPACTION_DEFAULTS.minSavingsKiB,
    ),
    minCandidateKiB: positiveSafeKiB(
      value.minCandidateKiB,
      TOOL_RESULT_COMPACTION_DEFAULTS.minCandidateKiB,
    ),
    keepRecentRounds: positiveSafeInteger(
      value.keepRecentRounds,
      TOOL_RESULT_COMPACTION_DEFAULTS.keepRecentRounds,
    ),
  };
}

function positiveSafeKiB(value: unknown, fallback: number): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_SAFE_KIB
    ? value
    : fallback;
}

function positiveSafeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
