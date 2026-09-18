import type { ChannelRoutingMode } from '@mavis/shared';

import { buildLocalChannelBindingKey } from './channel-inbound-utils.js';
import type {
  LocalChannelBinding,
  LocalChannelBindingWrite,
  LocalChannelContext,
} from './infra.js';
import { LocalChannelRootlessError } from './rootless-route-resolver.js';

export function attachProjectMainBinding(input: {
  bindings: Map<string, LocalChannelBinding>;
  ctx: LocalChannelContext;
  source: LocalChannelBinding;
  routeRuleId: string | null;
  nowMs: number;
}): LocalChannelBinding {
  const source = requireCurrentSource(input.bindings, input.source);
  assertConsistentProjectMainProfile(
    projectMainProfileMembers(input.bindings.values(), source),
    source,
  );
  const key = buildLocalChannelBindingKey(input.ctx);
  const existing = input.bindings.get(key);
  const binding = bindingFromContext(
    input.ctx,
    existing,
    {
      ...source,
      routeRuleId: input.routeRuleId,
    },
    source.generation,
    input.nowMs,
  );
  input.bindings.set(key, binding);
  return binding;
}

export function advanceProjectMainBindings(input: {
  bindings: Map<string, LocalChannelBinding>;
  ctx: LocalChannelContext;
  source: LocalChannelBinding;
  write: LocalChannelBindingWrite & {
    exactOwnerName: string;
    projectKey: string;
    routingMode: ChannelRoutingMode;
    expectedGeneration: number;
  };
  nowMs: number;
}): LocalChannelBinding {
  const source = requireCurrentSource(input.bindings, input.source);
  if (source.generation !== input.write.expectedGeneration) throw generationConflict();
  const members = projectMainProfileMembers(input.bindings.values(), source);
  assertConsistentProjectMainProfile(members, source);
  const memberKeys = new Set(members.map((binding) => binding.key));
  const targetCollision = [...input.bindings.values()].find(
    (binding) =>
      !memberKeys.has(binding.key) &&
      binding.exactOwnerName === input.write.exactOwnerName &&
      binding.platform === source.platform &&
      binding.clientName === source.clientName &&
      binding.routingMode === 'project-main',
  );
  if (targetCollision) {
    throw new LocalChannelRootlessError(
      409,
      'CHANNEL_BINDING_TARGET_PROFILE_CONFLICT',
      'The target Agent already has a project-main Channel binding profile.',
    );
  }
  const generation = source.generation + 1;
  for (const member of members) {
    input.bindings.set(member.key, {
      ...member,
      agentName: input.write.agentName,
      sessionId: input.write.sessionId,
      strategy: input.write.strategy,
      pinned: false,
      exactOwnerName: input.write.exactOwnerName,
      ...(input.write.ownerInstanceId
        ? { ownerInstanceId: input.write.ownerInstanceId }
        : { ownerInstanceId: undefined }),
      projectKey: input.write.projectKey,
      routingMode: 'project-main',
      generation,
      updatedAt: input.nowMs,
    });
  }
  const key = buildLocalChannelBindingKey(input.ctx);
  if (!memberKeys.has(key)) {
    input.bindings.set(
      key,
      bindingFromContext(input.ctx, input.bindings.get(key), input.write, generation, input.nowMs),
    );
  }
  return input.bindings.get(key) ?? input.bindings.get(source.key)!;
}

function projectMainProfileMembers(
  bindings: Iterable<LocalChannelBinding>,
  source: LocalChannelBinding,
): LocalChannelBinding[] {
  return [...bindings].filter(
    (binding) =>
      binding.exactOwnerName === source.exactOwnerName &&
      binding.ownerInstanceId === source.ownerInstanceId &&
      binding.platform === source.platform &&
      binding.clientName === source.clientName &&
      binding.projectKey === source.projectKey &&
      binding.routingMode === 'project-main',
  );
}

function assertConsistentProjectMainProfile(
  bindings: Iterable<LocalChannelBinding>,
  source: LocalChannelBinding,
): void {
  const diverged = [...bindings].some(
    (binding) => binding.sessionId !== source.sessionId || binding.generation !== source.generation,
  );
  if (diverged) {
    throw new LocalChannelRootlessError(
      409,
      'CHANNEL_BINDING_PROFILE_DIVERGED',
      'The project-main Channel binding profile has diverged.',
    );
  }
}

function requireCurrentSource(
  bindings: Map<string, LocalChannelBinding>,
  source: LocalChannelBinding,
): LocalChannelBinding {
  const current = bindings.get(source.key);
  if (!current || current.generation !== source.generation) throw generationConflict();
  return current;
}

function bindingFromContext(
  ctx: LocalChannelContext,
  existing: LocalChannelBinding | undefined,
  write: LocalChannelBindingWrite & {
    exactOwnerName?: string;
    projectKey?: string;
    routingMode?: ChannelRoutingMode;
    generation?: number;
  },
  generation: number,
  nowMs: number,
): LocalChannelBinding {
  return {
    key: buildLocalChannelBindingKey(ctx),
    platform: ctx.platform,
    clientName: ctx.clientName,
    chatId: ctx.chatId,
    senderId: ctx.senderId,
    threadId: ctx.threadId ?? '',
    lane: ctx.lane ?? 'interactive',
    agentName: write.agentName,
    sessionId: write.sessionId,
    strategy: write.strategy,
    pinned: write.pinned ?? false,
    routeRuleId: write.routeRuleId ?? null,
    createdAt: existing?.createdAt ?? nowMs,
    updatedAt: nowMs,
    exactOwnerName: write.exactOwnerName ?? write.agentName,
    ...(write.ownerInstanceId ? { ownerInstanceId: write.ownerInstanceId } : {}),
    projectKey: write.projectKey ?? 'default',
    routingMode: write.routingMode ?? 'project-main',
    generation,
  };
}

function generationConflict(): LocalChannelRootlessError {
  return new LocalChannelRootlessError(
    409,
    'CHANNEL_BINDING_GENERATION_CONFLICT',
    'Channel binding generation changed.',
  );
}
