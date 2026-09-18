import { RespDataType, type AgentMessage } from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventType, type IRuntimeEvent } from '@mavis/protocol';

import type { LocalOutputSafetyEventWriter } from './output-safety-writer.js';

/**
 * On a soft stop, emit a final AgentMessage containing only approved thinking/content so
 * persistence (observeFrame → upsertDisplayMessage) commits the approved portion. Reuse the turn's
 * assistant approvedMsgId to merge with displayed chunks via msg_id upsert.
 *
 * Split into a separate file to keep output-safety-writer.ts within the layout gate's default
 * 500-line budget (see scripts/check-local-runtime-layout.mjs).
 */
export async function flushApprovedOnNetworkStop(
  writer: LocalOutputSafetyEventWriter,
): Promise<void> {
  // This helper is an internal writer API; access private state through a structural type cast.
  // The alternative is public writer getters, which expose internal state and increase coupling.
  const internal = writer as unknown as InternalWriterState;
  // Background/headless retries resend the whole turn; persisting partial approved text leaves duplicate/stale fragments, so disable synthetic final persistence.
  if (internal.deps.persistApprovedPartialOnNetworkStop === false) return;
  if (!internal.approvedThinking && !internal.approvedContent) return;
  if (!internal.approvedMsgId) return;
  const message: AgentMessage = {
    msg_id: internal.approvedMsgId,
    role: 'assistant',
    ...(internal.approvedThinking ? { thinking_content: internal.approvedThinking } : {}),
    // Downstream treats missing final msg_content as no body. When a soft stop preserves thinking only,
    // supply an empty string so this is a normal terminal assistant message, not an error/placeholder.
    msg_content: internal.approvedContent,
  };
  const event: IRuntimeEvent = {
    schema: 'runtime.event/v1',
    event_id: `local-output-network-stop-approved-${internal.approvedMsgId}`,
    type: RuntimeEventType.STREAM_RESP,
    payload: {
      stream_resp: JSON.stringify({
        type: RespDataType.AgentMessage,
        agent_message: message,
      }),
    },
  } as IRuntimeEvent;
  await internal.inner.pushRuntime(event);
}

/**
 * Minimal internal structural type listing only the private fields accessed by the helper; never
 * exposed externally.
 */
interface InternalWriterState {
  readonly deps: {
    persistApprovedPartialOnNetworkStop?: boolean;
    onBlocked?: () => void;
  };
  approvedThinking: string;
  approvedContent: string;
  approvedMsgId: string | undefined;
  readonly inner: { pushRuntime: (event: IRuntimeEvent) => Promise<void> };
}
