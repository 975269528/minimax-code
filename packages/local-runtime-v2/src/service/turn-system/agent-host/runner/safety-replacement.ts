import { toPiUserMessage, type PiHistoryChangedHookInput } from '@mavis/agent-core/pi-turn-runner';
import { buildCompletedTerminalStatusEvent } from '@mavis/agent-core/event-bridge';
import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { RUNTIME_EVENT_SCHEMA, RuntimeEventType } from '@mavis/protocol';

import type {
  LocalRuntimeTurnRunnerInput,
  LocalRuntimeTurnRunnerResult,
} from '../execution/executor.js';

/** Persist the approved fixed answer before publishing it through normal delivery. */
export async function appendSafetyReplacement(
  input: LocalRuntimeTurnRunnerInput,
  text: string,
  state: {
    readonly eventIdGenerator: NonNullable<LocalRuntimeTurnRunnerInput['eventIdGenerator']>;
    readonly runtimeSeqGenerator: NonNullable<LocalRuntimeTurnRunnerInput['runtimeSeqGenerator']>;
    approvedPartial?: LocalRuntimeTurnRunnerResult['approvedPartial'];
  },
): Promise<boolean> {
  if (input.signal?.aborted) return false;
  const messageId = state.eventIdGenerator('safety-replacement-message');
  const messages: PiHistoryChangedHookInput['messages'] = [
    ...(input.beforeUserMessages ?? []),
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
      timestamp: Date.now(),
    },
  ];
  for (const hook of input.hooks?.onHistoryChangedHook ?? []) {
    if (input.signal?.aborted) return false;
    await hook({
      sessionId: input.sessionId,
      turnId: input.turnId,
      reason: 'messageDelta',
      messages,
    });
  }
  if (input.signal?.aborted) return false;
  await input.eventWriter.appendEvents([
    {
      schema: RUNTIME_EVENT_SCHEMA,
      event_id: state.eventIdGenerator('safety-replacement'),
      runtime_seq: state.runtimeSeqGenerator(),
      session_id: input.sessionId,
      turn_id: input.turnId,
      type: RuntimeEventType.STREAM_RESP,
      payload: {
        stream_resp: JSON.stringify({
          type: RespDataType.AgentMessage,
          agent_message: { msg_id: messageId, role: 'assistant', msg_content: text },
        }),
      },
    },
    {
      ...buildCompletedTerminalStatusEvent({
        sessionId: input.sessionId,
        turnId: input.turnId,
        statusEventId: state.eventIdGenerator('safety-replacement-completed'),
      }),
      runtime_seq: state.runtimeSeqGenerator(),
    },
  ]);
  state.approvedPartial = { thinking: '', content: text, msgId: messageId };
  return true;
}
