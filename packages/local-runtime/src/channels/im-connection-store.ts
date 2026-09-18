import { join } from 'node:path';

import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';

import type { LocalChannelContext, LocalChannelResolvedRoute } from './infra.js';
import type { ChannelPlatform } from './route-api.js';
import {
  advanceImRoute,
  bindImConnection,
  deleteImBinding,
  getImBindingSnapshot,
  moveImBindingSessionIfCurrent,
  peekImRoute,
  resolveImRoute,
  type BindImConnectionInput,
  type MoveImBindingSessionInput,
} from './im-connection-store-binding-operations.js';
import {
  beginImAuthorization,
  cancelImAuthorization,
  deleteImConnection,
  expireImAuthorization,
  findImConnection,
  listImConnectionViews,
  markImAuthorizationError,
  prepareImConnection,
  type BeginImAuthorizationInput,
  type PrepareImConnectionInput,
} from './im-connection-store-connection-operations.js';
import type { LocalImBindingAdvanceTelemetry } from './im-connection-store-conversations.js';
import {
  migrateImLegacyConnections,
  type MigrateImLegacyInput,
} from './im-connection-store-legacy-operations.js';
import {
  findImAuthorizationByPlatformSession,
  getImAuthorization,
  getImConnection,
  type LocalImConnectionStoreOperations,
} from './im-connection-store-operations.js';
import {
  type LocalImAuthorizationState,
  type LocalImConnection,
  type LocalImConnectionDeletionSnapshot,
  type LocalImConnectionStoreOptions,
  type LocalImConnectionView,
  type LocalImPhysicalBinding,
} from './im-connection-types.js';

export {
  LocalImConnectionError,
  type LocalImAuthorizationState,
  type LocalImConnection,
  type LocalImConnectionDeletionSnapshot,
  type LocalImConnectionState,
  type LocalImConnectionStoreOptions,
  type LocalImConnectionView,
  type LocalImConversation,
  type LocalImPhysicalBinding,
} from './im-connection-types.js';

/**
 * Durable IM Connection and physical Binding facts. `channel-bindings.yaml.bindings`
 * remains a legacy per-chat route cache; online cursors live only on
 * `physicalBindings`, while `channel-routes.yaml.imConversations` is retained
 * as historical evidence for one-time transfer.
 */
export class LocalImConnectionStore {
  /** Serializes mutations for one durable Connection. */
  private readonly connectionLane = new KeyedOperationLane<string>();
  /** Serializes binds/unbinds of one external transport account. */
  private readonly bindingLane = new KeyedOperationLane<string>();
  /** Serializes cursor mutation for one physical Binding. */
  private readonly bindingSessionLane = new KeyedOperationLane<string>();
  private readonly authorizations = new Map<string, LocalImAuthorizationState>();

  constructor(private readonly options: LocalImConnectionStoreOptions) {}

  async prepare(input: PrepareImConnectionInput): Promise<LocalImConnection> {
    return prepareImConnection(this.operations, input);
  }

  async getConnection(connectionId: string): Promise<LocalImConnection | undefined> {
    return getImConnection(this.operations, connectionId);
  }

  /** Read one physical Binding with the Connection that owns its live cursor. */
  async getBindingSnapshot(
    bindingId: string,
  ): Promise<{ connection: LocalImConnection; binding: LocalImPhysicalBinding } | undefined> {
    return getImBindingSnapshot(this.operations, bindingId);
  }

  async moveBindingSessionIfCurrent(
    input: MoveImBindingSessionInput,
  ): Promise<{ connection: LocalImConnection; binding: LocalImPhysicalBinding }> {
    return moveImBindingSessionIfCurrent(this.operations, input);
  }

  async findConnection(
    agentName: string,
    channel: ChannelPlatform,
  ): Promise<LocalImConnection | undefined> {
    return findImConnection(this.operations, agentName, channel);
  }

  async beginAuthorization(input: BeginImAuthorizationInput): Promise<void> {
    return beginImAuthorization(this.operations, input);
  }

  getAuthorization(connectionId: string): LocalImAuthorizationState | undefined {
    return getImAuthorization(this.operations, connectionId);
  }

  findAuthorizationByPlatformSession(
    channel: ChannelPlatform,
    platformSessionId: string,
  ): string | undefined {
    return findImAuthorizationByPlatformSession(this.operations, channel, platformSessionId);
  }

  async cancelAuthorization(connectionId: string): Promise<{
    hadAuthorization: boolean;
    binding?: LocalImPhysicalBinding;
  }> {
    return cancelImAuthorization(this.operations, connectionId);
  }

  async expireAuthorization(connectionId: string): Promise<void> {
    return expireImAuthorization(this.operations, connectionId);
  }

  async markAuthorizationError(
    connectionId: string,
    channel: ChannelPlatform,
    errorCode: string,
  ): Promise<void> {
    return markImAuthorizationError(this.operations, connectionId, channel, errorCode);
  }

  async bind(input: BindImConnectionInput): Promise<LocalImPhysicalBinding> {
    return bindImConnection(this.operations, input);
  }

  async deleteBinding(connectionId: string): Promise<boolean> {
    return deleteImBinding(this.operations, connectionId);
  }

  /** Permanently delete one IM Bot while retaining its historical Sessions. */
  async deleteConnection(
    connectionId: string,
    beforeDelete?: (snapshot: LocalImConnectionDeletionSnapshot) => void | Promise<void>,
  ): Promise<boolean> {
    return deleteImConnection(this.operations, connectionId, beforeDelete);
  }

  async listViews(channelFilter?: string): Promise<LocalImConnectionView[]> {
    return listImConnectionViews(this.operations, channelFilter);
  }

  async resolveRoute(ctx: LocalChannelContext): Promise<LocalChannelResolvedRoute | undefined> {
    return resolveImRoute(this.operations, ctx);
  }

  /** Reads a physical IM route without creating a Session for an empty cursor. */
  async peekRoute(ctx: LocalChannelContext): Promise<LocalChannelResolvedRoute | undefined> {
    return peekImRoute(this.operations, ctx);
  }

  async advance(
    ctx: LocalChannelContext,
    requestId: string,
    telemetry?: Pick<LocalImBindingAdvanceTelemetry, 'requestKey'>,
  ): Promise<LocalChannelResolvedRoute | undefined> {
    return advanceImRoute(this.operations, ctx, requestId, telemetry);
  }

  async migrateLegacy(input: MigrateImLegacyInput): Promise<void> {
    return migrateImLegacyConnections(this.operations, input, {
      findConnection: (agentName, channel) => this.findConnection(agentName, channel),
      prepareConnection: (prepared) => this.prepare(prepared),
      bindConnection: (binding) => this.bind(binding),
    });
  }

  private get operations(): LocalImConnectionStoreOperations {
    return {
      bindingsPath: join(this.options.dataDir(), 'channel-bindings.yaml'),
      routesPath: join(this.options.dataDir(), 'channel-routes.yaml'),
      connectionLane: this.connectionLane,
      bindingLane: this.bindingLane,
      bindingSessionLane: this.bindingSessionLane,
      authorizations: this.authorizations,
      options: this.options,
    };
  }
}
