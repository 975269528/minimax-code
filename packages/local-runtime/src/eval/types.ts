import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { EvalMetaInfo } from '@mavis/shared/eval-meta-info';

export interface LocalEvalReporterContext {
  readonly sessionId: string;
  readonly workspaceDir: string;
}

export interface LocalEvalTurnStart {
  readonly turnId: string;
  readonly userMessage: string;
  readonly model?: unknown;
  readonly apiKey?: string;
}

export interface LocalEvalSnapshotInput {
  readonly turnId: string;
  readonly phase: string;
  readonly messages: readonly AgentMessage[];
  readonly systemPrompt?: string;
  readonly promptMetadata?: Readonly<Record<string, unknown>>;
  readonly model?: unknown;
  readonly thinkingLevel?: string;
  readonly tools?: readonly LocalEvalSnapshotTool[];
}

export interface LocalEvalSnapshotTool {
  readonly name: string;
  readonly description?: string;
  readonly schema?: unknown;
}

export interface LocalEvalToolCallInput {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly args: unknown;
}

export interface LocalEvalToolResultInput {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly result: unknown;
  readonly isError: boolean;
  readonly durationMs?: number;
}

export interface LocalEvalAssistantMessageInput {
  readonly content: string;
  readonly model?: unknown;
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

export interface LocalEvalUsageInput {
  readonly usage: unknown;
  readonly model?: unknown;
}

/** Versioned, non-message runtime observation projected into an eval Lifecycle step. */
export interface LocalEvalRuntimeEventInput {
  readonly eventType: string;
  readonly payload: unknown;
  /** Defaults to immediate to preserve existing Goal observations. */
  readonly delivery?: 'batched' | 'immediate';
  readonly isError?: boolean;
  /** Explicit origin permits reporting after the Turn/reporter has been released. */
  readonly origin?: { readonly turnId: string; readonly toolCallId?: string };
}

export type LocalEvalRuntimeEventDelivery =
  | 'queued'
  | 'buffered'
  | 'skipped_disabled'
  | 'skipped_no_token';

export interface LocalEvalTurnFinish {
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly error?: string;
}

export interface LocalEvalReporterLike {
  beginTurn(input: LocalEvalTurnStart): void;
  reportSnapshot(input: LocalEvalSnapshotInput): void;
  reportLifecycle(event: string, details?: Readonly<Record<string, unknown>>): void;
  reportToolCall(input: LocalEvalToolCallInput): void;
  reportToolResult(input: LocalEvalToolResultInput): void;
  reportAssistantMessage(input: LocalEvalAssistantMessageInput): void;
  reportUsage(input: LocalEvalUsageInput): void;
  reportRuntimeEvent?(input: LocalEvalRuntimeEventInput): void;
  finishTurn(input: LocalEvalTurnFinish): void;
}

export interface LocalEvalReporterFactoryOptions {
  readonly enabled: boolean;
  readonly endpoint: string;
  /** Defaults to the sibling `/eval/snapshot/report` gateway route. */
  readonly snapshotEndpoint?: string;
  readonly getAccessToken: () => string | undefined;
  readonly getMetaInfo?: (workspaceDir: string) => Promise<EvalMetaInfo>;
  readonly maxStepFieldBytes?: number;
  readonly maxSnapshotBytes?: number;
  readonly fetchImpl?: typeof fetch;
  readonly nowMs?: () => number;
  readonly requestTimeoutMs?: number;
}

export interface LocalEvalReporterFactoryLike {
  getReporter(context: LocalEvalReporterContext): LocalEvalReporterLike;
  releaseReporter(sessionId: string): void;
  canReport(): boolean;
  reportRuntimeEvent?(
    sessionId: string,
    input: LocalEvalRuntimeEventInput,
  ): LocalEvalRuntimeEventDelivery;
  flush(timeoutMs?: number): Promise<void>;
}

export type LocalEvalStepType =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'session_lifecycle'
  | 'usage'
  | 'runtime_event';

export interface EvalStep {
  stepType: LocalEvalStepType;
  role: string;
  content: string;
  stepIndex: number;
  toolName?: string;
  toolCallId?: string;
  argsJson?: string;
  resultJson?: string;
  isError?: boolean;
  durationMs?: number;
  usageJson?: string;
  rawJson?: string;
  clientProducedTs: number;
}

export interface EvalReportRequest {
  readonly kind: 'steps' | 'snapshot';
  readonly body: string;
}

export interface ReportEvalStepsResponse {
  readonly error?: unknown;
  readonly base_resp?: {
    readonly status_code?: unknown;
    readonly status_msg?: unknown;
  };
}

export interface ReporterStepInput {
  stepType: LocalEvalStepType;
  role: string;
  content: string;
  toolName?: string;
  toolCallId?: string;
  argsJson?: string;
  resultJson?: string;
  isError?: boolean;
  durationMs?: number;
  usageJson?: string;
  rawJson?: string;
}
