import { feishuClientId, type LocalFeishuBindingRecord } from '../channels/feishu.js';
import type { FeishuPlatformAdapter } from '../channels/adapters/feishu/feishu-adapter.js';
import { telegramClientId, type LocalTelegramBindingRecord } from '../channels/telegram.js';
import type { TelegramPlatformAdapter } from '../channels/adapters/telegram/telegram-adapter.js';
import { wechatClientId, type LocalWeChatBindingRecord } from '../channels/wechat.js';
import type { LocalWeChatChannelAdapter } from '../channels/adapters/wechat/wechat-adapter.js';
import { imLogger as logger } from '../common/im-logger.js';

/** Records of one platform, or the load error kept for its own restore pass. */
export interface LoadedPlatformRecords<TRecord> {
  readonly records?: TRecord[];
  readonly error?: unknown;
}

/**
 * Read one platform store without throwing, so the caller can inspect all
 * three platforms up front (family gate) while a broken store still fails only
 * its own platform — see {@link requirePlatformRecords}.
 */
export async function loadPlatformRecords<TRecord>(
  list: () => Promise<TRecord[]>,
): Promise<LoadedPlatformRecords<TRecord>> {
  try {
    return { records: await list() };
  } catch (error) {
    return { error };
  }
}

/** Re-throw a deferred store load error inside the owning platform's try. */
function requirePlatformRecords<TRecord>(loaded: LoadedPlatformRecords<TRecord>): TRecord[] {
  if (!loaded.records) throw loaded.error;
  return loaded.records;
}

/** Shared decisions every per-platform restore pass needs. */
export interface ChannelRestorePolicy {
  /**
   * False registers exact outbound clients and adapters from persisted
   * bindings without starting any WS, poller, or monitor.
   */
  readonly startInboundLoops: boolean;
  /**
   * Drop a disabled record's outbound client + adapter (plan §5.6). Idempotent
   * on a missing key, so it doubles as loser cleanup for a record that was
   * enabled earlier in this process's lifetime.
   */
  unregisterDisabled(platform: 'feishu' | 'telegram' | 'wechat', clientName: string): void;
}

/**
 * Feishu: websocket mode is agent-scoped. Start one WS client per bound agent
 * instead of sharing the default adapter's app credentials. We log at every
 * fork so "why didn't WS come up for agent X" can be answered by grepping
 * alone — no "absence of log" reasoning required.
 */
export async function restoreFeishuBindings(input: {
  loaded: LoadedPlatformRecords<LocalFeishuBindingRecord>;
  registerFeishuClient: (record: LocalFeishuBindingRecord) => void;
  startFeishuWs: (agentName: string) => Promise<boolean>;
  getOrCreateFeishuAdapter: (agentName: string) => FeishuPlatformAdapter;
  policy: ChannelRestorePolicy;
}): Promise<void> {
  logger.info({ platform: 'feishu' }, 'Feishu WS restore start');
  try {
    const records = requirePlatformRecords(input.loaded);
    logger.info(
      {
        platform: 'feishu',
        recordCount: records.length,
        agents: records.map((r) => r.agentName),
      },
      'Feishu WS restore store loaded',
    );
    // Distinguish "store genuinely empty" from "store load failed" — both
    // surface as `records: 0` in the summary below, but the latter should
    // also produce a louder error log inside the store itself. Logging
    // here makes the empty-store case at least grep-able when a desktop
    // restart leaves WS un-started.
    if (records.length === 0) {
      logger.info(
        { platform: 'feishu' },
        'Feishu WS restore: no bindings found in store (file empty or all records failed to parse)',
      );
    }
    // Collect the per-agent WS start promises instead of `void`-ing them —
    // the old fire-and-forget silently swallowed rejections, so a desktop
    // reboot with a broken Feishu connection produced zero log lines while
    // the status API still echoed the persisted `connected: true`.
    const attempts: Array<{ agentName: string; promise: Promise<boolean> }> = [];
    let skipped = 0;
    for (const record of records) {
      // Per-agent visitation trace: every record produces exactly one of
      // {skipped:*, attempt}. Grepping by `agentName` gives the full
      // decision path for that agent without cross-referencing summary
      // counts against the raw store dump.
      logger.info(
        {
          platform: 'feishu',
          agentName: record.agentName,
          clientId: record.clientId,
          mode: record.mode,
          connected: record.connected,
          enabled: record.enabled,
          hasAppId: Boolean(record.appId),
          hasAppSecret: Boolean(record.appSecret),
        },
        'Feishu WS restore per-agent visit',
      );
      if (!record.enabled) {
        skipped += 1;
        input.policy.unregisterDisabled('feishu', feishuClientId(record.agentName));
        logger.info(
          { agentName: record.agentName, platform: 'feishu' },
          'Feishu WS restore skipped: record disabled (client + adapter not registered)',
        );
        continue;
      }
      input.registerFeishuClient(record);
      // Ensure the per-agent adapter exists + is registered even when WS is
      // disabled — it is also the webhook inbound handler, so multi-instance
      // routing must not depend on the websocket transport being on.
      input.getOrCreateFeishuAdapter(record.agentName);
      if (!input.policy.startInboundLoops) {
        skipped += 1;
        logger.info(
          { agentName: record.agentName, platform: 'feishu' },
          'Feishu WS restore skipped: startup execution quarantined',
        );
        continue;
      }
      if (record.mode !== 'websocket') {
        skipped += 1;
        logger.info(
          { agentName: record.agentName, mode: record.mode, platform: 'feishu' },
          'Feishu WS restore skipped: mode not websocket',
        );
        continue;
      }
      if (!record.connected) {
        skipped += 1;
        logger.info(
          {
            agentName: record.agentName,
            connected: record.connected,
            enabled: record.enabled,
            platform: 'feishu',
          },
          'Feishu WS restore skipped: not connected/enabled',
        );
        continue;
      }
      if (!record.appId || !record.appSecret) {
        skipped += 1;
        logger.info(
          { agentName: record.agentName, platform: 'feishu' },
          'Feishu WS restore skipped: missing credentials',
        );
        continue;
      }
      logger.info(
        { agentName: record.agentName, platform: 'feishu' },
        'Feishu WS restore per-agent attempt scheduled',
      );
      attempts.push({
        agentName: record.agentName,
        promise: input.startFeishuWs(record.agentName),
      });
    }
    const settled = await Promise.allSettled(attempts.map((attempt) => attempt.promise));
    let wsSucceeded = 0;
    let wsFailed = 0;
    let failure: unknown;
    settled.forEach((result, index) => {
      const agentName = attempts[index]!.agentName;
      if (result.status === 'rejected') {
        wsFailed += 1;
        failure ??= result.reason;
        logger.error(
          { err: result.reason, agentName, platform: 'feishu' },
          'Feishu WS restore failed',
        );
        return;
      }
      // `startFeishuWs` resolves `true` when the transport actually started;
      // `false` / `undefined` mean "did not start" (disabled / precondition
      // miss / error already logged by the host wrapper) — count as failed
      // so the summary reflects the real transport state.
      if (result.value === true) {
        wsSucceeded += 1;
        logger.info({ agentName, platform: 'feishu' }, 'Feishu WS restore per-agent succeeded');
      } else {
        wsFailed += 1;
        failure ??= new Error(`CHANNEL_RESTORE_FAILED: feishu:${agentName}`);
        logger.warn(
          { agentName, platform: 'feishu', started: result.value ?? null },
          'Feishu WS restore per-agent did not start (see prior start-skipped/failed log for cause)',
        );
      }
    });
    logger.info(
      {
        records: records.length,
        wsAttempted: attempts.length,
        wsSucceeded,
        wsFailed,
        skipped,
        platform: 'feishu',
      },
      'Feishu WS restore summary',
    );
    if (failure) throw failure;
  } catch (err) {
    logger.error({ err, platform: 'feishu' }, 'Channel inbound loop restore failed');
    throw err;
  }
}

/**
 * WeChat: enumerate every bound agent and start one monitor wire per
 * `wechat:<agentName>` client. Account binding is agent-scoped; sharing one
 * adapter/monitor would make secondary agents look bound but never receive.
 * Same log discipline as {@link restoreFeishuBindings}.
 */
export async function restoreWeChatBindings(input: {
  loaded: LoadedPlatformRecords<LocalWeChatBindingRecord>;
  getOrCreateWeChatAdapter: (agentName: string) => LocalWeChatChannelAdapter;
  policy: ChannelRestorePolicy;
}): Promise<void> {
  logger.info({ platform: 'wechat' }, 'WeChat monitor restore start');
  try {
    const records = requirePlatformRecords(input.loaded);
    logger.info(
      {
        platform: 'wechat',
        recordCount: records.length,
        agents: records.map((r) => r.agentName),
      },
      'WeChat monitor restore store loaded',
    );
    if (records.length === 0) {
      logger.info({ platform: 'wechat' }, 'WeChat monitor restore: no bindings found in store');
    }
    let attempted = 0;
    let skipped = 0;
    let failure: unknown;
    for (const record of records) {
      logger.info(
        {
          platform: 'wechat',
          agentName: record.agentName,
          clientId: record.clientId,
          mode: record.mode,
          connected: record.connected,
          enabled: record.enabled,
          hasBotToken: Boolean(record.botToken),
          botTokenPending: Boolean(record.botToken?.startsWith('pending:')),
        },
        'WeChat monitor restore per-agent visit',
      );
      if (!record.enabled) {
        skipped += 1;
        input.policy.unregisterDisabled('wechat', wechatClientId(record.agentName));
        logger.info(
          { agentName: record.agentName, platform: 'wechat' },
          'WeChat monitor restore skipped: record disabled (client + adapter not registered)',
        );
        continue;
      }
      // Creating the adapter also registers its outbound client, so it must
      // stay behind the enabled gate above.
      const adapter = input.getOrCreateWeChatAdapter(record.agentName);
      if (!input.policy.startInboundLoops) {
        skipped += 1;
        logger.info(
          { agentName: record.agentName, platform: 'wechat' },
          'WeChat monitor restore skipped: startup execution quarantined',
        );
        continue;
      }
      if (record.mode !== 'polling') {
        skipped += 1;
        logger.info(
          { agentName: record.agentName, mode: record.mode, platform: 'wechat' },
          'WeChat monitor restore skipped: mode not polling',
        );
        continue;
      }
      if (!record.connected) {
        skipped += 1;
        logger.info(
          {
            agentName: record.agentName,
            connected: record.connected,
            enabled: record.enabled,
            platform: 'wechat',
          },
          'WeChat monitor restore skipped: not connected/enabled',
        );
        continue;
      }
      if (!record.botToken || record.botToken.startsWith('pending:')) {
        skipped += 1;
        logger.info(
          { agentName: record.agentName, platform: 'wechat' },
          'WeChat monitor restore skipped: missing/pending bot token',
        );
        continue;
      }
      attempted += 1;
      logger.info(
        { agentName: record.agentName, platform: 'wechat' },
        'WeChat monitor restore per-agent attempt scheduled',
      );
      try {
        if (!(await adapter.startMonitor())) {
          throw new Error(`CHANNEL_RESTORE_FAILED: wechat:${record.agentName}`);
        }
      } catch (err) {
        failure ??= err;
        logger.error(
          { err, agentName: record.agentName, platform: 'wechat' },
          'WeChat monitor restore failed',
        );
      }
    }
    logger.info(
      {
        platform: 'wechat',
        records: records.length,
        attempted,
        skipped,
      },
      'WeChat monitor restore summary',
    );
    if (failure) throw failure;
  } catch (err) {
    logger.error({ err, platform: 'wechat' }, 'Channel inbound loop restore failed');
    throw err;
  }
}

/**
 * Telegram: read the bound bot token directly from the store and hand it to
 * `startPoller`. The adapter does its own "no dispatchInbound -> skip" guard so
 * this is safe to call when the adapter is wired without an inbound dispatcher
 * (CLI / tests). Same log discipline as feishu / wechat.
 */
export async function restoreTelegramBindings(input: {
  loaded: LoadedPlatformRecords<LocalTelegramBindingRecord>;
  registerTelegramClient: (record: LocalTelegramBindingRecord) => void;
  getOrCreateTelegramAdapter: (agentName: string) => TelegramPlatformAdapter;
  policy: ChannelRestorePolicy;
}): Promise<void> {
  logger.info({ platform: 'telegram' }, 'Telegram poller restore start');
  try {
    const records = requirePlatformRecords(input.loaded);
    logger.info(
      {
        platform: 'telegram',
        recordCount: records.length,
        agents: records.map((r) => r.agentName),
      },
      'Telegram poller restore store loaded',
    );
    if (records.length === 0) {
      logger.info({ platform: 'telegram' }, 'Telegram poller restore: no bindings found in store');
    }
    let attempted = 0;
    let skipped = 0;
    let failure: unknown;
    for (const record of records) {
      logger.info(
        {
          platform: 'telegram',
          agentName: record.agentName,
          clientId: record.clientId,
          mode: record.mode,
          enabled: record.enabled,
          hasBotToken: Boolean(record.botToken),
          botTokenPending: Boolean(record.botToken?.startsWith('pending:')),
        },
        'Telegram poller restore per-agent visit',
      );
      if (!record.enabled) {
        skipped += 1;
        input.policy.unregisterDisabled('telegram', telegramClientId(record.agentName));
        logger.info(
          { agentName: record.agentName, platform: 'telegram' },
          'Telegram poller restore skipped: record disabled (client + adapter not registered)',
        );
        continue;
      }
      input.registerTelegramClient(record);
      if (!input.policy.startInboundLoops) {
        skipped += 1;
        logger.info(
          { agentName: record.agentName, platform: 'telegram' },
          'Telegram poller restore skipped: startup execution quarantined',
        );
        continue;
      }
      if (record.mode !== 'sdk') {
        skipped += 1;
        logger.info(
          { agentName: record.agentName, mode: record.mode, platform: 'telegram' },
          'Telegram poller restore skipped: mode not sdk',
        );
        continue;
      }
      if (!record.botToken || record.botToken.startsWith('pending:')) {
        skipped += 1;
        logger.info(
          { agentName: record.agentName, platform: 'telegram' },
          'Telegram poller restore skipped: missing/pending bot token',
        );
        continue;
      }
      attempted += 1;
      logger.info(
        { agentName: record.agentName, platform: 'telegram' },
        'Telegram poller restore per-agent attempt scheduled',
      );
      try {
        if (
          !(await input.getOrCreateTelegramAdapter(record.agentName).startPoller(record.botToken))
        ) {
          throw new Error(`CHANNEL_RESTORE_FAILED: telegram:${record.agentName}`);
        }
      } catch (err) {
        failure ??= err;
        logger.error(
          { err, agentName: record.agentName, platform: 'telegram' },
          'Telegram poller restore failed',
        );
      }
    }
    logger.info(
      {
        platform: 'telegram',
        records: records.length,
        attempted,
        skipped,
      },
      'Telegram poller restore summary',
    );
    if (failure) throw failure;
  } catch (err) {
    logger.error({ err, platform: 'telegram' }, 'Channel inbound loop restore failed');
    throw err;
  }
}
