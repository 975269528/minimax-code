import type { DisplayMessageRecord } from '../messages/repo/contract.js';
import { isUserMessageId, type UserMessageId } from '../shared/user-message-id.js';

export interface ForkDisplayBoundary {
  readonly assistant: DisplayMessageRecord | undefined;
  readonly assistantIndex: number;
  readonly assistantCanonicalMessageId: string | undefined;
  readonly beforeUserMessageId: UserMessageId | undefined;
  readonly isLatestConversationMessage: boolean;
}

/** Display-only relation rows never participate in the conversational Fork boundary. */
export function resolveForkDisplayBoundary(
  messages: readonly DisplayMessageRecord[],
  assistantMessageId?: string,
): ForkDisplayBoundary {
  const assistantIndex =
    assistantMessageId === undefined
      ? findLatestAssistantIndex(messages)
      : messages.findIndex((message) => message.msg_id === assistantMessageId);
  const assistant = assistantIndex >= 0 ? messages[assistantIndex] : undefined;
  const nextUser =
    assistantIndex >= 0
      ? messages
          .slice(assistantIndex + 1)
          .find((message) => message.role === 'user' && isUserMessageId(message.msg_id))
      : undefined;
  const latestConversationMessage = messages.slice().reverse().find(isConversationMessage);
  return {
    assistant,
    assistantIndex,
    assistantCanonicalMessageId: canonicalMessageId(assistant),
    beforeUserMessageId:
      nextUser?.msg_id && isUserMessageId(nextUser.msg_id) ? nextUser.msg_id : undefined,
    isLatestConversationMessage:
      assistant !== undefined && latestConversationMessage?.msg_id === assistant.msg_id,
  };
}

function canonicalMessageId(message: DisplayMessageRecord | undefined): string | undefined {
  const value = message?.canonical_message_id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function findLatestAssistantIndex(messages: readonly DisplayMessageRecord[]): number {
  const reverseIndex = messages
    .slice()
    .reverse()
    .findIndex((message) => message.role === 'assistant' && !isSpecial(message));
  return reverseIndex < 0 ? -1 : messages.length - reverseIndex - 1;
}

function isConversationMessage(message: DisplayMessageRecord): boolean {
  if (isSpecial(message)) return false;
  return (
    message.role === 'assistant' || (message.role === 'user' && isUserMessageId(message.msg_id))
  );
}

function isSpecial(message: DisplayMessageRecord): boolean {
  return (
    (typeof message.kind === 'string' && message.kind.length > 0) ||
    (typeof message.displayKind === 'string' && message.displayKind.length > 0)
  );
}
