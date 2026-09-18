import {
  RuntimeEventStatus,
  RuntimeEventType,
  type RuntimeEvent,
} from '@mavis/agent-core/protocol';
import type { ConversationChannelContext } from '@mavis/conversation-contract';

import type { DisplayMessageRecord } from '../../session-system/index.js';
import { toConversationCommittedMessage } from '../../session-system/index.js';
import type { ChannelFinalReplyObserverOptions, ChannelReplyEventContext } from '../contracts.js';
import { resolveChannelRoute } from './routing.js';

/**
 * Best-effort terminal observer for Channel-sourced Turns.
 *
 * The Agent event pipeline only selects a durable terminal boundary. Actual
 * Channel routing and transport delivery stay behind an injected product
 * capability.
 */
export class ChannelFinalReplyObserver {
  constructor(private readonly options: ChannelFinalReplyObserverOptions) {}

  async observeRuntimeEvent(input: {
    readonly context: ChannelReplyEventContext;
    readonly event: RuntimeEvent;
  }): Promise<void> {
    const status = terminalStatus(input.event);
    if (!status) return;
    try {
      const channelContext = await this.resolveChannelContext(input.context);
      if (!channelContext) return;
      const [messages, session] = await Promise.all([
        this.options.messages.listTurn(input.context.sessionId, input.context.turnId),
        this.options.sessions.get(input.context.sessionId),
      ]);
      const hasAssistantReply = messages.some(isAssistantReply);
      if (status !== 'failed' && !hasAssistantReply) return;
      const error = status === 'failed' ? terminalError(input.event) : undefined;
      await this.options.delivery.deliver({
        channelContext,
        sessionId: input.context.sessionId,
        messages: messages.map(toConversationCommittedMessage),
        ...(session ? { workspaceDir: session.workspaceDir } : {}),
        ...(error ? { error } : {}),
      });
    } finally {
      await this.options.turnLifecycle.end(input.context);
    }
  }

  private async resolveChannelContext(
    context: ChannelReplyEventContext,
  ): Promise<ConversationChannelContext | undefined> {
    const admitted = resolveChannelRoute(context.provenance);
    if (admitted) return admitted;
    const persisted = await this.options.messages.resolveTurnSource(
      context.sessionId,
      context.turnId,
    );
    return resolveChannelRoute(persisted);
  }
}

function terminalStatus(event: RuntimeEvent): 'completed' | 'failed' | 'aborted' | undefined {
  if (
    event.type !== RuntimeEventType.SESSION_STATUS &&
    event.type !== RuntimeEventType.TURN_TERMINAL
  ) {
    return undefined;
  }
  if (event.payload.status === RuntimeEventStatus.COMPLETED) return 'completed';
  if (event.payload.status === RuntimeEventStatus.FAILED) return 'failed';
  return event.payload.status === RuntimeEventStatus.ABORTED ? 'aborted' : undefined;
}

function terminalError(event: RuntimeEvent): string {
  const error = event.payload.error?.message?.trim();
  if (error) return error;
  const stopReason = event.payload.stop_reason?.message?.trim();
  return stopReason || 'Turn failed';
}

function isAssistantReply(message: DisplayMessageRecord): boolean {
  return message.role === 'assistant';
}
