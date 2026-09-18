import { channelRoutingModeForStrategy, type ChannelRoutingMode } from '@mavis/shared';

import { inferPlatformFromClientName } from './client-owner-routing.js';
import { buildLocalChannelBindingKey } from './channel-inbound-utils.js';
import type {
  LocalChannelBinding,
  LocalChannelLaneName,
  LocalChannelMessageFilter,
} from './infra.js';
import type { ChannelPlatform, SessionStrategy } from './route-api.js';

export interface ValidBindingRawKeys {
  readonly bindings: Map<string, string>;
  readonly filters: Set<string>;
}

export function serializeChannelBinding(binding: LocalChannelBinding): Record<string, unknown> {
  return { ...binding };
}

export function normalizeChannelBinding(
  key: string,
  value: unknown,
  nowMs: number,
): LocalChannelBinding | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const keyParts = parseBindingKeyParts(key);
  const clientName = readFirstString(raw, ['clientName']) ?? keyParts.clientName;
  const platform =
    normalizePlatform(readFirstString(raw, ['platform'])) ??
    inferPlatformFromClientName(clientName) ??
    'feishu';
  const agentName = readFirstString(raw, ['agentName', 'agentId']);
  const sessionId = readFirstString(raw, ['sessionId']);
  if (!agentName || !sessionId) return undefined;
  const chatId = readFirstString(raw, ['chatId']) ?? keyParts.chatId;
  const senderId = readFirstString(raw, ['senderId']) ?? keyParts.senderId;
  const threadId = readFirstString(raw, ['threadId']) ?? '';
  const lane = (readFirstString(raw, ['lane']) ?? 'interactive') as LocalChannelLaneName;
  const strategy = normalizeStrategy(readFirstString(raw, ['strategy']));
  const ownerInstanceId = readFirstString(raw, ['ownerInstanceId']);
  return {
    key:
      readFirstString(raw, ['key']) ??
      (readFirstString(raw, ['platform'])
        ? key
        : buildLocalChannelBindingKey({
            platform,
            clientName,
            chatId,
            senderId,
            threadId,
            lane,
            chatType: '*',
          })),
    platform,
    clientName,
    chatId,
    senderId,
    threadId,
    lane,
    agentName,
    sessionId,
    strategy,
    pinned: raw.pinned === true,
    routeRuleId: readFirstString(raw, ['routeRuleId']) ?? null,
    createdAt: readNumber(raw.createdAt) ?? nowMs,
    updatedAt: readNumber(raw.updatedAt) ?? nowMs,
    exactOwnerName: readFirstString(raw, ['exactOwnerName']) ?? agentName,
    ...(ownerInstanceId ? { ownerInstanceId } : {}),
    projectKey: normalizeProjectKey(readFirstString(raw, ['projectKey'])),
    routingMode: normalizeRoutingMode(readFirstString(raw, ['routingMode']), strategy),
    generation: Math.max(0, Math.trunc(readNumber(raw.generation) ?? 0)),
  };
}

export function normalizeChannelMessageFilter(
  value: unknown,
): LocalChannelMessageFilter | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  return {
    mode: raw.mode === 'full' ? 'full' : 'result',
    includeToolSummary: raw.includeToolSummary === true,
  };
}

export function defaultChannelMessageFilter(): LocalChannelMessageFilter {
  return { mode: 'result', includeToolSummary: false };
}

export function validChannelBindingRawKeys(
  document: Record<string, unknown>,
  nowMs: number,
): ValidBindingRawKeys {
  const bindings = new Map<string, string>();
  for (const [rawKey, value] of Object.entries(asRecord(document.bindings))) {
    const normalized = normalizeChannelBinding(rawKey, value, nowMs);
    if (normalized) bindings.set(normalized.key, rawKey);
  }
  const filters = new Set<string>();
  for (const [clientId, value] of Object.entries(asRecord(document.messageFilters))) {
    if (normalizeChannelMessageFilter(value)) filters.add(clientId);
  }
  return { bindings, filters };
}

export function mergeChannelBindingsIntoDocument(
  document: Record<string, unknown>,
  bindings: ReadonlyMap<string, LocalChannelBinding>,
  filters: ReadonlyMap<string, LocalChannelMessageFilter>,
  prior: ValidBindingRawKeys,
): void {
  const rawBindings = { ...asRecord(document.bindings) };
  const previousByNormalizedKey = new Map<string, Record<string, unknown>>();
  for (const [normalizedKey, rawKey] of prior.bindings) {
    previousByNormalizedKey.set(normalizedKey, asRecord(rawBindings[rawKey]));
    delete rawBindings[rawKey];
  }
  for (const [key, binding] of [...bindings].sort(([left], [right]) => left.localeCompare(right))) {
    rawBindings[key] = {
      ...previousByNormalizedKey.get(key),
      ...serializeChannelBinding(binding),
    };
  }
  const rawFilters = { ...asRecord(document.messageFilters) };
  const previousFilters = new Map<string, Record<string, unknown>>();
  for (const clientId of prior.filters) {
    previousFilters.set(clientId, asRecord(rawFilters[clientId]));
    delete rawFilters[clientId];
  }
  for (const [clientId, filter] of [...filters].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    rawFilters[clientId] = { ...previousFilters.get(clientId), ...filter };
  }
  // `bindings` remains an opaque legacy per-route map while the IM
  // Connection model stores its own sibling sections in this same document.
  // A compatibility write must never downgrade schema v3 and make a real
  // runtime restart rewrite a document that already contains those sections.
  const existingSchemaVersion = document.schemaVersion;
  document.schemaVersion = Math.max(
    typeof existingSchemaVersion === 'number' && Number.isFinite(existingSchemaVersion)
      ? Math.trunc(existingSchemaVersion)
      : 0,
    2,
  );
  document.bindings = rawBindings;
  document.messageFilters = rawFilters;
}

export function hasMultiProjectChannelBindingProfile(
  bindings: Iterable<LocalChannelBinding>,
  replacement?: Pick<
    LocalChannelBinding,
    'key' | 'exactOwnerName' | 'platform' | 'clientName' | 'projectKey'
  >,
): boolean {
  const projects = new Map<string, string>();
  for (const binding of bindings) {
    if (binding.key === replacement?.key) continue;
    const profile = [binding.exactOwnerName, binding.platform, binding.clientName].join('|');
    const existing = projects.get(profile);
    if (existing !== undefined && existing !== binding.projectKey) return true;
    projects.set(profile, binding.projectKey);
  }
  if (!replacement) return false;
  const profile = [replacement.exactOwnerName, replacement.platform, replacement.clientName].join(
    '|',
  );
  const existing = projects.get(profile);
  return existing !== undefined && existing !== replacement.projectKey;
}

export function channelBindingProjectConflicts(
  bindings: Iterable<LocalChannelBinding>,
  key: string,
  exactOwnerName: string,
  platform: ChannelPlatform,
  clientName: string,
  projectKey: string,
): boolean {
  return hasMultiProjectChannelBindingProfile(bindings, {
    key,
    exactOwnerName,
    platform,
    clientName,
    projectKey,
  });
}

function parseBindingKeyParts(key: string): {
  clientName: string;
  chatId: string;
  senderId: string;
} {
  const parts = key.split(':').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  if (parts.length >= 6 && normalizePlatform(parts[0])) {
    return {
      clientName: parts[1] ?? '',
      chatId: parts[2] ?? '',
      senderId: parts[3] ?? '',
    };
  }
  return {
    clientName: parts[0] ?? '',
    chatId: parts[1] ?? '',
    senderId: parts.slice(2).join(':'),
  };
}

function normalizeStrategy(value: unknown): SessionStrategy {
  return value === 'pin' ||
    value === 'root' ||
    value === 'main' ||
    value === 'per-sender' ||
    value === 'per-chat' ||
    value === 'shared-task'
    ? value
    : 'root';
}

function normalizePlatform(value: unknown): ChannelPlatform | undefined {
  return value === 'feishu' || value === 'telegram' || value === 'wechat' ? value : undefined;
}

function normalizeProjectKey(value: string | undefined): string {
  return value === 'default' || value?.startsWith('workspace:') ? value : 'default';
}

function normalizeRoutingMode(
  value: string | undefined,
  strategy: SessionStrategy,
): ChannelRoutingMode {
  return value === 'project-main' ||
    value === 'per-sender' ||
    value === 'per-chat' ||
    value === 'shared-task'
    ? value
    : channelRoutingModeForStrategy(strategy);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readFirstString(
  raw: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
