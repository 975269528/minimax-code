import type { LocalChannelContext } from '../channels/infra.js';
import type { LocalMessageChannelContext } from '../messages/input.js';

export function channelContextFromMessageContext(
  ctx: LocalMessageChannelContext,
): LocalChannelContext {
  return {
    platform: parseChannelPlatform(ctx.platform),
    chatType: ctx.chatType,
    chatId: ctx.chatId,
    senderId: ctx.senderId,
    clientName: ctx.clientName,
    ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
    ...(ctx.sourceMessageId ? { sourceMessageId: ctx.sourceMessageId } : {}),
    ...(ctx.contextToken ? { contextToken: ctx.contextToken } : {}),
  };
}

function parseChannelPlatform(platform: string): LocalChannelContext['platform'] {
  if (platform === 'feishu' || platform === 'telegram' || platform === 'wechat') return platform;
  throw new Error(`Unsupported questionnaire channel platform: ${platform}`);
}
