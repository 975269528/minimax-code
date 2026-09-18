import type { ChannelPlatform } from './route-api.js';
import {
  LocalImConnectionError,
  type LocalImConnection,
  type LocalImConversation,
  type LocalImPhysicalBinding,
} from './im-connection-types.js';

/** Durable Connection and physical Binding maps decoded from one YAML document. */
export interface LocalImBindingData {
  readonly connections: Map<string, LocalImConnection>;
  readonly physicalBindings: Map<string, LocalImPhysicalBinding>;
}

export function readBindingData(
  document: Record<string, unknown>,
  nowMs: number,
): LocalImBindingData {
  const rawConnections = requireNewEntityMap(document, 'connections');
  const rawBindings = requireNewEntityMap(document, 'physicalBindings');
  const connections = new Map<string, LocalImConnection>();
  for (const [key, value] of Object.entries(rawConnections)) {
    const connection = normalizeConnection(key, value, nowMs);
    if (!connection) throw invalidImStorage('connections', key);
    connections.set(connection.connectionId, connection);
  }
  const physicalBindings = new Map<string, LocalImPhysicalBinding>();
  for (const [key, value] of Object.entries(rawBindings)) {
    const binding = normalizeBinding(key, value, nowMs);
    if (!binding) throw invalidImStorage('physicalBindings', key);
    physicalBindings.set(binding.bindingId, binding);
  }
  assertBindingFacts(connections, physicalBindings);
  return { connections, physicalBindings };
}

export function writeBindingData(
  document: Record<string, unknown>,
  data: LocalImBindingData,
): void {
  document.schemaVersion = Math.max(numberValue(document.schemaVersion) ?? 0, 3);
  const rawConnections = requireNewEntityMap(document, 'connections');
  const rawBindings = requireNewEntityMap(document, 'physicalBindings');
  document.connections = Object.fromEntries(
    [...data.connections.values()]
      .sort((left, right) => left.connectionId.localeCompare(right.connectionId))
      .map((connection) => {
        const previous = { ...asRecord(rawConnections[connection.connectionId]) };
        delete previous.pendingLegacyRouteKeys;
        return [connection.connectionId, { ...previous, ...serializeConnection(connection) }];
      }),
  );
  document.physicalBindings = Object.fromEntries(
    [...data.physicalBindings.values()]
      .sort((left, right) => left.bindingId.localeCompare(right.bindingId))
      .map((binding) => [
        binding.bindingId,
        { ...asRecord(rawBindings[binding.bindingId]), ...serializeBinding(binding) },
      ]),
  );
}

export function isChannel(value: unknown): value is ChannelPlatform {
  return value === 'feishu' || value === 'telegram' || value === 'wechat';
}

export function invalidImStorage(section: string, key?: string): LocalImConnectionError {
  return new LocalImConnectionError(
    409,
    'CHANNEL_IM_STORAGE_INVALID',
    `Channel IM storage contains an invalid ${section}${key ? ` entry: ${key}` : ' section'}.`,
  );
}

export function readConversationEntityMap(
  document: Record<string, unknown>,
): Record<string, unknown> {
  return requireNewEntityMap(document, 'imConversations');
}

export function normalizeConversation(
  key: string,
  raw: unknown,
  nowMs: number,
): LocalImConversation | undefined {
  const value = asRecord(raw);
  const imConversationId = entityIdForKey(value.imConversationId, key);
  const agentName = optionalString(value.agentName);
  const projectKey = optionalString(value.projectKey);
  // Pre-scope YAML rows were written by the one-version legacy migration and
  // intentionally remain one shared empty scope.
  const connectionId = value.connectionId === undefined ? '' : emptyString(value.connectionId);
  const currentSessionId = emptyString(value.currentSessionId);
  if (
    !imConversationId ||
    !agentName ||
    !projectKey ||
    connectionId === undefined ||
    currentSessionId === undefined ||
    !validOptionalTimestamp(value.createdAt) ||
    !validOptionalTimestamp(value.updatedAt) ||
    !validMutationReceipts(value.mutationReceipts)
  )
    return undefined;
  const receipts: Record<string, string> = {};
  for (const [requestId, sessionId] of Object.entries(asRecord(value.mutationReceipts))) {
    if (typeof sessionId !== 'string') return undefined;
    receipts[requestId] = sessionId;
  }
  return {
    imConversationId,
    agentName,
    projectKey,
    connectionId,
    currentSessionId,
    createdAt: numberValue(value.createdAt) ?? nowMs,
    updatedAt: numberValue(value.updatedAt) ?? nowMs,
    mutationReceipts: receipts,
  };
}

export function serializeConversation(conversation: LocalImConversation): Record<string, unknown> {
  return {
    imConversationId: conversation.imConversationId,
    agentName: conversation.agentName,
    projectKey: conversation.projectKey,
    connectionId: conversation.connectionId,
    currentSessionId: conversation.currentSessionId,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    mutationReceipts: conversation.mutationReceipts,
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeConnection(
  key: string,
  raw: unknown,
  nowMs: number,
): LocalImConnection | undefined {
  const value = asRecord(raw);
  const connectionId = entityIdForKey(value.connectionId, key);
  const agentName = optionalString(value.agentName);
  const channel = optionalString(value.channel);
  const resolvedProjectKey = optionalString(value.resolvedProjectKey);
  if (
    !connectionId ||
    !agentName ||
    !isChannel(channel) ||
    !resolvedProjectKey ||
    !validOptionalStringOrNull(value.projectKey) ||
    !validLegacyRouteKeys(value.pendingLegacyRouteKeys) ||
    !validOptionalTimestamp(value.createdAt) ||
    !validOptionalTimestamp(value.updatedAt)
  )
    return undefined;
  return {
    connectionId,
    agentName,
    channel,
    projectKey: optionalString(value.projectKey) ?? null,
    resolvedProjectKey,
    ...(Array.isArray(value.pendingLegacyRouteKeys) && value.pendingLegacyRouteKeys.length > 0
      ? { pendingLegacyRouteKeys: value.pendingLegacyRouteKeys }
      : {}),
    createdAt: numberValue(value.createdAt) ?? nowMs,
    updatedAt: numberValue(value.updatedAt) ?? nowMs,
  };
}

function normalizeBinding(
  key: string,
  raw: unknown,
  nowMs: number,
): LocalImPhysicalBinding | undefined {
  const value = asRecord(raw);
  const bindingId = entityIdForKey(value.bindingId, key);
  const connectionId = optionalString(value.connectionId);
  const channel = optionalString(value.channel);
  const clientName = optionalString(value.clientName);
  const imConversationId = optionalString(value.imConversationId);
  const currentSessionId =
    value.currentSessionId === undefined ? undefined : emptyString(value.currentSessionId);
  const resolvedProjectKey =
    value.resolvedProjectKey === undefined ? undefined : optionalString(value.resolvedProjectKey);
  if (
    !bindingId ||
    !connectionId ||
    !isChannel(channel) ||
    !clientName ||
    (value.currentSessionId !== undefined && currentSessionId === undefined) ||
    (value.resolvedProjectKey !== undefined && !resolvedProjectKey) ||
    !validOptionalTimestamp(value.createdAt) ||
    !validOptionalTimestamp(value.updatedAt) ||
    !validLegacyRouteKeys(value.migratedLegacyRouteKeys) ||
    !validMutationReceipts(value.mutationReceipts)
  )
    return undefined;
  const migratedLegacyRouteKeys = Array.isArray(value.migratedLegacyRouteKeys)
    ? value.migratedLegacyRouteKeys
    : undefined;
  const mutationReceipts =
    value.mutationReceipts === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(asRecord(value.mutationReceipts)).map(([requestId, sessionId]) => [
            requestId,
            String(sessionId),
          ]),
        );
  return {
    bindingId,
    connectionId,
    channel,
    clientName,
    ...(imConversationId ? { imConversationId } : {}),
    ...(currentSessionId !== undefined ? { currentSessionId } : {}),
    ...(resolvedProjectKey ? { resolvedProjectKey } : {}),
    ...(mutationReceipts !== undefined ? { mutationReceipts } : {}),
    createdAt: numberValue(value.createdAt) ?? nowMs,
    updatedAt: numberValue(value.updatedAt) ?? nowMs,
    ...(migratedLegacyRouteKeys && migratedLegacyRouteKeys.length > 0
      ? { migratedLegacyRouteKeys }
      : {}),
  };
}

function serializeConnection(connection: LocalImConnection): Record<string, unknown> {
  return {
    connectionId: connection.connectionId,
    agentName: connection.agentName,
    channel: connection.channel,
    projectKey: connection.projectKey,
    resolvedProjectKey: connection.resolvedProjectKey,
    ...(connection.pendingLegacyRouteKeys?.length
      ? { pendingLegacyRouteKeys: [...connection.pendingLegacyRouteKeys] }
      : {}),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

function serializeBinding(binding: LocalImPhysicalBinding): Record<string, unknown> {
  return {
    bindingId: binding.bindingId,
    connectionId: binding.connectionId,
    channel: binding.channel,
    clientName: binding.clientName,
    ...(binding.imConversationId ? { imConversationId: binding.imConversationId } : {}),
    ...(binding.currentSessionId !== undefined
      ? { currentSessionId: binding.currentSessionId }
      : {}),
    ...(binding.resolvedProjectKey ? { resolvedProjectKey: binding.resolvedProjectKey } : {}),
    ...(binding.mutationReceipts !== undefined
      ? { mutationReceipts: binding.mutationReceipts }
      : {}),
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
    ...(binding.migratedLegacyRouteKeys
      ? { migratedLegacyRouteKeys: [...binding.migratedLegacyRouteKeys] }
      : {}),
  };
}

/** YAML has no database constraints, so validate the durable uniqueness facts on every read. */
function assertBindingFacts(
  connections: ReadonlyMap<string, LocalImConnection>,
  physicalBindings: ReadonlyMap<string, LocalImPhysicalBinding>,
): void {
  const connectionProfiles = new Set<string>();
  for (const connection of connections.values()) {
    const profile = `${connection.agentName}\u0000${connection.channel}`;
    if (connectionProfiles.has(profile))
      throw invalidImStorage('connections', connection.connectionId);
    connectionProfiles.add(profile);
  }
  const connectionBindings = new Set<string>();
  const transportClients = new Set<string>();
  for (const binding of physicalBindings.values()) {
    const connection = connections.get(binding.connectionId);
    if (!connection || connection.channel !== binding.channel) {
      throw invalidImStorage('physicalBindings', binding.bindingId);
    }
    if (connectionBindings.has(binding.connectionId)) {
      throw invalidImStorage('physicalBindings', binding.bindingId);
    }
    connectionBindings.add(binding.connectionId);
    const transportClient = `${binding.channel}\u0000${binding.clientName}`;
    if (transportClients.has(transportClient)) {
      throw invalidImStorage('physicalBindings', binding.bindingId);
    }
    transportClients.add(transportClient);
  }
}

function emptyString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

/** New-map key and explicit entity id must be stable under a read/write cycle. */
function entityIdForKey(value: unknown, key: string): string | undefined {
  const normalizedKey = optionalString(key);
  if (!normalizedKey) return undefined;
  if (value === undefined) return normalizedKey;
  const explicit = optionalString(value);
  return explicit && explicit === normalizedKey ? explicit : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** New model sections fail closed while legacy route rows remain opaque. */
function requireNewEntityMap(
  document: Record<string, unknown>,
  section: 'connections' | 'physicalBindings' | 'imConversations',
): Record<string, unknown> {
  const raw = document[section];
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidImStorage(section);
  return raw as Record<string, unknown>;
}

function validOptionalStringOrNull(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === 'string' && Boolean(value.trim()))
  );
}

function validOptionalTimestamp(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function validLegacyRouteKeys(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((entry) => typeof entry === 'string' && Boolean(entry.trim())))
  );
}

function validMutationReceipts(value: unknown): boolean {
  return (
    value === undefined ||
    (Boolean(value) &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.entries(value as Record<string, unknown>).every(
        ([requestId, sessionId]) =>
          Boolean(requestId) && typeof sessionId === 'string' && Boolean(sessionId.trim()),
      ))
  );
}
