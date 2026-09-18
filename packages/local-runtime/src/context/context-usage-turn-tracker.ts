import type { AgentMessage as PiAgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import {
  streamSimple,
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { PiEventWriter } from '@mavis/agent-core/pi-turn-runner';
import {
  RespDataType,
  type AgentMessage,
  type RespData,
} from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventType, type IRuntimeEvent } from '@mavis/protocol';

import {
  applyToolCalibration,
  buildContextUsageMeasurement,
  estimatePreparedContext,
} from './context-usage.js';
import {
  ContextUsageCalibrationCoordinator,
  type ContextUsageToolCalibration,
} from './context-usage-calibration.js';
import { buildContextUsageProviderDiagnostics } from './context-usage-provider-diagnostics.js';
import type {
  ContextUsageDebugMeasurement,
  ContextUsageProviderUsage,
  PreparedContextEstimate,
  PromptRange,
} from './context-usage-types.js';
import type { RemoteTokenCounter } from './remote-token-counter.js';

interface PreparedMeasurement {
  seq: number;
  modelId: string;
  estimate: Promise<PreparedContextEstimate>;
  toolCalibration?: ContextUsageToolCalibration;
  toolCalibrationRequest?: Promise<ContextUsageToolCalibration>;
  toolCalibrationInput?: {
    context: Context;
    model: Model<Api>;
  };
  diagnosticInput?: {
    context: Context;
    model: Model<Api>;
    exactProviderPayload?: unknown;
    streamOptions?: SimpleStreamOptions;
  };
  diagnosticsStarted?: boolean;
}

/**
 * Captures the Context prepared for each provider call and decorates completed
 * assistant frames. Product snapshots use the message usage anchor and never
 * capture the Provider wire payload or wait for Context Usage remote checks.
 */
export class ContextUsageTurnTracker {
  private measurementSeq = 0;
  private latestMeasurement: PreparedMeasurement | undefined;

  constructor(
    private readonly contextWindowTokens: number,
    private readonly promptRanges: readonly PromptRange[],
    private readonly onDebugMeasurement?: (measurement: ContextUsageDebugMeasurement) => void,
    private readonly calibrationCoordinator?: ContextUsageCalibrationCoordinator,
    private readonly providerDiagnosticCounter?: RemoteTokenCounter,
    private readonly requireProviderAnchor = false,
  ) {}

  wrapStreamFn(inner?: StreamFn): StreamFn {
    const base = inner ?? streamSimple;
    return ((model, context, options) => {
      const seq = ++this.measurementSeq;
      const streamOptions = options as SimpleStreamOptions | undefined;
      const diagnosticInput: PreparedMeasurement['diagnosticInput'] = this.providerDiagnosticCounter
        ? {
            context: {
              systemPrompt: context.systemPrompt,
              tools: [...(context.tools ?? [])],
              messages: [...(context.messages ?? [])],
            },
            model,
            ...(streamOptions ? { streamOptions } : {}),
          }
        : undefined;
      const toolCalibrationInput: PreparedMeasurement['toolCalibrationInput'] = this
        .calibrationCoordinator
        ? {
            context: {
              systemPrompt: '',
              tools: [...(context.tools ?? [])],
              messages: [],
            },
            model,
          }
        : undefined;
      const toolCalibration = this.calibrationCoordinator?.getCachedToolCalibration({
        context,
        model,
      });
      const measurement: PreparedMeasurement = {
        seq,
        modelId: model.id,
        estimate: Promise.resolve().then(() =>
          estimatePreparedContext(context, this.promptRanges, model),
        ),
        ...(toolCalibration ? { toolCalibration } : {}),
        ...(toolCalibrationInput ? { toolCalibrationInput } : {}),
        ...(diagnosticInput ? { diagnosticInput } : {}),
      };
      this.latestMeasurement = measurement;
      if (this.calibrationCoordinator && !toolCalibration) {
        measurement.toolCalibrationRequest = this.calibrationCoordinator.calibrateTools({
          context,
          model,
          ...(streamOptions ? { streamOptions } : {}),
        });
        void measurement.toolCalibrationRequest.then((result) => {
          measurement.toolCalibration = result;
        });
      }
      if (!diagnosticInput) return base(model, context, options);

      const originalOnPayload = streamOptions?.onPayload;
      const captureOnPayload: NonNullable<SimpleStreamOptions['onPayload']> = async (
        payload,
        payloadModel,
      ) => {
        const transformed = await originalOnPayload?.(payload, payloadModel);
        diagnosticInput.exactProviderPayload = transformed ?? payload;
        return transformed;
      };
      return base(model, context, {
        ...(streamOptions ?? {}),
        onPayload: captureOnPayload,
      });
    }) as StreamFn;
  }

  async decorateRuntimeEvent(event: IRuntimeEvent): Promise<IRuntimeEvent> {
    if (event.type !== RuntimeEventType.STREAM_RESP) return event;
    const raw = event.payload?.stream_resp;
    if (typeof raw !== 'string' || !raw) return event;
    const respData = parseRespData(raw);
    const message = respData?.agent_message;
    if (respData?.type !== RespDataType.AgentMessage || !message) return event;

    const measurement = this.latestMeasurement;
    if (!measurement) return event;
    const providerUsage = readProviderUsage(message.usage);
    if (
      this.requireProviderAnchor &&
      (!hasProviderInputAnchor(providerUsage) ||
        !Number.isFinite(providerUsage?.contextWindow) ||
        (providerUsage?.contextWindow ?? 0) <= 0)
    ) {
      return event;
    }
    const rawPrepared = await measurement.estimate.catch(() => undefined);
    if (!rawPrepared || measurement.seq !== this.measurementSeq) return event;
    const cachedToolCalibration =
      measurement.toolCalibrationInput && this.calibrationCoordinator
        ? this.calibrationCoordinator.getCachedToolCalibration({
            context: measurement.toolCalibrationInput.context,
            model: measurement.toolCalibrationInput.model,
          })
        : undefined;
    const toolCalibration = measurement.toolCalibration ?? cachedToolCalibration;
    if (measurement.seq !== this.measurementSeq) return event;
    const prepared = applyToolCalibration(rawPrepared, toolCalibration?.tokens);

    let measurementResult = buildContextUsageMeasurement({
      contextWindowTokens:
        this.requireProviderAnchor && providerUsage?.contextWindow
          ? providerUsage.contextWindow
          : this.contextWindowTokens,
      prepared,
      providerUsage,
      retainedTail: [wireAssistantToPiMessage(message)],
    });
    const localToolsTokens =
      rawPrepared.components.find((component) => component.kind === 'TOOLS')?.tokens ?? 0;
    if (toolCalibration) {
      measurementResult = {
        ...measurementResult,
        debug: {
          ...measurementResult.debug,
          toolCalibration: {
            fingerprint: toolCalibration.fingerprint,
            status: toolCalibration.status,
            localTokens: localToolsTokens,
            ...(toolCalibration.tokens === undefined
              ? {}
              : { calibratedTokens: toolCalibration.tokens }),
          },
        },
      };
    } else if (
      measurement.toolCalibrationRequest &&
      measurement.toolCalibrationInput &&
      this.calibrationCoordinator
    ) {
      measurementResult = {
        ...measurementResult,
        debug: {
          ...measurementResult.debug,
          toolCalibration: {
            fingerprint: this.calibrationCoordinator.getToolFingerprint(
              measurement.toolCalibrationInput,
            ),
            status: 'PENDING',
            localTokens: localToolsTokens,
          },
        },
      };
    }

    try {
      this.onDebugMeasurement?.(measurementResult.debug);
    } catch {
      // Debug capture must never affect the turn or the product snapshot.
    }
    if (
      this.providerDiagnosticCounter &&
      measurement.diagnosticInput &&
      !measurement.diagnosticsStarted &&
      (message.tool_calls?.length ?? 0) === 0
    ) {
      measurement.diagnosticsStarted = true;
      void buildContextUsageProviderDiagnostics({
        ...measurement.diagnosticInput,
        promptRanges: this.promptRanges,
        prepared,
        counter: this.providerDiagnosticCounter,
        ...(measurementResult.debug.providerInputAnchor === undefined
          ? {}
          : { providerInputAnchor: measurementResult.debug.providerInputAnchor }),
      })
        .then((providerDiagnostics) => {
          if (measurement.seq !== this.measurementSeq) return;
          try {
            this.onDebugMeasurement?.({
              ...measurementResult.debug,
              providerDiagnostics,
            });
          } catch {
            // Optional diagnostics must never affect the turn.
          }
        })
        .catch(() => {
          // The diagnostic builder is fail-closed; keep this final guard so an
          // unexpected sidecar failure cannot become an unhandled rejection.
        });
    }
    const telemetry =
      event.turn_id && measurement.modelId
        ? {
            trigger: 'terminal' as const,
            turnId: event.turn_id,
            model: measurement.modelId,
            localTokens: measurementResult.debug.rawPreparedTokens,
            ...(measurementResult.debug.providerInputAnchor === undefined
              ? {}
              : { providerTokens: measurementResult.debug.providerInputAnchor }),
            ...(measurementResult.debug.divergence.signedRate === null
              ? {}
              : { divergenceRate: measurementResult.debug.divergence.signedRate }),
            ...(measurementResult.debug.toolCalibration
              ? {
                  toolCalibrationStatus: measurementResult.debug.toolCalibration.status,
                }
              : {}),
          }
        : undefined;
    const decorated: RespData = {
      ...respData,
      agent_message: {
        ...message,
        context_usage: measurementResult.snapshot,
        ...(telemetry ? { context_usage_telemetry: telemetry } : {}),
      },
    };
    return {
      ...event,
      payload: {
        ...event.payload,
        stream_resp: JSON.stringify(decorated),
      },
    };
  }
}

export function withContextUsageEventWriter(
  delegate: PiEventWriter,
  tracker: ContextUsageTurnTracker,
): PiEventWriter {
  return {
    async pushRuntime(event): Promise<void> {
      await delegate.pushRuntime(await tracker.decorateRuntimeEvent(event));
    },
    async appendEvents(events): Promise<void> {
      const decorated: IRuntimeEvent[] = [];
      for (const event of events) {
        decorated.push(await tracker.decorateRuntimeEvent(event));
      }
      await delegate.appendEvents(decorated);
    },
  };
}

function parseRespData(raw: string): RespData | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as RespData) : undefined;
  } catch {
    return undefined;
  }
}

function readProviderUsage(usage: AgentMessage['usage']): ContextUsageProviderUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const raw = usage as AgentMessage['usage'] & {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
  return {
    ...(typeof raw.input_tokens === 'number' ? { input: raw.input_tokens } : {}),
    ...(typeof raw.output_tokens === 'number' ? { output: raw.output_tokens } : {}),
    ...(typeof raw.cache_read === 'number' ? { cacheRead: raw.cache_read } : {}),
    ...(typeof raw.cache_write === 'number' ? { cacheWrite: raw.cache_write } : {}),
    ...(typeof raw.total_tokens === 'number' ? { total: raw.total_tokens } : {}),
    ...(typeof raw.context_window === 'number' ? { contextWindow: raw.context_window } : {}),
  };
}

function hasProviderInputAnchor(usage: ContextUsageProviderUsage | undefined): boolean {
  return [usage?.input, usage?.cacheRead, usage?.cacheWrite].some(
    (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  );
}

function wireAssistantToPiMessage(message: AgentMessage): PiAgentMessage {
  const content: Array<Record<string, unknown>> = [];
  if (message.thinking_content) {
    content.push({ type: 'thinking', thinking: message.thinking_content });
  }
  if (message.msg_content) {
    content.push({ type: 'text', text: message.msg_content });
  }
  for (const toolCall of message.tool_calls ?? []) {
    content.push({
      type: 'toolCall',
      id: toolCall.tool_call_id,
      name: toolCall.tool_name,
      arguments: parseJsonValue(toolCall.tool_call_args),
    });
  }
  return {
    role: 'assistant',
    content,
    timestamp: message.timestamp ?? 0,
    stopReason: message.finish_reason ?? 'stop',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as unknown as PiAgentMessage;
}

function parseJsonValue(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
