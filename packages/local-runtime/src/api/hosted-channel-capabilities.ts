import type {
  ConversationChannelContext,
  ConversationCommittedMessage,
} from '@mavis/conversation-contract';

import type { LocalChannelRunner } from '../channels/runner.js';
import { channelContextFromMessageContext } from './channel-context.js';

export interface HostedChannelCapabilitiesHost {
  readonly deliverReplyFromMessages: LocalChannelRunner['deliverReplyFromMessages'];
  readonly notifyTurnStart: LocalChannelRunner['notifyTurnStart'];
  readonly notifyTurnEnd: LocalChannelRunner['notifyTurnEnd'];
}

export interface HostedChannelFinalReplyInput {
  readonly channelContext: ConversationChannelContext;
  readonly sessionId: string;
  readonly messages: readonly ConversationCommittedMessage[];
  readonly workspaceDir?: string;
  readonly error?: string;
}

export type HostedChannelCapabilities = ReturnType<typeof createHostedChannelCapabilities>;

/** Narrow product-owned Channel transport capability consumed through compat/v1. */
export function createHostedChannelCapabilities(host: HostedChannelCapabilitiesHost) {
  return {
    finalReplies: {
      deliver: (input: HostedChannelFinalReplyInput) =>
        host.deliverReplyFromMessages(
          channelContextFromMessageContext(input.channelContext),
          input.messages,
          input.sessionId,
          input.workspaceDir,
          input.error,
        ),
    },
    typing: {
      start: (input: Pick<HostedChannelFinalReplyInput, 'channelContext' | 'sessionId'>) =>
        host.notifyTurnStart(channelContextFromMessageContext(input.channelContext)),
      end: (input: Pick<HostedChannelFinalReplyInput, 'channelContext' | 'sessionId'>) =>
        host.notifyTurnEnd(channelContextFromMessageContext(input.channelContext)),
    },
  } as const;
}
