import { createHash } from 'node:crypto';
import type { PiTurnHooks, PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';
import {
  MsgType,
  RespDataType,
  Role,
  ToolCallStatus,
  type RespData,
  type ToolCall,
} from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventType, type RuntimeEvent } from '@mavis/agent-core/protocol';

import type { LocalRuntimeTurnRunnerInput, LocalTurnEventWriter } from '../execution/contracts.js';

type LlmCallPreparedInput = Parameters<
  NonNullable<PiTurnHooks['onLlmCallPreparedHook']>[number]
>[0];

export interface LocalEvalReporterPort {
  beginTurn(input: {
    readonly turnId: string;
    readonly userMessage: string;
    readonly model?: unknown;
    readonly apiKey?: string;
  }): void;
  reportSnapshot(input: {
    readonly turnId: string;
    readonly phase: string;
    readonly messages: LlmCallPreparedInput['messages'];
    readonly systemPrompt?: string;
    readonly promptMetadata?: Readonly<Record<string, unknown>>;
    readonly model?: unknown;
    readonly thinkingLevel?: string;
    readonly tools?: readonly {
      readonly name: string;
      readonly description?: string;
      readonly schema?: unknown;
    }[];
  }): void;
  reportToolCall(input: {
    readonly toolName: string;
    readonly toolCallId: string;
    readonly args: unknown;
  }): void;
  reportToolResult(input: {
    readonly toolName: string;
    readonly toolCallId: string;
    readonly result: unknown;
    readonly isError: boolean;
    readonly durationMs?: number;
  }): void;
  reportAssistantMessage(input: {
    readonly content: string;
    readonly model?: unknown;
    readonly stopReason?: string;
  }): void;
  reportUsage(input: { readonly usage: unknown; readonly model?: unknown }): void;
  finishTurn(input: {
    readonly status: 'completed' | 'failed' | 'aborted';
    readonly error?: string;
  }): void;
}

/** Narrow product port; the V1 compatibility layer supplies the concrete reporter. */
export interface LocalEvalReporterFactoryPort {
  reportRuntimeEvent?(
    sessionId: string,
    event: { readonly eventType: string; readonly payload: unknown },
  ): void;
  canReport(): boolean;
  getReporter(context: {
    readonly sessionId: string;
    readonly workspaceDir: string;
  }): LocalEvalReporterPort;
}

interface EvalTurnResult {
  readonly retracted: boolean;
  readonly networkStopped: boolean;
  readonly outcome: { readonly status: string; readonly errorMessage?: string };
}

interface ReporterObservation {
  readonly reporter: LocalEvalReporterPort;
  readonly model: unknown;
  readonly promptMetadata?: Readonly<Record<string, unknown>>;
  readonly logger?: PiTurnRunnerLogger;
  readonly reportedToolCallIds: Set<string>;
  readonly reportedToolResultIds: Set<string>;
}

/** Keeps eval capture fail-open around the native V2 runner. */
export async function runWithLocalEvalReporter<T extends EvalTurnResult>(
  factory: LocalEvalReporterFactoryPort | undefined,
  input: LocalRuntimeTurnRunnerInput,
  execute: (reportedInput: LocalRuntimeTurnRunnerInput) => Promise<T>,
  logger?: PiTurnRunnerLogger,
): Promise<T> {
  const reporter = beginTurn(factory, input, logger);
  const reportedInput = reporter ? withReporter(input, reporter, logger) : input;
  try {
    const result = await execute(reportedInput);
    finishTurn(
      reporter,
      result.retracted || result.networkStopped
        ? { ...result.outcome, status: 'aborted' }
        : result.outcome,
      logger,
    );
    return result;
  } catch (error) {
    failTurn(reporter, error, Boolean(input.signal?.aborted), logger);
    throw error;
  }
}

function beginTurn(
  factory: LocalEvalReporterFactoryPort | undefined,
  input: LocalRuntimeTurnRunnerInput,
  logger?: PiTurnRunnerLogger,
): LocalEvalReporterPort | undefined {
  let reporter: LocalEvalReporterPort | undefined;
  try {
    reporter = factory?.canReport()
      ? factory.getReporter({ sessionId: input.sessionId, workspaceDir: input.workspaceDir })
      : undefined;
  } catch (error) {
    logFailure(logger, 'initialize', error);
  }
  capture(logger, 'begin_turn', () => {
    reporter?.beginTurn({
      turnId: input.turnId,
      userMessage: input.userMessage.text,
      model: input.llm.model,
      apiKey: input.llm.apiKey,
    });
  });
  return reporter;
}

function finishTurn(
  reporter: LocalEvalReporterPort | undefined,
  outcome: { readonly status: string; readonly errorMessage?: string },
  logger?: PiTurnRunnerLogger,
): void {
  capture(logger, 'finish_turn', () => {
    reporter?.finishTurn({
      status: normalizeOutcomeStatus(outcome.status),
      ...(outcome.errorMessage ? { error: outcome.errorMessage } : {}),
    });
  });
}

function failTurn(
  reporter: LocalEvalReporterPort | undefined,
  error: unknown,
  aborted: boolean,
  logger?: PiTurnRunnerLogger,
): void {
  capture(logger, 'finish_turn', () => {
    reporter?.finishTurn({
      status: aborted ? 'aborted' : 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function withReporter(
  input: LocalRuntimeTurnRunnerInput,
  reporter: LocalEvalReporterPort,
  logger?: PiTurnRunnerLogger,
): LocalRuntimeTurnRunnerInput {
  const observation: ReporterObservation = {
    reporter,
    model: input.llm.model,
    promptMetadata: input.promptMetadata,
    logger,
    reportedToolCallIds: new Set<string>(),
    reportedToolResultIds: new Set<string>(),
  };
  const eventWriter = observeApprovedMessages(input.eventWriter, observation);
  return {
    ...input,
    eventWriter,
    ...(input.toolContext ? { toolContext: { ...input.toolContext, eventWriter } } : {}),
    hooks: withReporterHooks(input.hooks, observation),
  };
}

function withReporterHooks(
  hooks: PiTurnHooks | undefined,
  observation: ReporterObservation,
): PiTurnHooks {
  const toolStartedAtMs = new Map<string, number>();
  return {
    ...hooks,
    onLlmCallPreparedHook: [
      ...(hooks?.onLlmCallPreparedHook ?? []),
      (input) => {
        capture(observation.logger, 'snapshot', () => {
          observation.reporter.reportSnapshot({
            turnId: input.turnId,
            phase: input.phase,
            messages: input.messages,
            systemPrompt: input.systemPrompt,
            ...(observation.promptMetadata
              ? {
                  promptMetadata: {
                    ...observation.promptMetadata,
                    system_sha256: createHash('sha256')
                      .update(input.systemPrompt ?? '')
                      .digest('hex'),
                  },
                }
              : {}),
            model: input.model,
            thinkingLevel: input.thinkingLevel,
            tools: input.tools?.map((tool) => ({
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              schema: tool.parameters,
            })),
          });
        });
        return undefined;
      },
    ],
    afterLlmCallHook: [
      (input) => {
        if (input.message.usage !== undefined) {
          capture(observation.logger, 'usage', () => {
            observation.reporter.reportUsage({
              usage: input.message.usage,
              model: observation.model,
            });
          });
        }
        return undefined;
      },
      ...(hooks?.afterLlmCallHook ?? []),
    ],
    beforeToolCallHook: [
      ...(hooks?.beforeToolCallHook ?? []),
      (toolContext) => {
        toolStartedAtMs.set(toolContext.toolCall.id, Date.now());
        observation.reportedToolCallIds.add(toolContext.toolCall.id);
        capture(observation.logger, 'tool_call', () => {
          observation.reporter.reportToolCall({
            toolName: toolContext.toolCall.name,
            toolCallId: toolContext.toolCall.id,
            args: toolContext.args,
          });
        });
        return undefined;
      },
    ],
    afterToolCallHook: [
      ...(hooks?.afterToolCallHook ?? []),
      (toolContext) => {
        const startedAtMs = toolStartedAtMs.get(toolContext.toolCall.id);
        toolStartedAtMs.delete(toolContext.toolCall.id);
        observation.reportedToolResultIds.add(toolContext.toolCall.id);
        capture(observation.logger, 'tool_result', () => {
          observation.reporter.reportToolResult({
            toolName: toolContext.toolCall.name,
            toolCallId: toolContext.toolCall.id,
            result: toolContext.result,
            isError: toolContext.isError,
            ...(startedAtMs === undefined
              ? {}
              : { durationMs: Math.max(0, Date.now() - startedAtMs) }),
          });
        });
        return undefined;
      },
    ],
  };
}

function observeApprovedMessages(
  writer: LocalTurnEventWriter,
  observation: ReporterObservation,
): LocalTurnEventWriter {
  let observedEventCount = writer.events.length;
  const observe = (event: RuntimeEvent): void => {
    const response = parseRuntimeResponse(event);
    if (response?.type === RespDataType.AgentMessageChunk) {
      for (const toolCall of response.agent_message_chunk?.tool_calls ?? []) {
        observeTerminalToolCall(toolCall, observation);
      }
    }
    const message = parseAssistantMessage(response);
    if (!message) return;
    capture(observation.logger, 'assistant_message', () => {
      observation.reporter.reportAssistantMessage({
        content: message.msg_content ?? '',
        model: observation.model,
        ...(message.finish_reason ? { stopReason: message.finish_reason } : {}),
      });
    });
  };
  const observeCommittedEvents = (): void => {
    while (observedEventCount < writer.events.length) {
      const event = writer.events[observedEventCount];
      observedEventCount += 1;
      if (event) capture(observation.logger, 'observe_event', () => observe(event));
    }
  };
  const writeAndObserve = async (write: () => void | Promise<void>): Promise<void> => {
    try {
      await write();
    } finally {
      observeCommittedEvents();
    }
  };
  return {
    events: writer.events,
    pushRuntime: (event) => writeAndObserve(() => writer.pushRuntime(event)),
    appendEvents: (events) => writeAndObserve(() => writer.appendEvents(events)),
  };
}

function observeTerminalToolCall(toolCall: ToolCall, observation: ReporterObservation): void {
  if (!isTerminalToolCall(toolCall)) return;
  const callAlreadyReported = observation.reportedToolCallIds.has(toolCall.tool_call_id);
  if (!callAlreadyReported) {
    observation.reportedToolCallIds.add(toolCall.tool_call_id);
    capture(observation.logger, 'tool_call', () => {
      observation.reporter.reportToolCall({
        toolName: toolCall.tool_name,
        toolCallId: toolCall.tool_call_id,
        args: parseSerializedValue(toolCall.tool_call_args),
      });
    });
  }
  if (observation.reportedToolResultIds.has(toolCall.tool_call_id)) return;
  observation.reportedToolResultIds.add(toolCall.tool_call_id);
  const result = parseSerializedValue(toolCall.tool_call_result_data);
  capture(observation.logger, 'tool_result', () => {
    observation.reporter.reportToolResult({
      toolName: toolCall.tool_name,
      toolCallId: toolCall.tool_call_id,
      result:
        !callAlreadyReported && toolCall.tool_call_status === ToolCallStatus.Failed
          ? withPreExecutionPhase(result)
          : result,
      isError: toolCall.tool_call_status === ToolCallStatus.Failed,
    });
  });
}

function isTerminalToolCall(toolCall: ToolCall): boolean {
  return (
    (toolCall.tool_call_status === ToolCallStatus.Finished ||
      toolCall.tool_call_status === ToolCallStatus.Failed) &&
    toolCall.tool_name.length > 0 &&
    toolCall.tool_call_id.length > 0
  );
}

function parseRuntimeResponse(event: RuntimeEvent): RespData | undefined {
  if (event.type !== RuntimeEventType.STREAM_RESP) return undefined;
  const raw = event.payload?.stream_resp;
  return typeof raw === 'string' && raw.length > 0 ? parseResponse(raw) : undefined;
}

function parseSerializedValue(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function withPreExecutionPhase(result: unknown): unknown {
  if (!isRecord(result)) return result;
  return {
    ...result,
    details: {
      ...(isRecord(result.details) ? result.details : {}),
      phase: 'pre_execution',
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAssistantMessage(
  response: RespData | undefined,
): RespData['agent_message'] | undefined {
  const message = response?.agent_message;
  return response?.type === RespDataType.AgentMessage &&
    message?.role === Role.Assistant &&
    message.kind === undefined &&
    message.msg_type !== MsgType.SystemEvent
    ? message
    : undefined;
}

function parseResponse(raw: string): RespData | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as RespData) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOutcomeStatus(status: string): 'completed' | 'failed' | 'aborted' {
  if (status === 'completed') return 'completed';
  if (status === 'aborted') return 'aborted';
  return 'failed';
}

function capture(
  logger: PiTurnRunnerLogger | undefined,
  operation: string,
  action: () => void,
): void {
  try {
    action();
  } catch (error) {
    logFailure(logger, operation, error);
  }
}

function logFailure(
  logger: PiTurnRunnerLogger | undefined,
  operation: string,
  error: unknown,
): void {
  try {
    logger?.warn?.(
      { operation, error_name: error instanceof Error ? error.name : typeof error },
      '[eval-capture] local eval reporting failed open',
    );
  } catch {
    // Eval reporting and diagnostics are both best effort.
  }
}
