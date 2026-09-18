import { feishuClientId, type LocalFeishuChannelStore } from './feishu.js';
import { telegramClientId, type LocalTelegramChannelStore } from './telegram.js';
import { wechatClientId, type LocalWeChatChannelStore } from './wechat.js';
import type { ChannelPlatform } from './route-api.js';

/**
 * One family record as the reconciler sees it — deliberately free of any
 * credential material beyond the stable platform identity used for the
 * automatic-merge decision (plan §5.3).
 */
export interface PrimaryFamilyRecordView {
  readonly agentName: string;
  readonly clientId: string;
  readonly enabled: boolean;
  readonly updatedAt: number;
  /**
   * Stable platform identity:
   *   - Feishu   → `appId`
   *   - Telegram → `botToken`, compared for exact equality only
   *   - WeChat   → `ilinkBotId`, falling back to exact `botToken`
   *
   * `undefined` means the record carries no usable identity; two records can
   * then never be proven to be the same bot, so the reconciler refuses to
   * merge them. A display name is NOT an identity.
   */
  readonly identity?: string;
}

/**
 * Per-platform seam the reconciler drives. Three concrete instances are built
 * by {@link createPrimaryFamilyPlatformPorts} — this is a shape shared by three
 * platforms, not an interface with one implementation.
 */
export interface PrimaryFamilyPlatformPort {
  readonly platform: ChannelPlatform;
  clientId(agentName: string): string;
  list(): Promise<PrimaryFamilyRecordView[]>;
  /** Copy one record's whole credential group onto `toAgentName`, staged disabled. */
  cloneCredential(input: {
    fromAgentName: string;
    toAgentName: string;
    enabled: boolean;
  }): Promise<PrimaryFamilyRecordView | undefined>;
  setEnabled(agentName: string, enabled: boolean): Promise<PrimaryFamilyRecordView | undefined>;
  /** Internal raw delete; must not invoke the family hook while its lock is held. */
  deleteCredential(agentName: string): Promise<boolean>;
}

export interface PrimaryFamilyPlatformStores {
  readonly feishu: LocalFeishuChannelStore;
  readonly telegram: LocalTelegramChannelStore;
  readonly wechat: LocalWeChatChannelStore;
}

/** Build the three platform ports over the host's live stores. */
export function createPrimaryFamilyPlatformPorts(
  stores: PrimaryFamilyPlatformStores,
): Record<ChannelPlatform, PrimaryFamilyPlatformPort> {
  return {
    feishu: {
      platform: 'feishu',
      clientId: feishuClientId,
      list: async () =>
        // Legacy mock/unknown records stay in the store so the user can
        // exact-unbind them, but must never be considered a family winner.
        // Otherwise the reconciler can re-enable a disabled compatibility row
        // without a transport capable of starting it.
        (await stores.feishu.list())
          .filter((record) => record.mode === 'webhook' || record.mode === 'websocket')
          .map((record) => ({
            agentName: record.agentName,
            clientId: record.clientId,
            enabled: record.enabled,
            updatedAt: record.updatedAt,
            ...(record.appId?.trim() ? { identity: record.appId.trim() } : {}),
          })),
      cloneCredential: async (input) =>
        toView(await stores.feishu.cloneBindingForAgent(input), (record) => record.appId),
      setEnabled: async (agentName, enabled) =>
        toView(await stores.feishu.setEnabled(agentName, enabled), (record) => record.appId),
      deleteCredential: (agentName) =>
        stores.feishu.unbind(agentName, { suppressFamilyMutation: true }),
    },
    telegram: {
      platform: 'telegram',
      clientId: telegramClientId,
      list: async () =>
        (await stores.telegram.list())
          .filter((record) => record.mode === 'sdk')
          .map((record) => ({
            agentName: record.agentName,
            clientId: record.clientId,
            enabled: record.enabled,
            updatedAt: record.updatedAt,
            ...(record.botToken?.trim() ? { identity: record.botToken.trim() } : {}),
          })),
      cloneCredential: async (input) =>
        toView(await stores.telegram.cloneBindingForAgent(input), (record) => record.botToken),
      setEnabled: async (agentName, enabled) =>
        toView(await stores.telegram.setEnabled(agentName, enabled), (record) => record.botToken),
      deleteCredential: (agentName) =>
        stores.telegram.unbind(agentName, { suppressFamilyMutation: true }),
    },
    wechat: {
      platform: 'wechat',
      clientId: wechatClientId,
      list: async () =>
        (await stores.wechat.list())
          .filter((record) => record.mode === 'polling' && !record.botToken.startsWith('pending:'))
          .map((record) => ({
            agentName: record.agentName,
            clientId: record.clientId,
            enabled: record.enabled,
            updatedAt: record.updatedAt,
            ...(wechatIdentity(record) ? { identity: wechatIdentity(record) } : {}),
          })),
      cloneCredential: async (input) =>
        toView(await stores.wechat.cloneBindingForAgent(input), wechatIdentity),
      setEnabled: async (agentName, enabled) =>
        toView(await stores.wechat.setEnabled(agentName, enabled), wechatIdentity),
      deleteCredential: (agentName) =>
        stores.wechat.unbind(agentName, { suppressFamilyMutation: true }),
    },
  };
}

function wechatIdentity(record: { ilinkBotId?: string; botToken?: string }): string | undefined {
  return record.ilinkBotId?.trim() || record.botToken?.trim() || undefined;
}

function toView<
  TRecord extends { agentName: string; clientId: string; enabled: boolean; updatedAt: number },
>(
  record: TRecord | undefined,
  identityOf: (record: TRecord) => string | undefined,
): PrimaryFamilyRecordView | undefined {
  if (!record) return undefined;
  const identity = identityOf(record)?.trim();
  return {
    agentName: record.agentName,
    clientId: record.clientId,
    enabled: record.enabled,
    updatedAt: record.updatedAt,
    ...(identity ? { identity } : {}),
  };
}

/**
 * Same stable platform identity on both sides (plan §5.3). A missing identity
 * on either side is NOT a match: without it the two records cannot be proven to
 * be the same bot, and a display name is not an identity.
 */
export function identitiesMatch(
  left: PrimaryFamilyRecordView,
  right: PrimaryFamilyRecordView,
): boolean {
  if (!left.identity || !right.identity) return false;
  return left.identity === right.identity;
}

/**
 * Credential rotation (plan §5.3): adopt the whole credential group of the
 * side updated most recently, canonical winning a tie. Never merged field by
 * field — half of one app's secret with half of another's authenticates as
 * neither.
 */
export function pickCredentialSource(
  canonical: PrimaryFamilyRecordView | undefined,
  legacy: PrimaryFamilyRecordView,
): PrimaryFamilyRecordView {
  if (!canonical) return legacy;
  return legacy.updatedAt > canonical.updatedAt ? legacy : canonical;
}
