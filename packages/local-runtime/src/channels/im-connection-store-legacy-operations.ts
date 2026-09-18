import { mutateDurableYaml, readYamlDocument } from './durable-yaml.js';
import type { ChannelPlatform } from './route-api.js';
import {
  findConnection,
  invalidImStorage,
  legacyImMigrationProfile,
  nextBindingUpdatedAt,
  readBindingData,
  readLegacyConversationById,
  writeBindingData,
} from './im-connection-store-data.js';
import type { BindImConnectionInput } from './im-connection-store-binding-operations.js';
import type { PrepareImConnectionInput } from './im-connection-store-connection-operations.js';
import {
  assertImBindingRuntimeState,
  readImBindingState,
  type LocalImConnectionStoreOperations,
} from './im-connection-store-operations.js';
import { migrateLegacyImConnections, type LegacyImRoute } from './im-connection-store-migration.js';
import {
  LocalImConnectionError,
  type LocalImConnection,
  type LocalImPhysicalBinding,
} from './im-connection-types.js';

export interface MigrateImLegacyInput {
  legacyRoutes: readonly LegacyImRoute[];
  isUsableSession: (input: {
    agentName: string;
    projectKey: string;
    sessionId: string;
  }) => Promise<boolean>;
  onSkipped?: (skip: import('./im-connection-store-migration.js').LegacyImMigrationSkip) => void;
}

export interface MigrateImLegacyDelegates {
  findConnection: (
    agentName: string,
    channel: ChannelPlatform,
  ) => Promise<LocalImConnection | undefined>;
  prepareConnection: (input: PrepareImConnectionInput) => Promise<LocalImConnection>;
  bindConnection: (input: BindImConnectionInput) => Promise<LocalImPhysicalBinding>;
}

export async function migrateImLegacyConnections(
  operations: LocalImConnectionStoreOperations,
  input: MigrateImLegacyInput,
  delegates: MigrateImLegacyDelegates,
): Promise<void> {
  await migrateExistingImBindingConversationState(operations);
  await repairTrustedImLegacyRoutes(operations, input.legacyRoutes, input.onSkipped);
  const { bindingData, tombstones } = await readImBindingState(operations);
  const receivedRouteKeys = new Set(
    [...bindingData.physicalBindings.values()].flatMap(
      (binding) => binding.migratedLegacyRouteKeys ?? [],
    ),
  );
  await migrateLegacyImConnections({
    legacyRoutes: input.legacyRoutes,
    preSkippedRouteKeys: receivedRouteKeys,
    isUsableSession: input.isUsableSession,
    shouldSkipRoute: async (route) => {
      const channel = legacyMigrationChannel(route.platform);
      if (tombstones.has(legacyImMigrationProfile(route.agentName, channel))) {
        return 'CHANNEL_IM_LEGACY_ROUTE_SUPERSEDED';
      }
      const connection = findConnection(bindingData.connections, route.agentName, channel);
      const pendingExactRoute = connection?.pendingLegacyRouteKeys?.includes(route.key) === true;
      if (connection && !pendingExactRoute) {
        // A normal Connection (including an explicitly unbound one) is a
        // V2 user choice. A migration-created pending Connection is the one
        // recoverable exception, and only for its exact source row.
        return 'CHANNEL_IM_LEGACY_ROUTE_SUPERSEDED';
      }
      // A write failure before the direct Binding commits leaves only the
      // exact pending receipt. Resume no other historical route.
      return undefined;
    },
    ...(input.onSkipped ? { onSkipped: input.onSkipped } : {}),
    findConnection: delegates.findConnection,
    prepareConnection: delegates.prepareConnection,
    bindConnection: (binding) =>
      delegates.bindConnection({
        ...binding,
        expectedPendingLegacyRouteKeys: binding.migratedLegacyRouteKeys,
      }),
  });
  await revealTrustedImLegacyCredentialSessions(operations, input.legacyRoutes);
}

/**
 * Repair only a receipt-proven automatic `default` import, or a legacy
 * `root` / `main` receipt whose opaque cursor predates the Agent's current
 * Root. The source cursor, Project, receipt, and untouched V2 state must
 * agree before moving the Binding atomically with its Connection.
 */
async function repairTrustedImLegacyRoutes(
  operations: LocalImConnectionStoreOperations,
  routes: readonly LegacyImRoute[],
  onSkipped:
    | ((skip: import('./im-connection-store-migration.js').LegacyImMigrationSkip) => void)
    | undefined,
): Promise<void> {
  for (const route of routes) {
    const trustedRootSessionId = route.trustedRootSessionId?.trim();
    const legacyRootSessionId = isLegacyRootStrategy(route.strategy)
      ? route.legacyRootSessionId?.trim()
      : undefined;
    const legacyRootProjectKey = legacyRootSessionId
      ? route.legacyRootProjectKey?.trim()
      : undefined;
    const repairsLegacyRootCursor = Boolean(
      legacyRootSessionId &&
      legacyRootProjectKey &&
      (legacyRootSessionId !== trustedRootSessionId || legacyRootProjectKey !== route.projectKey),
    );
    const sourceSessionId = repairsLegacyRootCursor ? legacyRootSessionId! : trustedRootSessionId;
    const sourceProjectKey = repairsLegacyRootCursor ? legacyRootProjectKey! : 'default';
    if (
      !trustedRootSessionId ||
      !sourceSessionId ||
      route.emptyCursor ||
      (sourceSessionId === trustedRootSessionId && sourceProjectKey === route.projectKey)
    ) {
      continue;
    }
    const channel = legacyMigrationChannel(route.platform);
    const { bindingData } = await readImBindingState(operations);
    const binding = [...bindingData.physicalBindings.values()].find(
      (candidate) =>
        candidate.channel === channel &&
        candidate.clientName === route.clientName &&
        candidate.migratedLegacyRouteKeys?.includes(route.key),
    );
    if (!binding) continue;
    const connection = bindingData.connections.get(binding.connectionId);
    if (!connection) throw invalidImStorage('physicalBindings', binding.bindingId);
    const state = assertImBindingRuntimeState(binding, connection);
    const targetProjectKey = route.projectKey === 'default' ? null : route.projectKey;
    if (
      connection.agentName === route.agentName &&
      connection.channel === channel &&
      connection.projectKey === targetProjectKey &&
      connection.resolvedProjectKey === route.projectKey &&
      state.resolvedProjectKey === route.projectKey &&
      state.currentSessionId === trustedRootSessionId
    ) {
      // This exact receipt already converged on a previous startup. Do not
      // emit a repair warning merely because its old cursor is now stale.
      continue;
    }
    if (
      connection.agentName !== route.agentName ||
      connection.channel !== channel ||
      connection.projectKey !== (sourceProjectKey === 'default' ? null : sourceProjectKey) ||
      connection.resolvedProjectKey !== sourceProjectKey ||
      state.resolvedProjectKey !== sourceProjectKey ||
      state.currentSessionId !== sourceSessionId ||
      (repairsLegacyRootCursor &&
        (connection.updatedAt !== connection.createdAt || binding.updatedAt !== binding.createdAt))
    ) {
      onSkipped?.({ code: 'CHANNEL_IM_LEGACY_ROUTE_PROJECT_REPAIR_UNPROVEN', keys: [route.key] });
      continue;
    }
    const transportKey = `${binding.channel}\u0000${binding.clientName}`;
    let skippedCode:
      | 'CHANNEL_IM_LEGACY_ROUTE_PROJECT_REPAIR_UNPROVEN'
      | 'CHANNEL_IM_LEGACY_ROUTE_PROJECT_REPAIR_CONFLICT'
      | undefined;
    const repaired = await operations.connectionLane.run(connection.connectionId, () =>
      operations.bindingLane.run(transportKey, () =>
        operations.bindingSessionLane.run(binding.bindingId, () =>
          mutateDurableYaml(operations.bindingsPath, (document) => {
            const data = readBindingData(document, operations.options.nowMs());
            const latestConnection = data.connections.get(connection.connectionId);
            const latestBinding = data.physicalBindings.get(binding.bindingId);
            if (
              !latestConnection ||
              !latestBinding ||
              latestBinding.connectionId !== latestConnection.connectionId ||
              !latestBinding.migratedLegacyRouteKeys?.includes(route.key) ||
              latestConnection.agentName !== route.agentName ||
              latestConnection.channel !== channel ||
              latestConnection.projectKey !==
                (sourceProjectKey === 'default' ? null : sourceProjectKey) ||
              latestConnection.resolvedProjectKey !== sourceProjectKey ||
              latestConnection.updatedAt !== connection.updatedAt ||
              latestBinding.updatedAt !== binding.updatedAt ||
              (repairsLegacyRootCursor &&
                (latestConnection.createdAt !== latestConnection.updatedAt ||
                  latestBinding.createdAt !== latestBinding.updatedAt))
            ) {
              skippedCode = 'CHANNEL_IM_LEGACY_ROUTE_PROJECT_REPAIR_UNPROVEN';
              return { changed: false, value: false };
            }
            const latestState = assertImBindingRuntimeState(latestBinding, latestConnection);
            if (
              latestState.resolvedProjectKey !== sourceProjectKey ||
              latestState.currentSessionId !== sourceSessionId
            ) {
              skippedCode = 'CHANNEL_IM_LEGACY_ROUTE_PROJECT_REPAIR_CONFLICT';
              return { changed: false, value: false };
            }
            data.connections.set(latestConnection.connectionId, {
              ...latestConnection,
              projectKey: route.projectKey === 'default' ? null : route.projectKey,
              resolvedProjectKey: route.projectKey,
              updatedAt: operations.options.nowMs(),
            });
            data.physicalBindings.set(latestBinding.bindingId, {
              ...latestBinding,
              currentSessionId: trustedRootSessionId,
              resolvedProjectKey: route.projectKey,
              updatedAt: nextBindingUpdatedAt(latestBinding, operations.options.nowMs()),
            });
            writeBindingData(document, data);
            return { changed: true, value: true };
          }),
        ),
      ),
    );
    if (!repaired) {
      onSkipped?.({
        code: skippedCode ?? 'CHANNEL_IM_LEGACY_ROUTE_PROJECT_REPAIR_UNPROVEN',
        keys: [route.key],
      });
    }
  }
}

/**
 * A historic Root becomes visible only after the exact credential route was
 * adopted by a physical Binding. `trustedRootSessionId` is produced solely
 * by host-side owner, snapshot, and Project verification; the receipt then
 * proves that this Binding, rather than an arbitrary hidden Root, consumed
 * that source row. A later `/new` may advance this Binding cursor without
 * invalidating the already adopted historical Session.
 */
async function revealTrustedImLegacyCredentialSessions(
  operations: LocalImConnectionStoreOperations,
  routes: readonly LegacyImRoute[],
): Promise<void> {
  const reveal = operations.options.revealMigratedSession;
  if (!reveal) return;
  const revealed = new Set<string>();
  for (const route of routes) {
    const trustedRootSessionId = route.trustedRootSessionId?.trim();
    const sessionId = route.sessionId.trim();
    if (
      !trustedRootSessionId ||
      route.emptyCursor ||
      trustedRootSessionId !== sessionId ||
      revealed.has(sessionId)
    ) {
      continue;
    }
    const channel = legacyMigrationChannel(route.platform);
    const { bindingData } = await readImBindingState(operations);
    const binding = [...bindingData.physicalBindings.values()].find(
      (candidate) =>
        candidate.channel === channel &&
        candidate.clientName === route.clientName &&
        candidate.migratedLegacyRouteKeys?.includes(route.key),
    );
    if (!binding) continue;
    const connection = bindingData.connections.get(binding.connectionId);
    if (!connection) throw invalidImStorage('physicalBindings', binding.bindingId);
    const state = assertImBindingRuntimeState(binding, connection);
    const matchesProject =
      connection.resolvedProjectKey === route.projectKey &&
      (route.projectKey === 'default'
        ? connection.projectKey === null
        : connection.projectKey === route.projectKey);
    if (
      connection.agentName !== route.agentName ||
      connection.channel !== channel ||
      !matchesProject ||
      state.resolvedProjectKey !== route.projectKey
    ) {
      continue;
    }
    await reveal(sessionId);
    revealed.add(sessionId);
  }
}

async function migrateExistingImBindingConversationState(
  operations: LocalImConnectionStoreOperations,
): Promise<void> {
  const initial = readBindingData(
    await readYamlDocument(operations.bindingsPath),
    operations.options.nowMs(),
  );
  if (
    [...initial.physicalBindings.values()].every(
      (binding) =>
        binding.currentSessionId !== undefined &&
        binding.resolvedProjectKey !== undefined &&
        binding.mutationReceipts !== undefined,
    )
  ) {
    return;
  }
  const legacyDocument = await readYamlDocument(operations.routesPath);
  await mutateDurableYaml(operations.bindingsPath, (document) => {
    const data = readBindingData(document, operations.options.nowMs());
    let changed = false;
    for (const binding of data.physicalBindings.values()) {
      if (
        binding.currentSessionId !== undefined &&
        binding.resolvedProjectKey !== undefined &&
        binding.mutationReceipts !== undefined
      ) {
        continue;
      }
      const connection = data.connections.get(binding.connectionId);
      const legacyConversation = binding.imConversationId
        ? readLegacyConversationById(
            legacyDocument,
            binding.imConversationId,
            operations.options.nowMs(),
          )
        : undefined;
      if (!connection || !legacyConversation) {
        throw new LocalImConnectionError(
          409,
          'CHANNEL_IM_BINDING_STATE_UNMIGRATED',
          'The IM Binding cannot transfer its legacy Session state.',
        );
      }
      const matchesProject =
        connection.resolvedProjectKey === legacyConversation.projectKey &&
        (legacyConversation.projectKey === 'default'
          ? connection.projectKey === null
          : connection.projectKey === legacyConversation.projectKey);
      if (
        connection.agentName !== legacyConversation.agentName ||
        !matchesProject ||
        (legacyConversation.connectionId &&
          legacyConversation.connectionId !== connection.connectionId) ||
        (binding.currentSessionId !== undefined &&
          binding.currentSessionId !== legacyConversation.currentSessionId) ||
        (binding.resolvedProjectKey !== undefined &&
          binding.resolvedProjectKey !== legacyConversation.projectKey) ||
        (binding.mutationReceipts !== undefined &&
          !sameMutationReceipts(binding.mutationReceipts, legacyConversation.mutationReceipts))
      ) {
        throw invalidImStorage('physicalBindings', binding.bindingId);
      }
      data.physicalBindings.set(binding.bindingId, {
        ...binding,
        currentSessionId: legacyConversation.currentSessionId,
        resolvedProjectKey: legacyConversation.projectKey,
        mutationReceipts: { ...legacyConversation.mutationReceipts },
        updatedAt: nextBindingUpdatedAt(binding, operations.options.nowMs()),
      });
      changed = true;
    }
    if (changed) writeBindingData(document, data);
    return { changed, value: undefined };
  });
}

function isLegacyRootStrategy(strategy: LegacyImRoute['strategy']): boolean {
  return strategy === 'root' || strategy === 'main';
}

function sameMutationReceipts(
  current: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const currentEntries = Object.entries(current).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return (
    currentEntries.length === expectedEntries.length &&
    currentEntries.every(
      ([requestId, sessionId], index) =>
        requestId === expectedEntries[index]?.[0] && sessionId === expectedEntries[index]?.[1],
    )
  );
}

function legacyMigrationChannel(platform: LegacyImRoute['platform']): ChannelPlatform {
  return platform === 'lark' ? 'feishu' : platform;
}
