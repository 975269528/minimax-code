import type { PiEventWriter } from '@mavis/agent-core/pi-turn-runner';
import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventType, type IRuntimeEvent } from '@mavis/protocol';

import type {
  LocalEventSinkSnapshot,
  LocalEventSubscriber,
  LocalEventWriter,
} from '../events/sink.js';
import type { LocalRuntimeProjectionFrame } from '../runtime/projection.js';
import { createWebsiteDeployAfterLlmHook } from './projector.js';
import { createWebsiteDeployAfterToolCallHook, WebsiteDeployTurnState } from './turn-state.js';

/** Holds only assistant text after a successful website deploy; tool frames keep flowing. */
export class WebsiteDeployProjectionEventWriter implements PiEventWriter, LocalEventWriter {
  constructor(
    private readonly inner: LocalEventWriter,
    private readonly state: WebsiteDeployTurnState,
  ) {}

  get events(): readonly IRuntimeEvent[] {
    return this.inner.events;
  }

  get frames(): readonly LocalRuntimeProjectionFrame[] {
    return this.inner.frames;
  }

  subscribe(subscriber: LocalEventSubscriber): () => void {
    return this.inner.subscribe(subscriber);
  }

  snapshot(): LocalEventSinkSnapshot {
    return this.inner.snapshot();
  }

  async pushRuntime(event: IRuntimeEvent): Promise<void> {
    const projected = projectWebsiteDeployRuntimeEvent(event, this.state);
    if (projected) await this.inner.pushRuntime(projected);
  }

  async appendEvents(events: IRuntimeEvent[]): Promise<void> {
    for (const event of events) await this.pushRuntime(event);
  }
}

/** Reuses the same trust boundary when a newer turn owner owns runtime event delivery. */
export function projectWebsiteDeployRuntimeEvent(
  event: IRuntimeEvent,
  state: WebsiteDeployTurnState,
): IRuntimeEvent | undefined {
  if (!state.isProjectionActive() || event.type !== RuntimeEventType.STREAM_RESP) return event;
  const raw = event.payload.stream_resp;
  if (typeof raw !== 'string') return event;
  try {
    const data = JSON.parse(raw) as {
      type?: number;
      agent_message_chunk?: Record<string, unknown>;
    };
    if (data.type !== RespDataType.AgentMessageChunk || !data.agent_message_chunk) return event;
    const chunk = data.agent_message_chunk;
    if (typeof chunk.msg_content !== 'string' || chunk.msg_content.length === 0) return event;
    const toolCalls = chunk.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
    return {
      ...event,
      payload: {
        ...event.payload,
        stream_resp: JSON.stringify({
          ...data,
          agent_message_chunk: { ...chunk, msg_content: '' },
        }),
      },
    };
  } catch {
    return event;
  }
}

/** One feature-local bundle used by every local turn shape that exposes website_deploy. */
export function createWebsiteDeployTurnProjection(eventWriter: LocalEventWriter) {
  const state = new WebsiteDeployTurnState();
  return {
    eventWriter: new WebsiteDeployProjectionEventWriter(eventWriter, state),
    afterToolCallHook: createWebsiteDeployAfterToolCallHook(state),
    afterLlmCallHook: createWebsiteDeployAfterLlmHook(state),
  };
}
