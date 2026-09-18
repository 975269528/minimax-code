import type { LLMCallUsage } from '@mavis/agent-core/pi-turn-runner';

export type InspectorBuildVariant = 'dev' | 'test' | 'internal' | 'unavailable';

export type CapturedPayloadState = 'AVAILABLE' | 'OMITTED_TOO_LARGE' | 'CAPTURE_FAILED';

export interface CapturedPayload {
  readonly state: CapturedPayloadState;
  readonly json?: string;
  readonly byteLength?: number;
}

export interface ExpectedToolIdentity {
  readonly toolCallId: string;
  readonly toolName: string;
}

interface StoredToolSummary extends ExpectedToolIdentity {
  readonly startedAtMs?: number;
  readonly durationMs?: number;
  readonly isError?: boolean;
}

export interface SettledCallRecord {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly apiId: string;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly attemptCount: number;
  readonly request: CapturedPayload;
  readonly response: CapturedPayload;
  readonly usage?: LLMCallUsage;
  readonly expectedTools: readonly ExpectedToolIdentity[];
  readonly captureEpoch: number;
}

export interface StoredCallSummary {
  readonly callId: string;
  readonly callOrdinal: number;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly apiId: string;
  readonly attemptCount: number;
  readonly usage?: LLMCallUsage;
  readonly tools: readonly StoredToolSummary[];
  readonly hasCompactionBefore: boolean;
  readonly captureEpoch: number;
}

export interface StoredTurnSummary {
  readonly turnId: string;
  readonly turnOrdinal: number;
  readonly calls: readonly StoredCallSummary[];
}

export interface StoredOverview {
  readonly turns: readonly StoredTurnSummary[];
}

export interface StoredCallDetail {
  readonly callId: string;
  readonly request: CapturedPayload;
  readonly response: CapturedPayload;
  readonly providerId: string;
  readonly modelId: string;
  readonly apiId: string;
}

export interface InspectorSessionIdentity {
  readonly sessionId: string;
  readonly title?: string;
  readonly agentName?: string;
  readonly createdAtMs: number;
  readonly historyRelativeDir?: string;
}

export type InspectorSessionSource = 'electron' | 'tui';

export interface InspectorSessionSummary extends InspectorSessionIdentity {
  readonly updatedAtMs: number;
  readonly source: InspectorSessionSource;
}
