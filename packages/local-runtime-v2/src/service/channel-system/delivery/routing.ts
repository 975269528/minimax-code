import type { ConversationChannelContext } from '@mavis/conversation-contract';

import type { MessageSourceRecord } from '../../session-system/index.js';

export function resolveChannelRoute(
  input:
    | MessageSourceRecord
    | {
        readonly source: string;
        readonly sourceContext?: Readonly<Record<string, unknown>>;
      }
    | undefined,
): ConversationChannelContext | undefined {
  const source = input?.source;
  if (!source || (!source.startsWith('channel:') && source !== 'questionnaire')) {
    return undefined;
  }
  const sourceContext = nestedChannelContext(input.sourceContext);
  if (!sourceContext) return undefined;
  const platform = readString(sourceContext, 'platform');
  const chatType = readString(sourceContext, 'chatType');
  const chatId = readString(sourceContext, 'chatId');
  const senderId = readString(sourceContext, 'senderId');
  const clientName = readString(sourceContext, 'clientName');
  if (!platform || !chatType || !chatId || !senderId || !clientName) return undefined;
  return {
    platform,
    chatType,
    chatId,
    senderId,
    clientName,
    ...optionalString(sourceContext, 'threadId'),
    ...optionalString(sourceContext, 'sourceMessageId'),
    ...optionalString(sourceContext, 'contextToken'),
    ...optionalString(sourceContext, 'channel'),
    ...optionalString(sourceContext, 'channel_id'),
  };
}

function nestedChannelContext(
  sourceContext: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!sourceContext) return undefined;
  const nested = sourceContext.channelContext;
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? (nested as Readonly<Record<string, unknown>>)
    : sourceContext;
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, string>> {
  const field = readString(value, key);
  return field ? { [key]: field } : {};
}

function readString(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.trim() ? field : undefined;
}
