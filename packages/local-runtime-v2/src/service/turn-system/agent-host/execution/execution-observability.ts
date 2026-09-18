import { buildStreamRespEvent } from '@mavis/agent-core/event-bridge';
import { MsgType, RespDataType } from '@mavis/agent-core/protocol';
import type { PiBeforeLlmCallHookInput, PiTurnHooks } from '@mavis/agent-core/pi-turn-runner';

/** Metadata-only opt-in. No budget decisions, prompt changes or tool controls. */
export function withExecutionObservability(hooks: PiTurnHooks, enabled: boolean): PiTurnHooks {
  if (!enabled) return hooks;
  let current:
    | { input: PiBeforeLlmCallHookInput; operationId: string; startedAt: number }
    | undefined;
  let sequence = 0;
  const emit = async (input: PiBeforeLlmCallHookInput, data: Record<string, unknown>) => {
    if (!input.eventWriter || !input.eventIdGenerator || !input.runtimeSeqGenerator) return;
    const eventId = input.eventIdGenerator('exec_diagnostic');
    try {
      await input.eventWriter.pushRuntime(
        buildStreamRespEvent({
          sessionId: input.sessionId,
          turnId: input.turnId,
          eventId,
          runtimeSeq: input.runtimeSeqGenerator(),
          respData: {
            type: RespDataType.AgentMessage,
            agent_message: {
              msg_id: eventId,
              turn_id: input.turnId,
              timestamp: Date.now(),
              msg_type: MsgType.SystemEvent,
              msg_content: JSON.stringify({ eventType: 'execution.diagnostic', ...data }),
            },
          },
        }),
      );
    } catch {
      // Observability must not change model execution or replace its failure.
    }
  };
  return {
    ...hooks,
    beforeLlmCallHook: [
      async (input) => {
        const operationId = `${input.turnId}:model:${++sequence}`;
        current = { input, operationId, startedAt: performance.now() };
        await emit(input, {
          kind: 'model_phase_started',
          operationId,
          modelId: input.model.id,
          protocol: input.model.api,
        });
        return undefined;
      },
      ...(hooks.beforeLlmCallHook ?? []),
    ],
    afterLlmCallHook: [
      async ({ message }) => {
        if (current) {
          const { input, operationId, startedAt } = current;
          current = undefined;
          await emit(input, {
            kind:
              message.stopReason === 'error' || message.stopReason === 'aborted'
                ? 'model_phase_failed'
                : 'model_phase_finished',
            operationId,
            durationMs: Math.max(0, performance.now() - startedAt),
            finishReason: message.stopReason,
          });
        }
        return undefined;
      },
      ...(hooks.afterLlmCallHook ?? []),
    ],
  };
}
