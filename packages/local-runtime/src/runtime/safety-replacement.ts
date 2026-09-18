import { toPiUserMessage, type PiAgentMessage } from '@mavis/agent-core/pi-turn-runner';
import { buildCompletedTerminalStatusEvent } from '@mavis/agent-core/event-bridge';
import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventType, type IRuntimeEvent } from '@mavis/protocol';
import type { LocalEventWriter } from '../events/sink.js';
import type { LocalRuntimeTurnInput, LocalToolContext } from './host-types.js';

/** Persist a trusted fixed answer through the same history and display lanes as Pi. */
export async function writeSafetyReplacement<TCtx extends LocalToolContext>(
  input: LocalRuntimeTurnInput<TCtx> & { readonly eventWriter: LocalEventWriter },
  text: string,
): Promise<boolean> {
  if (input.signal?.aborted) return false;
  const now = Date.now();
  const messages: PiAgentMessage[] = [
    ...(input.history ?? []),
    ...(input.startMode === 'continue' ? [] : [toPiUserMessage(input.userMessage)]),
    {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: input.llm.model.api,
      provider: input.llm.model.provider,
      model: input.llm.model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: now,
    },
  ];
  for (const hook of input.hooks?.onHistoryChangedHook ?? []) {
    await hook({
      sessionId: input.sessionId,
      turnId: input.turnId,
      reason: 'replaceMessages',
      previousMessages: input.history ?? [],
      messages,
    });
  }
  if (input.signal?.aborted) {
    // Canonical history and display must agree when cancellation wins before delivery.
    for (const hook of input.hooks?.onHistoryChangedHook ?? []) {
      await hook({
        sessionId: input.sessionId,
        turnId: input.turnId,
        reason: 'replaceMessages',
        previousMessages: messages,
        messages: [...(input.history ?? [])],
      });
    }
    return false;
  }
  const msgId = `local-fixed-answer-${input.turnId}`;
  await input.eventWriter.appendEvents([
    {
      schema: 'runtime.event/v1',
      event_id: `${msgId}-event`,
      session_id: input.sessionId,
      turn_id: input.turnId,
      type: RuntimeEventType.STREAM_RESP,
      payload: {
        stream_resp: JSON.stringify({
          type: RespDataType.AgentMessage,
          agent_message: { msg_id: msgId, role: 'assistant', msg_content: text },
        }),
      },
    } as IRuntimeEvent,
    buildCompletedTerminalStatusEvent({
      sessionId: input.sessionId,
      turnId: input.turnId,
      statusEventId: `${msgId}-status`,
    }),
  ]);
  return true;
}
