import { mutateDurableYaml } from './durable-yaml.js';
import type { LocalChannelContext, LocalChannelResolvedRoute } from './infra.js';
import {
  findBindingForConnection,
  findBindingForTransportClient,
  invalidImStorage,
  nextBindingUpdatedAt,
  newImEntityId,
  readBindingData,
  requiredString,
  requireBindingSessionState,
  writeBindingData,
} from './im-connection-store-data.js';
import {
  advanceImBinding,
  ensureImBindingSession,
  type LocalImBindingAdvanceTelemetry,
} from './im-connection-store-conversations.js';
import {
  assertImBindingRuntimeState,
  bindingConversationOperations,
  clearImPendingLegacyMigration,
  getImAuthorization,
  getImBindingForConnection,
  getImBindingForTransportClient,
  readImBindingState,
  requireImConnection,
  sameLegacyRouteKeys,
  normalizeLegacyRouteKeys,
  type LocalImConnectionStoreOperations,
} from './im-connection-store-operations.js';
import {
  LocalImConnectionError,
  type LocalImConnection,
  type LocalImPhysicalBinding,
} from './im-connection-types.js';

export interface MoveImBindingSessionInput {
  bindingId: string;
  connectionId: string;
  expectedGeneration: number;
  expectedCurrentSessionId: string;
  nextSessionId: string;
  agentName: string;
  projectKey: string;
}

export interface BindImConnectionInput {
  connectionId: string;
  clientName: string;
  migratedLegacyRouteKeys?: readonly string[];
  /**
   * Internal migration guard. A normal V2 edit may clear a pending legacy
   * import after the planner inspected it, so the bind must re-check the
   * exact source receipt while it owns the Connection lane.
   */
  expectedPendingLegacyRouteKeys?: readonly string[];
  currentSessionId?: string;
  /** Credential-only legacy import defers Session creation until first inbound. */
  emptyCursor?: boolean;
  /** One-version compatibility path; normal platform callbacks need live authorization. */
  migration?: boolean;
}

/** Read one physical Binding with the Connection that owns its live cursor. */
export async function getImBindingSnapshot(
  operations: LocalImConnectionStoreOperations,
  bindingId: string,
): Promise<{ connection: LocalImConnection; binding: LocalImPhysicalBinding } | undefined> {
  const normalizedBindingId = requiredString(bindingId, 'bindingId');
  const { bindingData } = await readImBindingState(operations);
  const binding = bindingData.physicalBindings.get(normalizedBindingId);
  if (!binding) return undefined;
  const connection = bindingData.connections.get(binding.connectionId);
  if (!connection) throw invalidImStorage('physicalBindings', binding.bindingId);
  assertImBindingRuntimeState(binding, connection);
  return { connection, binding };
}

/**
 * Desktop `/new` cursor transition. This accepts only the exact physical
 * Binding observed by the caller and never revives an empty historical
 * cursor. The Binding timestamp is the durable generation CAS.
 */
export async function moveImBindingSessionIfCurrent(
  operations: LocalImConnectionStoreOperations,
  input: MoveImBindingSessionInput,
): Promise<{ connection: LocalImConnection; binding: LocalImPhysicalBinding }> {
  const bindingId = requiredString(input.bindingId, 'bindingId');
  const connectionId = requiredString(input.connectionId, 'connectionId');
  const expectedCurrentSessionId = requiredString(
    input.expectedCurrentSessionId,
    'expectedCurrentSessionId',
  );
  const nextSessionId = requiredString(input.nextSessionId, 'nextSessionId');
  const agentName = requiredString(input.agentName, 'agentName');
  const projectKey = requiredString(input.projectKey, 'projectKey');
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
    throw new LocalImConnectionError(
      400,
      'VALIDATION_ERROR',
      'expectedGeneration must be a non-negative integer.',
    );
  }
  if (!operations.options.validateTargetSession) {
    throw new LocalImConnectionError(
      503,
      'CHANNEL_IM_TARGET_VALIDATOR_UNAVAILABLE',
      'The IM Binding target Session validator is unavailable.',
    );
  }
  return operations.connectionLane.run(connectionId, async () => {
    // Keep the established Connection -> external Binding lane order used by
    // bind, disconnect, and delete. The durable mutation below rechecks all
    // of these facts after it owns the cursor lane.
    const expectedBinding = await getImBindingForConnection(operations, connectionId);
    if (!expectedBinding || expectedBinding.bindingId !== bindingId) {
      throw new LocalImConnectionError(
        404,
        'IM_BINDING_NOT_FOUND',
        'The IM Binding is no longer available.',
      );
    }
    const transportKey = `${expectedBinding.channel}\u0000${expectedBinding.clientName}`;
    return operations.bindingLane.run(transportKey, () =>
      operations.bindingSessionLane.run(bindingId, () =>
        operations.options.validateTargetSession!({
          sessionId: nextSessionId,
          agentName,
          projectKey,
        }).then(() =>
          mutateDurableYaml(operations.bindingsPath, (document) => {
            const data = readBindingData(document, operations.options.nowMs());
            const binding = data.physicalBindings.get(bindingId);
            if (!binding || binding.connectionId !== connectionId) {
              throw new LocalImConnectionError(
                404,
                'IM_BINDING_NOT_FOUND',
                'The IM Binding is no longer available.',
              );
            }
            const connection = data.connections.get(connectionId);
            if (!connection) throw invalidImStorage('physicalBindings', binding.bindingId);
            const state = assertImBindingRuntimeState(binding, connection);
            if (
              connection.agentName !== agentName ||
              connection.resolvedProjectKey !== projectKey
            ) {
              throw new LocalImConnectionError(
                409,
                'CHANNEL_IM_BINDING_TARGET_MISMATCH',
                'The IM Binding does not belong to the requested Agent and Project.',
              );
            }
            if (!state.currentSessionId) {
              throw new LocalImConnectionError(
                409,
                'CHANNEL_IM_BINDING_CURSOR_EMPTY',
                'An unbound IM history cannot be moved to a new Session.',
              );
            }
            if (
              binding.updatedAt !== input.expectedGeneration ||
              state.currentSessionId !== expectedCurrentSessionId
            ) {
              throw new LocalImConnectionError(
                409,
                'CHANNEL_IM_BINDING_CURSOR_CONFLICT',
                'The IM Binding cursor changed before the new Session could be selected.',
              );
            }
            const next: LocalImPhysicalBinding = {
              ...binding,
              currentSessionId: nextSessionId,
              updatedAt: nextBindingUpdatedAt(binding, operations.options.nowMs()),
            };
            data.physicalBindings.set(bindingId, next);
            writeBindingData(document, data);
            return { changed: true, value: { connection, binding: next } };
          }),
        ),
      ),
    );
  });
}

export async function bindImConnection(
  operations: LocalImConnectionStoreOperations,
  input: BindImConnectionInput,
): Promise<LocalImPhysicalBinding> {
  const connection = await requireImConnection(operations, input.connectionId);
  const clientName = requiredString(input.clientName, 'clientName');
  const suppliedSessionId = input.currentSessionId?.trim() ?? '';
  if (input.emptyCursor === true && suppliedSessionId) {
    throw new LocalImConnectionError(
      400,
      'CHANNEL_CONNECTION_MIGRATION_INVALID',
      'An empty IM Binding cursor cannot carry a Session.',
    );
  }
  const expectedPendingLegacyRouteKeys = input.expectedPendingLegacyRouteKeys
    ? normalizeLegacyRouteKeys(input.expectedPendingLegacyRouteKeys)
    : undefined;
  const transportKey = `${connection.channel}\u0000${clientName}`;
  return operations.connectionLane.run(connection.connectionId, () =>
    operations.bindingLane.run(transportKey, async () => {
      const current = await requireImConnection(operations, connection.connectionId);
      if (
        expectedPendingLegacyRouteKeys &&
        !sameLegacyRouteKeys(current.pendingLegacyRouteKeys, expectedPendingLegacyRouteKeys)
      ) {
        throw new LocalImConnectionError(
          409,
          'CHANNEL_CONNECTION_MIGRATION_CONFLICT',
          'The pending legacy migration was superseded by current V2 state.',
        );
      }
      const existing = await getImBindingForConnection(operations, current.connectionId);
      if (existing) {
        if (existing.clientName !== clientName) {
          throw new LocalImConnectionError(
            409,
            'CHANNEL_CONNECTION_ALREADY_BOUND',
            'The Channel Connection already has a different physical Binding.',
          );
        }
        if (
          expectedPendingLegacyRouteKeys &&
          !sameLegacyRouteKeys(existing.migratedLegacyRouteKeys, expectedPendingLegacyRouteKeys)
        ) {
          throw new LocalImConnectionError(
            409,
            'CHANNEL_CONNECTION_MIGRATION_CONFLICT',
            'The pending legacy migration was superseded by current V2 state.',
          );
        }
        return existing;
      }
      const authorization = getImAuthorization(operations, current.connectionId);
      if (
        input.migration !== true &&
        (!authorization || authorization.channel !== current.channel || authorization.errorCode)
      ) {
        throw new LocalImConnectionError(
          409,
          'CHANNEL_CONNECTION_AUTHORIZATION_REQUIRED',
          'The Channel Connection no longer has an active authorization.',
        );
      }
      // Connection lane serializes one Connection; nested transport lane
      // serializes one external account. A new Binding persists an empty
      // cursor first and creates its Session lazily on the first inbound.
      if (await getImBindingForTransportClient(operations, current.channel, clientName)) {
        throw new LocalImConnectionError(
          409,
          'CHANNEL_EXTERNAL_ALREADY_BOUND',
          'The external Channel account is already bound.',
        );
      }
      return mutateDurableYaml(operations.bindingsPath, (document) => {
        const data = readBindingData(document, operations.options.nowMs());
        const latest = data.connections.get(current.connectionId);
        if (!latest) {
          throw new LocalImConnectionError(
            404,
            'CHANNEL_CONNECTION_NOT_FOUND',
            'Channel Connection not found.',
          );
        }
        const duplicate = findBindingForConnection(data.physicalBindings, latest.connectionId);
        if (duplicate) {
          if (
            expectedPendingLegacyRouteKeys &&
            !sameLegacyRouteKeys(duplicate.migratedLegacyRouteKeys, expectedPendingLegacyRouteKeys)
          ) {
            throw new LocalImConnectionError(
              409,
              'CHANNEL_CONNECTION_MIGRATION_CONFLICT',
              'The pending legacy migration was superseded by current V2 state.',
            );
          }
          return { changed: false, value: duplicate };
        }
        if (
          expectedPendingLegacyRouteKeys &&
          !sameLegacyRouteKeys(latest.pendingLegacyRouteKeys, expectedPendingLegacyRouteKeys)
        ) {
          throw new LocalImConnectionError(
            409,
            'CHANNEL_CONNECTION_MIGRATION_CONFLICT',
            'The pending legacy migration was superseded by current V2 state.',
          );
        }
        if (findBindingForTransportClient(data.physicalBindings, latest.channel, clientName)) {
          throw new LocalImConnectionError(
            409,
            'CHANNEL_EXTERNAL_ALREADY_BOUND',
            'The external Channel account is already bound.',
          );
        }
        const now = operations.options.nowMs();
        const binding: LocalImPhysicalBinding = {
          bindingId: newImEntityId('binding'),
          connectionId: latest.connectionId,
          channel: latest.channel,
          clientName,
          currentSessionId: suppliedSessionId,
          resolvedProjectKey: latest.resolvedProjectKey,
          mutationReceipts: {},
          createdAt: now,
          updatedAt: now,
          ...(input.migratedLegacyRouteKeys?.length
            ? { migratedLegacyRouteKeys: [...input.migratedLegacyRouteKeys] }
            : {}),
        };
        if (latest.pendingLegacyRouteKeys?.length) {
          data.connections.set(latest.connectionId, {
            ...latest,
            pendingLegacyRouteKeys: undefined,
            updatedAt: operations.options.nowMs(),
          });
        }
        data.physicalBindings.set(binding.bindingId, binding);
        writeBindingData(document, data);
        return { changed: true, value: binding };
      }).then((binding) => {
        operations.authorizations.delete(current.connectionId);
        return binding;
      });
    }),
  );
}

export async function deleteImBinding(
  operations: LocalImConnectionStoreOperations,
  connectionId: string,
): Promise<boolean> {
  // Uses the same outer Connection then transport/client lane as bind().
  return operations.connectionLane.run(connectionId, async () => {
    const connection = await requireImConnection(operations, connectionId);
    const expected = await getImBindingForConnection(operations, connection.connectionId);
    await operations.options.onDeleteBindingSnapshot?.({
      connectionId,
      ...(expected ? { bindingId: expected.bindingId } : {}),
    });
    if (!expected) {
      // An explicit unbind/cancel of a configured migration Connection is a
      // user takeover. Keep the Connection visible but never let an old
      // route resume its pending import.
      await clearImPendingLegacyMigration(operations, connection.connectionId);
      return false;
    }
    const transportKey = `${expected.channel}\u0000${expected.clientName}`;
    return operations.bindingLane.run(transportKey, () =>
      mutateDurableYaml(operations.bindingsPath, (document) => {
        const data = readBindingData(document, operations.options.nowMs());
        const binding = findBindingForConnection(data.physicalBindings, connectionId);
        if (!binding || binding.bindingId !== expected.bindingId) {
          return { changed: false, value: false };
        }
        data.physicalBindings.delete(binding.bindingId);
        const latest = data.connections.get(connectionId);
        if (latest?.pendingLegacyRouteKeys?.length) {
          data.connections.set(connectionId, {
            ...latest,
            pendingLegacyRouteKeys: undefined,
            updatedAt: operations.options.nowMs(),
          });
        }
        writeBindingData(document, data);
        return { changed: true, value: true };
      }),
    );
  });
}

async function resolveImBindingAndConnection(
  operations: LocalImConnectionStoreOperations,
  ctx: LocalChannelContext,
): Promise<{ binding: LocalImPhysicalBinding; connection: LocalImConnection } | undefined> {
  const { bindingData } = await readImBindingState(operations);
  const binding = [...bindingData.physicalBindings.values()].find(
    (candidate) => candidate.channel === ctx.platform && candidate.clientName === ctx.clientName,
  );
  if (!binding) return undefined;
  const connection = bindingData.connections.get(binding.connectionId);
  if (!connection) throw invalidImStorage('physicalBindings', binding.bindingId);
  assertImBindingRuntimeState(binding, connection);
  return { binding, connection };
}

export async function resolveImRoute(
  operations: LocalImConnectionStoreOperations,
  ctx: LocalChannelContext,
): Promise<LocalChannelResolvedRoute | undefined> {
  const resolved = await resolveImBindingAndConnection(operations, ctx);
  if (!resolved) return undefined;
  const binding = requireBindingSessionState(resolved.binding).currentSessionId
    ? resolved.binding
    : await ensureImBindingSession(
        bindingConversationOperations(operations),
        resolved.connection,
        resolved.binding.bindingId,
      );
  return toPinnedRoute(resolved.connection, binding);
}

/** Reads a physical IM route without creating a Session for an empty cursor. */
export async function peekImRoute(
  operations: LocalImConnectionStoreOperations,
  ctx: LocalChannelContext,
): Promise<LocalChannelResolvedRoute | undefined> {
  const resolved = await resolveImBindingAndConnection(operations, ctx);
  return resolved ? toPinnedRoute(resolved.connection, resolved.binding) : undefined;
}

export async function advanceImRoute(
  operations: LocalImConnectionStoreOperations,
  ctx: LocalChannelContext,
  requestId: string,
  telemetry?: Pick<LocalImBindingAdvanceTelemetry, 'requestKey'>,
): Promise<LocalChannelResolvedRoute | undefined> {
  const resolved = await resolveImBindingAndConnection(operations, ctx);
  if (!resolved) return undefined;
  const binding = await advanceImBinding(
    bindingConversationOperations(operations),
    resolved.connection,
    resolved.binding.bindingId,
    requiredString(requestId, 'requestId'),
    telemetry
      ? {
          requestKey: telemetry.requestKey,
          platform: ctx.platform,
          bindingId: resolved.binding.bindingId,
        }
      : undefined,
  );
  return toPinnedRoute(resolved.connection, binding);
}

function toPinnedRoute(
  connection: LocalImConnection,
  binding: LocalImPhysicalBinding,
): LocalChannelResolvedRoute {
  const state = requireBindingSessionState(binding);
  const route: LocalChannelResolvedRoute = {
    blocked: false,
    agentName: connection.agentName,
    sessionId: state.currentSessionId,
    strategy: 'pin',
    ruleId: null,
    sessionTitle: '',
    imRoute: {
      connectionId: connection.connectionId,
      bindingId: binding.bindingId,
      ...(binding.imConversationId ? { imConversationId: binding.imConversationId } : {}),
    },
  };
  // These identifiers are for in-process validation and observability only;
  // adapter HTTP responses may serialize the resolved route.
  Object.defineProperty(route, 'imRoute', {
    value: route.imRoute,
    enumerable: false,
    configurable: true,
  });
  return route;
}
