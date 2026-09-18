import type { ChannelPlatform } from './route-api.js';
import type { LocalChannelContext } from './infra.js';

export interface AccessControl {
  allowedUsers: string[] | 'ALL';
  allowedGroups: string[] | 'ALL';
  groupMentionPolicy: 'mentionOnly' | 'always' | 'disabled';
  respondToMentionAll: boolean;
}

export type AccessControlPatch = Partial<AccessControl> & {
  allowGroupChat?: boolean;
  allow_group_chat?: boolean;
  ownerOnly?: boolean;
  owner_only?: boolean;
};

export type AccessControlDecision = 'allow' | 'deny';

export type AccessControlDenyReason =
  | 'group_chat_disabled'
  | 'group_not_allowed'
  | 'mention_required'
  | 'user_not_allowed'
  | 'owner_only';

export interface AccessControlDecisionAndReason {
  decision: AccessControlDecision;
  reason?: AccessControlDenyReason;
}

const VALID_PLATFORMS = new Set<ChannelPlatform>(['feishu', 'telegram', 'wechat']);
const P2P_CHAT_TYPES = new Set(['p2p', 'private', 'dm']);

export function defaultAccessControl(): AccessControl {
  return {
    allowedUsers: [],
    allowedGroups: [],
    groupMentionPolicy: 'mentionOnly',
    respondToMentionAll: false,
  };
}

export function evaluatePolicy(
  policy: AccessControl,
  ctx: LocalChannelContext,
  ownerSenderId: string | undefined,
): AccessControlDecisionAndReason {
  const isGroup = !isP2pChat(ctx.chatType);
  if (isGroup && Array.isArray(policy.allowedGroups) && policy.allowedGroups.length === 0) {
    return { decision: 'deny', reason: 'group_chat_disabled' };
  }
  if (isGroup && policy.allowedGroups !== 'ALL' && !policy.allowedGroups.includes(ctx.chatId)) {
    return { decision: 'deny', reason: 'group_not_allowed' };
  }
  if (isGroup) {
    if (policy.groupMentionPolicy === 'disabled')
      return { decision: 'deny', reason: 'mention_required' };
    if (
      policy.groupMentionPolicy === 'mentionOnly' &&
      ctx.hasMention !== true &&
      !(ctx.platform === 'feishu' && policy.respondToMentionAll && ctx.mentionAll === true)
    ) {
      return { decision: 'deny', reason: 'mention_required' };
    }
  }
  const ownerDecision = checkOwnerOnly(ctx, ownerSenderId);
  if (ownerDecision.decision === 'allow') return ownerDecision;
  if (policy.allowedUsers === 'ALL') return { decision: 'allow' };
  if (policy.allowedUsers.includes(ctx.senderId)) return { decision: 'allow' };
  return { decision: 'deny', reason: 'user_not_allowed' };
}

export function isValidAccessControlKey(
  platform: ChannelPlatform | string,
  clientName: string,
): boolean {
  if (typeof platform !== 'string' || !VALID_PLATFORMS.has(platform as ChannelPlatform))
    return false;
  return typeof clientName === 'string' && clientName.trim().length > 0;
}

export function parseAccessControlKey(
  key: string,
): { platform: ChannelPlatform; clientName: string } | undefined {
  const idx = key.indexOf(':');
  if (idx <= 0) return undefined;
  const platform = key.slice(0, idx);
  const clientName = key.slice(idx + 1);
  if (!VALID_PLATFORMS.has(platform as ChannelPlatform) || !clientName) return undefined;
  return { platform: platform as ChannelPlatform, clientName };
}

export function clonePolicy(policy: AccessControl): AccessControl {
  return {
    allowedUsers: policy.allowedUsers === 'ALL' ? 'ALL' : [...policy.allowedUsers],
    allowedGroups: policy.allowedGroups === 'ALL' ? 'ALL' : [...policy.allowedGroups],
    groupMentionPolicy: policy.groupMentionPolicy,
    respondToMentionAll: policy.respondToMentionAll,
  };
}

export function normalizePolicy(raw: Record<string, unknown> | AccessControl): AccessControl {
  const base = defaultAccessControl();
  const record = raw as Record<string, unknown>;
  const legacyAllowGroupChat = readBoolean(record.allowGroupChat ?? record.allow_group_chat);
  const allowedGroups = readAllowlist(
    record.allowedGroups ?? record.allowed_groups,
    base.allowedGroups,
  );
  return {
    allowedUsers: readUserAllowlist(
      record.allowedUsers ?? record.allowed_users,
      readBoolean(record.ownerOnly ?? record.owner_only),
      base.allowedUsers,
    ),
    allowedGroups: legacyAllowGroupChat === false ? [] : allowedGroups,
    groupMentionPolicy:
      readMentionPolicy(record.groupMentionPolicy ?? record.group_mention_policy) ??
      base.groupMentionPolicy,
    respondToMentionAll:
      readBoolean(record.respondToMentionAll ?? record.respond_to_mention_all) ??
      base.respondToMentionAll,
  };
}

export function policySummary(policy: AccessControl): Record<string, unknown> {
  return {
    groupMentionPolicy: policy.groupMentionPolicy,
    respondToMentionAll: policy.respondToMentionAll,
    allowedUsersMode: policy.allowedUsers === 'ALL' ? 'ALL' : `list(${policy.allowedUsers.length})`,
    allowedGroupsMode:
      policy.allowedGroups === 'ALL' ? 'ALL' : `list(${policy.allowedGroups.length})`,
  };
}

function checkOwnerOnly(
  ctx: LocalChannelContext,
  ownerSenderId: string | undefined,
): AccessControlDecisionAndReason {
  if (ownerSenderId === undefined) return { decision: 'deny', reason: 'owner_only' };
  if (ownerSenderId !== ctx.senderId) return { decision: 'deny', reason: 'owner_only' };
  return { decision: 'allow' };
}

function isP2pChat(chatType: string | undefined): boolean {
  if (!chatType) return false;
  return P2P_CHAT_TYPES.has(chatType.trim().toLowerCase());
}

function readAllowlist(value: unknown, fallback: string[] | 'ALL'): string[] | 'ALL' {
  if (typeof value === 'string') return value.trim().toUpperCase() === 'ALL' ? 'ALL' : fallback;
  if (!Array.isArray(value)) return fallback;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.toUpperCase() === 'ALL') return 'ALL';
    if (trimmed) result.push(trimmed);
  }
  return result;
}

function readUserAllowlist(
  value: unknown,
  legacyOwnerOnly: boolean | undefined,
  fallback: string[] | 'ALL',
): string[] | 'ALL' {
  if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase();
    if (normalized === 'ALL') return 'ALL';
    if (normalized === 'OWNER') return [];
    return fallback;
  }
  if (!Array.isArray(value)) {
    if (legacyOwnerOnly === true) return [];
    if (legacyOwnerOnly === false) return 'ALL';
    return fallback;
  }
  return readAllowlist(value, fallback);
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readMentionPolicy(value: unknown): AccessControl['groupMentionPolicy'] | undefined {
  if (typeof value !== 'string') return undefined;
  const lower = value.trim().toLowerCase();
  if (lower === 'disabled') return 'disabled';
  if (lower === 'always') return 'always';
  if (lower === 'mentiononly' || lower === 'mention_only' || lower === 'mention-only')
    return 'mentionOnly';
  return undefined;
}
