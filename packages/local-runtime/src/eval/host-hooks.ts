import type { PiTurnHooks } from '@mavis/agent-core/pi-turn-runner';
import {
  RespDataType,
  MsgType,
  Role,
  type RespData,
} from '@mavis/agent-core/protocol/agent-message';

import { PI_TURN_RUNNER_LOGGER } from '../runtime/pi-turn-observability.js';
import type { LocalEventWriter } from '../events/sink.js';
import type { LocalEvalReporterFactoryLike, LocalEvalReporterLike } from './types.js';

interface LocalEvalTurnContext {
  readonly sessionId: string;
  readonly workspaceDir: string;
  readonly turnId: string;
  readonly userMessage: string;
  readonly model: unknown;
  readonly apiKey?: string;
}

interface LocalEvalTurnOutcome {
  readonly status: string;
  readonly errorMessage?: string;
}

function logLocalEvalCaptureFailure(operation: string, error: unknown): void {
  PI_TURN_RUNNER_LOGGER.warn?.(
    {
      operation,
      error_name: error instanceof Error ? error.name : typeof error,
    },
    '[eval-capture] local eval reporting failed open',
  );
}

function runLocalEvalCapture(operation: string, action: () => unknown): void {
  try {
    action();
  } catch (error) {
    logLocalEvalCaptureFailure(operation, error);
  }
}
function parseRespData(raw: string): RespData | undefined {
  try {
    const parsed = JSON.parse(raw) as RespData;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Observe the canonical sink downstream of LocalOutputSafetyEventWriter.
 * Pre-review Pi messages and synthetic display frames must not cross this boundary.
 */
export function observeApprovedLocalEvalAssistantMessages(
  eventWriter: LocalEventWriter,
  reporter: LocalEvalReporterLike,
  model: unknown,
): () => void {
  return eventWriter.subscribe((frame) => {
    if (frame.kind !== 'stream.resp') return;
    const response = parseRespData(frame.data);
    if (
      response?.type !== RespDataType.AgentMessage ||
      response.agent_message?.role !== Role.Assistant ||
      response.agent_message.kind !== undefined ||
      response.agent_message.msg_type === MsgType.SystemEvent
    ) {
      return;
    }
    const message = response.agent_message;
    runLocalEvalCapture('assistant_message', () => {
      reporter.reportAssistantMessage({
        content: message.msg_content ?? '',
        model,
        ...(message.finish_reason ? { stopReason: message.finish_reason } : {}),
      });
    });
  });
}

export function beginLocalEvalTurn(
  factory: LocalEvalReporterFactoryLike | undefined,
  input: LocalEvalTurnContext,
): LocalEvalReporterLike | undefined {
  let reporter: LocalEvalReporterLike | undefined;
  try {
    reporter = factory?.canReport()
      ? factory.getReporter({
          sessionId: input.sessionId,
          workspaceDir: input.workspaceDir,
        })
      : undefined;
  } catch (error) {
    logLocalEvalCaptureFailure('initialize', error);
  }
  runLocalEvalCapture('begin_turn', () => {
    reporter?.beginTurn({
      turnId: input.turnId,
      userMessage: input.userMessage,
      model: input.model,
      apiKey: input.apiKey,
    });
  });
  return reporter;
}

export function finishLocalEvalTurn(
  reporter: LocalEvalReporterLike | undefined,
  outcome: LocalEvalTurnOutcome,
): void {
  runLocalEvalCapture('finish_turn', () => {
    reporter?.finishTurn({
      status:
        outcome.status === 'completed'
          ? 'completed'
          : outcome.status === 'aborted'
            ? 'aborted'
            : 'failed',
      ...(outcome.errorMessage ? { error: outcome.errorMessage } : {}),
    });
  });
}

export function failLocalEvalTurn(
  reporter: LocalEvalReporterLike | undefined,
  error: unknown,
  aborted: boolean,
): void {
  runLocalEvalCapture('finish_turn', () => {
    reporter?.finishTurn({
      status: aborted ? 'aborted' : 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function withLocalEvalReporting(
  hooks: PiTurnHooks | undefined,
  reporter: LocalEvalReporterLike,
  model: unknown,
): PiTurnHooks {
  const toolStartedAtMs = new Map<string, number>();
  return {
    ...hooks,
    beforeLlmCallHook: [
      ...(hooks?.beforeLlmCallHook ?? []),
      (input) => {
        runLocalEvalCapture('snapshot', () => {
          reporter.reportSnapshot({
            turnId: input.turnId,
            phase: input.phase,
            messages: input.messages,
            systemPrompt: input.systemPrompt,
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
          runLocalEvalCapture('usage', () => {
            reporter.reportUsage({
              usage: input.message.usage,
              model,
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
        runLocalEvalCapture('tool_call', () => {
          reporter.reportToolCall({
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
        runLocalEvalCapture('tool_result', () => {
          reporter.reportToolResult({
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
