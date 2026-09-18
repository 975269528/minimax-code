import type { LocalChannelAdapterRegistry } from '../channels/adapter-registry.js';
import type { LocalAccessControlStore } from '../channels/access-control-store.js';
import type { FeishuPlatformAdapter } from '../channels/adapters/feishu/feishu-adapter.js';
import type { TelegramPlatformAdapter } from '../channels/adapters/telegram/telegram-adapter.js';
import type { LocalWeChatChannelAdapter } from '../channels/adapters/wechat/wechat-adapter.js';
import type { LocalFeishuBindingRecord, LocalFeishuChannelStore } from '../channels/feishu.js';
import type {
  LocalTelegramBindingRecord,
  LocalTelegramChannelStore,
} from '../channels/telegram.js';
import type { LocalWeChatChannelStore } from '../channels/wechat.js';
import type { ChannelPlatform } from '../channels/route-api.js';
import { imLogger as logger } from '../common/im-logger.js';
import {
  assertSingleEnabledRecordPerFamily,
  type ChannelAgentReadScopeResolver,
} from './host-channel-family-gate.js';
import {
  loadPlatformRecords,
  restoreFeishuBindings,
  restoreTelegramBindings,
  restoreWeChatBindings,
  type ChannelRestorePolicy,
} from './host-channel-restore-platforms.js';

/**
 * Restore persisted channel bindings for every already-bound agent. Exact
 * outbound clients and adapters are registered for enabled records only;
 * callers may quarantine transport startup so a copied binding does not resume
 * WS, monitor, or poller activity.
 *
 * Two gates run BEFORE anything is registered or started (plan §5.6):
 *   - a canonical-family gate — two enabled records of one Agent family on one
 *     platform fail the whole restore with `PRIMARY_AGENT_CHANNEL_CONFLICT`
 *     and zero transports, instead of letting the last writer win;
 *   - a per-record `enabled` gate — a disabled record enters neither registry
 *     and starts no inbound; an already-registered loser is unregistered.
 *
 * Store reads and transport starts are strict: an enabled binding that cannot
 * restore rejects the caller's startup instead of reporting a ready runtime
 * with an inert channel. Access-control seeding below remains best-effort.
 */
export async function restoreInboundLoops(input: {
  feishuStore: LocalFeishuChannelStore;
  telegramStore: LocalTelegramChannelStore;
  wechatStore: LocalWeChatChannelStore;
  registerFeishuClient: (record: LocalFeishuBindingRecord) => void;
  registerTelegramClient: (record: LocalTelegramBindingRecord) => void;
  startFeishuWs: (agentName: string) => Promise<boolean>;
  getOrCreateFeishuAdapter: (agentName: string) => FeishuPlatformAdapter;
  getOrCreateTelegramAdapter: (agentName: string) => TelegramPlatformAdapter;
  getOrCreateWeChatAdapter: (agentName: string) => LocalWeChatChannelAdapter;
  /**
   * False restores exact outbound clients and adapters from persisted bindings
   * without starting any WS, poller, or monitor represented by copied state.
   */
  startInboundLoops?: boolean;
  /**
   * Agent read-scope resolver used to decide which records belong to one
   * canonical family. Absent (pure V1 / tests) → every agentName is its own
   * family and the conflict gate stays inert.
   */
  resolveAgentReadScope?: ChannelAgentReadScopeResolver;
  /** Outbound client registry, used to unregister a disabled record's client. */
  clientRegistry?: { unregister(clientId: string): void };
  /** Adapter registry, used to unregister a disabled record's adapter. */
  adapterRegistry?: LocalChannelAdapterRegistry;
  /**
   * Optional Access Control store. When provided, the restore pass
   * also calls `ensureDefaultPolicy(platform, clientName)` for every
   * bound record so a desktop restart picks up with a fresh policy
   * entry ready to edit. Existing entries are never overwritten —
   * see `LocalAccessControlStore.ensureDefaultPolicy`.
   */
  accessControlStore?: LocalAccessControlStore;
}): Promise<void> {
  // Load every platform before registration so the family gate can reject
  // duplicate enabled records without starting either transport.
  const [feishuRecords, telegramRecords, wechatRecords] = await Promise.all([
    loadPlatformRecords(() => input.feishuStore.list()),
    loadPlatformRecords(() => input.telegramStore.list()),
    loadPlatformRecords(() => input.wechatStore.list()),
  ]);
  for (const [platform, loaded] of [
    ['feishu', feishuRecords],
    ['telegram', telegramRecords],
    ['wechat', wechatRecords],
  ] as const) {
    if (!loaded.records) continue;
    await assertSingleEnabledRecordPerFamily({
      platform,
      records: loaded.records,
      ...(input.resolveAgentReadScope
        ? { resolveAgentReadScope: input.resolveAgentReadScope }
        : {}),
    });
  }
  const policy: ChannelRestorePolicy = {
    startInboundLoops: input.startInboundLoops !== false,
    unregisterDisabled: (platform, clientName) => {
      input.clientRegistry?.unregister(clientName);
      input.adapterRegistry?.unregister(platform, clientName);
    },
  };
  // Restore each platform concurrently, but wait for every transport to
  // settle before surfacing a failure so caller cleanup cannot race a still-
  // starting sibling transport.
  const settled = await Promise.allSettled([
    restoreFeishuBindings({
      loaded: feishuRecords,
      registerFeishuClient: input.registerFeishuClient,
      startFeishuWs: input.startFeishuWs,
      getOrCreateFeishuAdapter: input.getOrCreateFeishuAdapter,
      policy,
    }),
    restoreWeChatBindings({
      loaded: wechatRecords,
      getOrCreateWeChatAdapter: input.getOrCreateWeChatAdapter,
      policy,
    }),
    restoreTelegramBindings({
      loaded: telegramRecords,
      registerTelegramClient: input.registerTelegramClient,
      getOrCreateTelegramAdapter: input.getOrCreateTelegramAdapter,
      policy,
    }),
  ]);
  const failure = settled.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  // Migration doc §Integration point 4: ensureDefaultPolicy must run for every
  // bound record after a desktop restart so the AC UI has a fresh
  // entry to render. Failures here degrade to "no entry written yet"
  // (the next inbound will fall through to the default policy until
  // the operator edits the YAML), which is the same behaviour as
  // before this MR — never block startup on AC seeding.
  const accessControlStore = input.accessControlStore;
  if (!accessControlStore) return;
  try {
    const seedAll = async (platform: ChannelPlatform, clientIds: string[]) => {
      for (const clientName of clientIds) {
        await accessControlStore.ensureDefaultPolicy(platform, clientName);
      }
    };
    await Promise.all([
      seedAll(
        'feishu',
        (feishuRecords.records ?? []).map((r) => r.clientId),
      ),
      seedAll(
        'telegram',
        (telegramRecords.records ?? []).map((r) => r.clientId),
      ),
      seedAll(
        'wechat',
        (wechatRecords.records ?? []).map((r) => r.clientId),
      ),
    ]);
  } catch (err) {
    logger.warn({ err }, 'Channel access-control seeding failed');
  }
}
