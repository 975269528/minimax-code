import { createHash } from 'node:crypto';

import type { ChannelRoutingMode } from '@mavis/shared';

import type {
  LocalChannelBinding,
  LocalChannelContext,
  LocalChannelRoutePreview,
} from './infra.js';
import type { SessionStrategy } from './route-api.js';

export function buildScopeKey(preview: LocalChannelRoutePreview, ctx: LocalChannelContext): string {
  return stableDigest([
    preview.exactOwnerName,
    preview.ownerInstanceId ?? '',
    preview.projectKey,
    preview.routingMode,
    ctx.platform,
    ctx.clientName,
    semanticScope(preview.routingMode, ctx, preview.sessionTitle),
  ]);
}

export function buildSessionPurpose(input: {
  ctx: LocalChannelContext;
  exactOwnerName: string;
  ownerInstanceId?: string;
  projectKey: string;
  routingMode: ChannelRoutingMode;
  generation: number;
  sessionTitle: string;
}): string {
  return `channel:v2:${stableDigest([
    input.exactOwnerName,
    input.ownerInstanceId ?? '',
    input.projectKey,
    input.routingMode,
    input.ctx.platform,
    input.ctx.clientName,
    semanticScope(input.routingMode, input.ctx, input.sessionTitle),
    String(input.generation),
  ])}`;
}

export function buildSessionTitle(ctx: LocalChannelContext, strategy: SessionStrategy): string {
  if (strategy === 'per-sender') return `${ctx.platform}-sender`;
  if (strategy === 'per-chat') return `${ctx.platform}-chat`;
  return `${ctx.platform}-channel`;
}

export function contextForBinding(binding: LocalChannelBinding): LocalChannelContext {
  return {
    platform: binding.platform,
    chatType: '*',
    chatId: binding.chatId,
    senderId: binding.senderId,
    clientName: binding.clientName,
    ...(binding.threadId ? { threadId: binding.threadId } : {}),
    lane: binding.lane,
  };
}

export function strategyForRoutingMode(mode: ChannelRoutingMode): SessionStrategy {
  return mode === 'project-main' ? 'root' : mode;
}

function semanticScope(
  routingMode: ChannelRoutingMode,
  ctx: LocalChannelContext,
  sessionTitle: string,
): string {
  if (routingMode === 'per-sender') return ctx.senderId;
  if (routingMode === 'per-chat') return ctx.chatId;
  if (routingMode === 'project-main') return 'project-main';
  return sessionTitle || ctx.chatId;
}

function stableDigest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
