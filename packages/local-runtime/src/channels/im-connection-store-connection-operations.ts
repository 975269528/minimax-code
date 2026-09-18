import { mutateDurableYaml } from './durable-yaml.js';
import type { ChannelPlatform } from './route-api.js';
import {
  assertChannel,
  assertProjectKey,
  deleteMessageFilter,
  findBindingForConnection,
  findConnection,
  legacyImMigrationProfile,
  newImEntityId,
  readBindingData,
  readLegacyImMigrationTombstones,
  requiredString,
  samePhysicalBinding,
  writeBindingData,
  writeLegacyImMigrationTombstones,
} from './im-connection-store-data.js';
import {
  assertImBindingRuntimeState,
  clearImPendingLegacyMigration,
  getImAuthorization,
  getImBindingForConnection,
  getImDeletionSnapshot,
  requireImConnection,
  readImBindingState,
  sameLegacyRouteKeys,
  normalizeLegacyRouteKeys,
  type LocalImConnectionStoreOperations,
} from './im-connection-store-operations.js';
import {
  LocalImConnectionError,
  type LocalImConnection,
  type LocalImConnectionDeletionSnapshot,
  type LocalImConnectionState,
  type LocalImConnectionView,
  type LocalImPhysicalBinding,
} from './im-connection-types.js';

export interface PrepareImConnectionInput {
  connectionId?: string;
  agentName: string;
  channel: ChannelPlatform;
  projectKey: string | null;
  resolvedProjectKey: string;
  /** Internal migration receipt retained only until the first bind commits. */
  pendingLegacyRouteKeys?: readonly string[];
}

export interface BeginImAuthorizationInput {
  connectionId: string;
  channel: ChannelPlatform;
  platformSessionId?: string;
  expiresAt?: number;
}

export async function prepareImConnection(
  operations: LocalImConnectionStoreOperations,
  input: PrepareImConnectionInput,
): Promise<LocalImConnection> {
  assertChannel(input.channel);
  assertProjectKey(input.resolvedProjectKey);
  operations.options.resolveProjectWorkspace(input.resolvedProjectKey);
  const agentName = requiredString(input.agentName, 'agentName');
  const pendingLegacyRouteKeys = normalizeLegacyRouteKeys(input.pendingLegacyRouteKeys);
  const connectionKey = input.connectionId?.trim() || `${agentName}\u0000${input.channel}`;
  return operations.connectionLane.run(connectionKey, () =>
    mutateDurableYaml(operations.bindingsPath, (document) => {
      const data = readBindingData(document, operations.options.nowMs());
      const tombstones = readLegacyImMigrationTombstones(document, operations.options.nowMs());
      const existing = input.connectionId?.trim()
        ? data.connections.get(input.connectionId.trim())
        : findConnection(data.connections, agentName, input.channel);
      if (input.connectionId?.trim() && !existing) {
        throw new LocalImConnectionError(
          404,
          'CHANNEL_CONNECTION_NOT_FOUND',
          'Channel Connection not found.',
        );
      }
      if (!existing) {
        const now = operations.options.nowMs();
        const created: LocalImConnection = {
          connectionId: newImEntityId('connection'),
          agentName,
          channel: input.channel,
          projectKey: input.projectKey,
          resolvedProjectKey: input.resolvedProjectKey,
          ...(pendingLegacyRouteKeys.length > 0 ? { pendingLegacyRouteKeys } : {}),
          createdAt: now,
          updatedAt: now,
        };
        data.connections.set(created.connectionId, created);
        if (pendingLegacyRouteKeys.length === 0) {
          tombstones.delete(legacyImMigrationProfile(agentName, input.channel));
        }
        writeBindingData(document, data);
        writeLegacyImMigrationTombstones(document, tombstones);
        return { changed: true, value: created };
      }
      if (
        pendingLegacyRouteKeys.length > 0 &&
        !sameLegacyRouteKeys(existing.pendingLegacyRouteKeys, pendingLegacyRouteKeys)
      ) {
        throw new LocalImConnectionError(
          409,
          'CHANNEL_CONNECTION_MIGRATION_CONFLICT',
          'The pending legacy migration was superseded by current V2 state.',
        );
      }
      const duplicate = findConnection(data.connections, agentName, input.channel);
      if (duplicate && duplicate.connectionId !== existing.connectionId) {
        throw new LocalImConnectionError(
          409,
          'CHANNEL_CONNECTION_DUPLICATE',
          'A Channel Connection already exists for this Agent and Channel.',
        );
      }
      const bound = findBindingForConnection(data.physicalBindings, existing.connectionId);
      const authorization = getImAuthorization(operations, existing.connectionId);
      const changedTarget =
        existing.agentName !== agentName ||
        existing.channel !== input.channel ||
        existing.projectKey !== input.projectKey ||
        existing.resolvedProjectKey !== input.resolvedProjectKey;
      const changedMigrationState = !sameLegacyRouteKeys(
        existing.pendingLegacyRouteKeys,
        pendingLegacyRouteKeys,
      );
      if (changedTarget && (bound || (authorization && !authorization.errorCode))) {
        throw new LocalImConnectionError(
          409,
          bound ? 'CHANNEL_CONNECTION_BOUND_IMMUTABLE' : 'CHANNEL_CONNECTION_AUTHORIZING',
          bound
            ? 'A bound Channel Connection cannot change its Agent or Project.'
            : 'Cancel the active Channel authorization before changing its Project.',
        );
      }
      if (!changedTarget && !changedMigrationState) return { changed: false, value: existing };
      const updated: LocalImConnection = {
        ...existing,
        agentName,
        channel: input.channel,
        projectKey: input.projectKey,
        resolvedProjectKey: input.resolvedProjectKey,
        ...(pendingLegacyRouteKeys.length > 0
          ? { pendingLegacyRouteKeys }
          : { pendingLegacyRouteKeys: undefined }),
        updatedAt: operations.options.nowMs(),
      };
      data.connections.set(updated.connectionId, updated);
      if (pendingLegacyRouteKeys.length === 0) {
        tombstones.delete(legacyImMigrationProfile(agentName, input.channel));
      }
      writeBindingData(document, data);
      writeLegacyImMigrationTombstones(document, tombstones);
      return { changed: true, value: updated };
    }),
  );
}

export async function findImConnection(
  operations: LocalImConnectionStoreOperations,
  agentName: string,
  channel: ChannelPlatform,
): Promise<LocalImConnection | undefined> {
  const { bindingData } = await readImBindingState(operations);
  return findConnection(bindingData.connections, agentName, channel);
}

export async function beginImAuthorization(
  operations: LocalImConnectionStoreOperations,
  input: BeginImAuthorizationInput,
): Promise<void> {
  return operations.connectionLane.run(input.connectionId, async () => {
    const connection = await requireImConnection(operations, input.connectionId);
    if (connection.channel !== input.channel) {
      throw new LocalImConnectionError(
        409,
        'CHANNEL_CONNECTION_CHANNEL_MISMATCH',
        'Channel mismatch.',
      );
    }
    if (await getImBindingForConnection(operations, connection.connectionId)) {
      throw new LocalImConnectionError(
        409,
        'CHANNEL_CONNECTION_ALREADY_BOUND',
        'The Channel Connection is already bound.',
      );
    }
    await clearImPendingLegacyMigration(operations, connection.connectionId);
    operations.authorizations.set(connection.connectionId, {
      channel: input.channel,
      ...(input.platformSessionId ? { platformSessionId: input.platformSessionId } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    });
  });
}

export async function cancelImAuthorization(
  operations: LocalImConnectionStoreOperations,
  connectionId: string,
): Promise<{ hadAuthorization: boolean; binding?: LocalImPhysicalBinding }> {
  return operations.connectionLane.run(connectionId, async () => {
    await requireImConnection(operations, connectionId);
    await clearImPendingLegacyMigration(operations, connectionId);
    const hadAuthorization = getImAuthorization(operations, connectionId) !== undefined;
    operations.authorizations.delete(connectionId);
    const binding = await getImBindingForConnection(operations, connectionId);
    return { hadAuthorization, ...(binding ? { binding } : {}) };
  });
}

export async function expireImAuthorization(
  operations: LocalImConnectionStoreOperations,
  connectionId: string,
): Promise<void> {
  await operations.connectionLane.run(connectionId, async () => {
    await requireImConnection(operations, connectionId);
    operations.authorizations.delete(connectionId);
  });
}

export async function markImAuthorizationError(
  operations: LocalImConnectionStoreOperations,
  connectionId: string,
  channel: ChannelPlatform,
  errorCode: string,
): Promise<void> {
  await operations.connectionLane.run(connectionId, async () => {
    const connection = await requireImConnection(operations, connectionId);
    if (connection.channel !== channel) {
      throw new LocalImConnectionError(
        409,
        'CHANNEL_CONNECTION_CHANNEL_MISMATCH',
        'Channel mismatch.',
      );
    }
    operations.authorizations.set(connectionId, { channel, errorCode });
  });
}

/** Permanently delete one IM Bot while retaining its historical Sessions. */
export async function deleteImConnection(
  operations: LocalImConnectionStoreOperations,
  connectionId: string,
  beforeDelete?: (snapshot: LocalImConnectionDeletionSnapshot) => void | Promise<void>,
): Promise<boolean> {
  return operations.connectionLane.run(connectionId, async () => {
    const snapshot = await getImDeletionSnapshot(operations, connectionId);
    // Public DELETE is idempotent and must not repeat external cleanup.
    if (!snapshot) return true;
    const deleteUnderTransportLane = async (): Promise<boolean> => {
      // External credential cleanup is fail-closed and precedes local facts.
      await beforeDelete?.(snapshot);
      const deleted = await mutateDurableYaml(operations.bindingsPath, (document) => {
        const data = readBindingData(document, operations.options.nowMs());
        const currentConnection = data.connections.get(connectionId);
        if (!currentConnection) return { changed: false, value: true };
        const currentBinding = findBindingForConnection(data.physicalBindings, connectionId);
        if (!samePhysicalBinding(currentBinding, snapshot.binding)) {
          throw new LocalImConnectionError(
            409,
            'CHANNEL_CONNECTION_DELETE_RACE',
            'The Channel Connection changed while it was being deleted.',
          );
        }
        if (currentBinding) data.physicalBindings.delete(currentBinding.bindingId);
        data.connections.delete(connectionId);
        const tombstones = readLegacyImMigrationTombstones(document, operations.options.nowMs());
        tombstones.set(
          legacyImMigrationProfile(snapshot.connection.agentName, snapshot.connection.channel),
          {
            agentName: snapshot.connection.agentName,
            channel: snapshot.connection.channel,
            createdAt: operations.options.nowMs(),
          },
        );
        if (snapshot.binding) deleteMessageFilter(document, snapshot.binding.clientName);
        writeBindingData(document, data);
        writeLegacyImMigrationTombstones(document, tombstones);
        return { changed: true, value: true };
      });
      operations.authorizations.delete(connectionId);
      return deleted;
    };
    if (!snapshot.binding) return deleteUnderTransportLane();
    const transportKey = `${snapshot.binding.channel}\u0000${snapshot.binding.clientName}`;
    return operations.bindingLane.run(transportKey, deleteUnderTransportLane);
  });
}

export async function listImConnectionViews(
  operations: LocalImConnectionStoreOperations,
  channelFilter?: string,
): Promise<LocalImConnectionView[]> {
  const { bindingData } = await readImBindingState(operations);
  return [...bindingData.connections.values()]
    .filter((connection) => !channelFilter || connection.channel === channelFilter)
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.connectionId.localeCompare(right.connectionId),
    )
    .map((connection) => {
      const binding = findBindingForConnection(
        bindingData.physicalBindings,
        connection.connectionId,
      );
      if (binding) assertImBindingRuntimeState(binding, connection);
      const authorization = getImAuthorization(operations, connection.connectionId);
      const state: LocalImConnectionState = binding
        ? 'bound'
        : authorization?.errorCode
          ? 'error'
          : authorization
            ? 'authorizing'
            : 'configured';
      return {
        connection,
        state,
        ...(binding ? { binding } : {}),
        ...(authorization?.errorCode ? { errorCode: authorization.errorCode } : {}),
      };
    });
}
