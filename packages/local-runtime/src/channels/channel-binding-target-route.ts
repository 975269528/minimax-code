import type { ChannelRoutingMode } from '@mavis/shared';

import { json, readJsonBody } from '../api/http-helpers.js';
import { serializeChannelBinding } from './channel-binding-codec.js';
import type { LocalChannelBridgeInfra } from './infra.js';
import { LocalImConnectionError } from './im-connection-store.js';
import { LocalChannelRootlessError } from './rootless-route-resolver.js';

export async function routeChannelBindingTarget(input: {
  request: Request;
  method: string;
  tail: string[];
  infra: LocalChannelBridgeInfra;
}): Promise<Response | undefined> {
  if (
    input.method === 'POST' &&
    input.tail.length === 1 &&
    input.tail[0] === 'bindings' &&
    input.infra.rootlessEnabled
  ) {
    return json(
      {
        error: 'Use the generation-CAS binding target route',
        code: 'ROOTLESS_BINDING_CAS_REQUIRED',
      },
      { status: 409 },
    );
  }
  if (
    (input.method !== 'POST' && input.method !== 'PUT') ||
    input.tail[0] !== 'bindings' ||
    !input.tail[1] ||
    input.tail[2] !== 'target' ||
    input.tail.length !== 3
  ) {
    return undefined;
  }
  const body = await readJsonBody(input.request);
  const bindingId = decodePathSegment(input.tail[1]);
  const agentName = readString(body.agentName ?? body.agent);
  const projectKey = readString(body.projectKey);
  const routingMode = readRoutingMode(body.routingMode);
  const expectedGeneration = readNumber(body.expectedGeneration);
  if (!bindingId || !agentName || !projectKey || !routingMode || expectedGeneration === undefined) {
    return json(
      { error: 'Invalid Channel binding target', code: 'VALIDATION_ERROR' },
      { status: 400 },
    );
  }
  const sessionId = readString(body.sessionId);
  const ownerInstanceId = readString(body.ownerInstanceId);
  try {
    const imStore = input.infra.imConnectionStore;
    const snapshot = imStore ? await imStore.getBindingSnapshot(bindingId) : undefined;
    if (snapshot && imStore) {
      if (routingMode !== 'project-main') {
        return json(
          {
            error: 'IM Binding targets support project-main routing only',
            code: 'CHANNEL_IM_ROUTING_MODE_UNSUPPORTED',
          },
          { status: 400 },
        );
      }
      if (!sessionId) {
        return json(
          { error: 'IM Binding target requires a Session', code: 'VALIDATION_ERROR' },
          { status: 400 },
        );
      }
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
        return json(
          { error: 'IM Binding generation is invalid', code: 'VALIDATION_ERROR' },
          { status: 400 },
        );
      }
      const currentSessionId = snapshot.binding.currentSessionId;
      if (!currentSessionId) {
        return json(
          {
            error: 'An unbound IM history cannot be moved to a new Session',
            code: 'CHANNEL_IM_BINDING_CURSOR_EMPTY',
          },
          { status: 409 },
        );
      }
      const moved = await imStore.moveBindingSessionIfCurrent({
        bindingId,
        connectionId: snapshot.connection.connectionId,
        expectedGeneration,
        expectedCurrentSessionId: currentSessionId,
        nextSessionId: sessionId,
        agentName,
        projectKey,
      });
      return json({ binding: serializeImBindingTarget(moved) });
    }
    const binding = await input.infra.routeResolver.updateBindingTarget({
      bindingId,
      agentName,
      projectKey,
      routingMode,
      ...(sessionId ? { sessionId } : {}),
      ...(ownerInstanceId ? { ownerInstanceId } : {}),
      expectedGeneration: Math.max(0, Math.trunc(expectedGeneration)),
    });
    return json({ binding: serializeChannelBinding(binding) });
  } catch (error) {
    if (error instanceof LocalChannelRootlessError || error instanceof LocalImConnectionError) {
      return json({ error: error.message, code: error.code }, { status: error.status });
    }
    throw error;
  }
}

function serializeImBindingTarget(input: {
  connection: {
    agentName: string;
    resolvedProjectKey: string;
  };
  binding: {
    bindingId: string;
    channel: string;
    clientName: string;
    createdAt: number;
    updatedAt: number;
    currentSessionId?: string;
  };
}) {
  return {
    key: input.binding.bindingId,
    platform: input.binding.channel,
    clientName: input.binding.clientName,
    createdAt: input.binding.createdAt,
    updatedAt: input.binding.updatedAt,
    agentName: input.connection.agentName,
    exactOwnerName: input.connection.agentName,
    projectKey: input.connection.resolvedProjectKey,
    routingMode: 'project-main',
    ...(input.binding.currentSessionId ? { sessionId: input.binding.currentSessionId } : {}),
    generation: input.binding.updatedAt,
  };
}

function decodePathSegment(value: string): string | undefined {
  try {
    return readString(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

function readRoutingMode(value: unknown): ChannelRoutingMode | undefined {
  return value === 'project-main' ||
    value === 'per-sender' ||
    value === 'per-chat' ||
    value === 'shared-task'
    ? value
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}
