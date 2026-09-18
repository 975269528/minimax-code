import { randomUUID } from 'node:crypto';

import type { ChannelPlatform } from './route-api.js';
import {
  asRecord,
  invalidImStorage,
  isChannel,
  normalizeConversation,
  numberValue,
  optionalString,
  readConversationEntityMap,
  serializeConversation,
} from './im-connection-store-data-codec.js';
import type { LocalImBindingData } from './im-connection-store-data-codec.js';
import {
  LocalImConnectionError,
  type LocalImBindingSessionState,
  type LocalImConnection,
  type LocalImConversation,
  type LocalImPhysicalBinding,
} from './im-connection-types.js';

export {
  invalidImStorage,
  isChannel,
  readBindingData,
  writeBindingData,
} from './im-connection-store-data-codec.js';
export type { LocalImBindingData } from './im-connection-store-data-codec.js';

/** A user-deleted V2 Connection must not be recreated by stale legacy rows. */
export interface LocalImMigrationTombstone {
  readonly agentName: string;
  readonly channel: ChannelPlatform;
  readonly createdAt: number;
}

export function legacyImMigrationProfile(agentName: string, channel: ChannelPlatform): string {
  return `${agentName}\u0000${channel}`;
}

export function readLegacyImMigrationTombstones(
  document: Record<string, unknown>,
  nowMs: number,
): Map<string, LocalImMigrationTombstone> {
  const raw = document.legacyImMigrationTombstones;
  if (raw === undefined) return new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidImStorage('legacyImMigrationTombstones');
  }
  const tombstones = new Map<string, LocalImMigrationTombstone>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const record = asRecord(value);
    const agentName = optionalString(record.agentName);
    const channel = optionalString(record.channel);
    if (!agentName || !isChannel(channel) || key !== legacyImMigrationProfile(agentName, channel)) {
      throw invalidImStorage('legacyImMigrationTombstones', key);
    }
    tombstones.set(key, {
      agentName,
      channel,
      createdAt: numberValue(record.createdAt) ?? nowMs,
    });
  }
  return tombstones;
}

export function writeLegacyImMigrationTombstones(
  document: Record<string, unknown>,
  tombstones: ReadonlyMap<string, LocalImMigrationTombstone>,
): void {
  if (tombstones.size === 0) {
    delete document.legacyImMigrationTombstones;
    return;
  }
  document.legacyImMigrationTombstones = Object.fromEntries(
    [...tombstones.values()]
      .sort((left, right) =>
        legacyImMigrationProfile(left.agentName, left.channel).localeCompare(
          legacyImMigrationProfile(right.agentName, right.channel),
        ),
      )
      .map((tombstone) => [
        legacyImMigrationProfile(tombstone.agentName, tombstone.channel),
        {
          agentName: tombstone.agentName,
          channel: tombstone.channel,
          createdAt: tombstone.createdAt,
        },
      ]),
  );
}

export function readConversationData(
  document: Record<string, unknown>,
  nowMs: number,
): Map<string, LocalImConversation> {
  const rawConversations = readConversationEntityMap(document);
  const conversations = new Map<string, LocalImConversation>();
  for (const [key, value] of Object.entries(rawConversations)) {
    const conversation = normalizeConversation(key, value, nowMs);
    if (!conversation) throw invalidImStorage('imConversations', key);
    conversations.set(conversation.imConversationId, conversation);
  }
  const profiles = new Set<string>();
  for (const conversation of conversations.values()) {
    const profile = `${conversation.agentName}\u0000${conversation.projectKey}\u0000${conversation.connectionId}`;
    if (profiles.has(profile))
      throw invalidImStorage('imConversations', conversation.imConversationId);
    profiles.add(profile);
  }
  return conversations;
}

export function writeConversationData(
  document: Record<string, unknown>,
  conversations: ReadonlyMap<string, LocalImConversation>,
): void {
  const rawConversations = readConversationEntityMap(document);
  document.imConversations = Object.fromEntries(
    [...conversations.values()]
      .sort((left, right) => left.imConversationId.localeCompare(right.imConversationId))
      .map((conversation) => [
        conversation.imConversationId,
        {
          ...asRecord(rawConversations[conversation.imConversationId]),
          ...serializeConversation(conversation),
        },
      ]),
  );
}

/**
 * Reads exactly one retained legacy Conversation for the one-time Binding
 * state transfer. Online routes must use `requireBindingSessionState` instead.
 */
export function readLegacyConversationById(
  document: Record<string, unknown>,
  imConversationId: string,
  nowMs: number,
): LocalImConversation | undefined {
  const normalizedId = optionalString(imConversationId);
  if (!normalizedId) return undefined;
  const rawConversations = readConversationEntityMap(document);
  const raw = rawConversations[normalizedId];
  if (raw === undefined) return undefined;
  const conversation = normalizeConversation(normalizedId, raw, nowMs);
  if (!conversation) throw invalidImStorage('imConversations', normalizedId);
  return conversation;
}

export function findConnection(
  connections: ReadonlyMap<string, LocalImConnection>,
  agentName: string,
  channel: ChannelPlatform,
): LocalImConnection | undefined {
  return [...connections.values()].find(
    (connection) => connection.agentName === agentName && connection.channel === channel,
  );
}

export function findBindingForConnection(
  bindings: ReadonlyMap<string, LocalImPhysicalBinding>,
  connectionId: string,
): LocalImPhysicalBinding | undefined {
  return [...bindings.values()].find((binding) => binding.connectionId === connectionId);
}

export function findBindingForTransportClient(
  bindings: ReadonlyMap<string, LocalImPhysicalBinding>,
  channel: ChannelPlatform,
  clientName: string,
): LocalImPhysicalBinding | undefined {
  return [...bindings.values()].find(
    (binding) => binding.channel === channel && binding.clientName === clientName,
  );
}

export function samePhysicalBinding(
  current: LocalImPhysicalBinding | undefined,
  expected: LocalImPhysicalBinding | undefined,
): boolean {
  if (!current || !expected) return current === expected;
  return (
    current.bindingId === expected.bindingId &&
    current.connectionId === expected.connectionId &&
    current.channel === expected.channel &&
    current.clientName === expected.clientName &&
    current.imConversationId === expected.imConversationId
  );
}

/** Fails closed if startup has not transferred legacy Conversation state. */
export function requireBindingSessionState(
  binding: LocalImPhysicalBinding,
): LocalImBindingSessionState {
  if (
    binding.currentSessionId === undefined ||
    !binding.resolvedProjectKey ||
    binding.mutationReceipts === undefined
  ) {
    throw new LocalImConnectionError(
      409,
      'CHANNEL_IM_BINDING_STATE_UNMIGRATED',
      'The IM Binding has not completed its Session state migration.',
    );
  }
  return {
    currentSessionId: binding.currentSessionId,
    resolvedProjectKey: binding.resolvedProjectKey,
    mutationReceipts: binding.mutationReceipts,
  };
}

export function assertMessageFiltersDocument(document: Record<string, unknown>): void {
  readMessageFilters(document);
}

export function deleteMessageFilter(document: Record<string, unknown>, clientName: string): void {
  const filters = readMessageFilters(document);
  if (filters === undefined || !Object.prototype.hasOwnProperty.call(filters, clientName)) return;
  const next = { ...filters };
  delete next[clientName];
  document.messageFilters = next;
}

export function findConversation(
  conversations: ReadonlyMap<string, LocalImConversation>,
  agentName: string,
  projectKey: string,
  connectionId = '',
): LocalImConversation | undefined {
  return [...conversations.values()].find(
    (conversation) =>
      conversation.agentName === agentName &&
      conversation.projectKey === projectKey &&
      conversation.connectionId === connectionId,
  );
}

export function assertBindingConversation(
  binding: LocalImPhysicalBinding,
  connection: LocalImConnection,
  conversation: LocalImConversation,
): void {
  if (
    conversation.agentName !== connection.agentName ||
    conversation.projectKey !== connection.resolvedProjectKey ||
    (conversation.connectionId && conversation.connectionId !== connection.connectionId)
  ) {
    throw invalidImStorage('physicalBindings', binding.bindingId);
  }
}

export function assertBindingConversationReferences(
  bindingData: LocalImBindingData,
  conversations: ReadonlyMap<string, LocalImConversation>,
): void {
  for (const binding of bindingData.physicalBindings.values()) {
    const connection = bindingData.connections.get(binding.connectionId);
    const conversation = binding.imConversationId
      ? conversations.get(binding.imConversationId)
      : undefined;
    if (!connection || !conversation) throw invalidImStorage('physicalBindings', binding.bindingId);
    assertBindingConversation(binding, connection, conversation);
  }
}

export function requiredString(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new LocalImConnectionError(400, 'VALIDATION_ERROR', `${name} is required.`);
  }
  return normalized;
}

export function assertProjectKey(value: string): void {
  if (!value.trim()) {
    throw new LocalImConnectionError(400, 'PROJECT_INVALID', 'Project is invalid.');
  }
}

export function assertChannel(value: unknown): asserts value is ChannelPlatform {
  if (!isChannel(value)) {
    throw new LocalImConnectionError(400, 'CHANNEL_INVALID', 'Channel must be a supported string.');
  }
}

/**
 * Physical Binding `updatedAt` doubles as its durable cursor generation.
 * Wall-clock resolution is not sufficient for adjacent `/new` or `/clear`
 * mutations, so retain a strictly increasing value even within one millisecond
 * or after a clock rollback.
 */
export function nextBindingUpdatedAt(binding: LocalImPhysicalBinding, nowMs: number): number {
  const next = Math.max(binding.updatedAt + 1, nowMs);
  if (!Number.isSafeInteger(next)) {
    throw invalidImStorage('physicalBindings', binding.bindingId);
  }
  return next;
}

function readMessageFilters(
  document: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const filters = document.messageFilters;
  if (filters === undefined) return undefined;
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw invalidImStorage('messageFilters');
  }
  return filters as Record<string, unknown>;
}

export function newImEntityId(kind: string): string {
  return `${kind}_${randomUUID()}`;
}
