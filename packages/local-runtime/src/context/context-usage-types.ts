export const CONTEXT_USAGE_COMPONENT_KINDS = [
  'SYSTEM_PROMPT',
  'MEMORY',
  'TOOLS',
  'SKILLS',
  'MESSAGES',
  'OTHER',
] as const;

export type ContextUsageComponentKind = (typeof CONTEXT_USAGE_COMPONENT_KINDS)[number];
export type ContextUsageTotalCountSource = 'LOCAL_ESTIMATE' | 'PROVIDER_USAGE_ANCHORED';

export interface ContextUsageComponent {
  kind: ContextUsageComponentKind;
  tokens: number;
}

export interface ContextUsageSnapshot {
  contextWindowTokens: number;
  usedTokens: number;
  totalCountSource: ContextUsageTotalCountSource;
  components: ContextUsageComponent[];
}

export interface PromptRange {
  kind: 'MEMORY' | 'SKILLS' | 'OTHER';
  startOffset: number;
  endOffset: number;
}

export interface PreparedContextEstimate {
  valid: boolean;
  usedTokens: number;
  components: ContextUsageComponent[];
}

export interface ContextUsageProviderUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  contextWindow?: number;
}

export interface ContextUsageProviderMessageUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  contextWindowTokens?: number;
}

export type ContextUsageProviderDiagnosticStatus =
  | 'REMOTE'
  | 'FALLBACK_ESTIMATE'
  | 'INVALID_CONTEXT'
  | 'FAILED';

export interface ContextUsageProviderDiagnosticComponent {
  kind: ContextUsageComponentKind;
  providerTokens: number;
  rawPreparedTokens: number;
  estimatorMinusProviderTokens: number;
  source: 'remote' | 'estimate';
  fallbackReason?: string;
  retryRecovered?: string;
}

export interface ContextUsageProviderDiagnostics {
  status: ContextUsageProviderDiagnosticStatus;
  method: 'ORDERED_INCREMENTAL';
  fullCountBasis: 'EXACT_PROVIDER_PAYLOAD' | 'RECONSTRUCTED_CONTEXT';
  order: ContextUsageComponentKind[];
  providerFullTokens: number | null;
  providerFullVsInputAnchorTokens: number | null;
  reconstructedFullTokens: number | null;
  reconstructedFullVsExactTokens: number | null;
  rawPreparedMinusProviderTokens: number | null;
  closureTokens: number | null;
  components: ContextUsageProviderDiagnosticComponent[];
  error?: string;
}

export type ContextUsageReconciliation =
  | 'LOCAL_ONLY'
  | 'NORMALIZED_TO_PROVIDER'
  | 'INVALID_BREAKDOWN';

export interface ContextUsageToolCalibrationDebug {
  fingerprint: string;
  status: 'PENDING' | 'REMOTE' | 'EMPTY' | 'UNAVAILABLE';
  localTokens: number;
  calibratedTokens?: number;
}

export interface ContextUsageDebugMeasurement {
  rawPreparedTokens: number;
  rawPreparedComponents: ContextUsageComponent[];
  retainedTailTokens: number;
  rawFinalTokens: number;
  rawFinalComponents: ContextUsageComponent[];
  providerMessageUsage: ContextUsageProviderMessageUsage;
  providerInputAnchor?: number;
  /** Non-production, asynchronous six-stage Provider accounting only. */
  providerDiagnostics?: ContextUsageProviderDiagnostics;
  toolCalibration?: ContextUsageToolCalibrationDebug;
  divergence: {
    signedTokens: number | null;
    signedRate: number | null;
    absoluteRate: number | null;
  };
  reconciliation: ContextUsageReconciliation;
  finalSnapshot: ContextUsageSnapshot;
}

export interface ContextUsageMeasurement {
  snapshot: ContextUsageSnapshot;
  debug: ContextUsageDebugMeasurement;
}
