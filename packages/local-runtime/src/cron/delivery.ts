/**
 * Local-runtime implementation of the cron `ChannelDeliveryPort`.
 *
 * Bridges the agent-core cron executor's delivery surface (explicit
 * `delivery: { channel, chatId }` targets and IM auto-delivery to bound
 * chats — daemon `MultiChannelClient.getRunner` + `channelBindingStore`
 * parity) onto the local channel stack:
 *
 * - `getRunner(clientName)` resolves the platform from the local client-id
 *   convention (`<agent>` = feishu, `telegram:<agent>`, `wechat:<agent>`)
 *   and sends through `LocalChannelRunner`'s registered clients.
 * - Unconfigured channels are skipped with one structured log at the send
 *   boundary instead of failing the cron run (daemon offline-runner parity).
 * - `listBindingsByAgent` (the IM auto-delivery gate via
 *   `supportsImAutoDelivery`) is intentionally NOT exposed for now — see the
 *   TODO on the returned port. The desktop product has no IM-binding surface
 *   yet, so the gate only produced a misleading prompt note with no delivery.
 */

import type { ChannelDeliveryPort, CronChannelRunner } from '@mavis/cron';

import type { LocalChannelBindingStore, LocalChannelContext } from '../channels/infra.js';
import type { LocalChannelRunner } from '../channels/runner.js';
import type { LocalFeishuChannelApi } from '../channels/feishu.js';
import type { LocalTelegramChannelApi } from '../channels/telegram.js';
import type { LocalWeChatChannelApi } from '../channels/wechat.js';
import { imLogger as logger } from '../common/im-logger.js';

export interface LocalCronChannelDeliveryDeps {
  runner: LocalChannelRunner;
  bindingStore: LocalChannelBindingStore;
  feishu: LocalFeishuChannelApi;
  telegram: LocalTelegramChannelApi;
  wechat: LocalWeChatChannelApi;
}

interface ResolvedCronChannelTarget {
  platform: LocalChannelContext['platform'];
  agentName: string;
}

/**
 * Local client-id convention (mirrors `feishuClientId` / `telegramClientId`
 * / `wechatClientId`): a bare agent name addresses the feishu client; the
 * other platforms carry a `<platform>:` prefix.
 */
function resolveCronChannelTarget(clientName: string): ResolvedCronChannelTarget | undefined {
  const trimmed = clientName.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('telegram:')) {
    return { platform: 'telegram', agentName: trimmed.slice('telegram:'.length) || 'mavis' };
  }
  if (trimmed.startsWith('wechat:')) {
    return { platform: 'wechat', agentName: trimmed.slice('wechat:'.length) || 'mavis' };
  }
  return { platform: 'feishu', agentName: trimmed };
}

export function buildLocalCronChannelDelivery(
  deps: LocalCronChannelDeliveryDeps,
): ChannelDeliveryPort {
  const isConfigured = async (target: ResolvedCronChannelTarget): Promise<boolean> => {
    const api =
      target.platform === 'telegram'
        ? deps.telegram
        : target.platform === 'wechat'
          ? deps.wechat
          : deps.feishu;
    const check = await api.configCheck(target.agentName);
    return check.configured === true;
  };

  return {
    getRunner(clientName: string): CronChannelRunner | undefined {
      const target = resolveCronChannelTarget(clientName);
      if (!target) return undefined;
      return {
        isRunning: true,
        sendProactiveMessage: async (chatId, text, meta) => {
          // Daemon parity: an unbound/unconfigured channel is an offline
          // runner — skip the send (never appending an outbound record)
          // instead of failing the cron delivery fan-out.
          if (!(await isConfigured(target))) {
            logger.info(
              {
                platform: target.platform,
                agentName: target.agentName,
                reason: 'channel_not_configured',
              },
              'Cron channel delivery skipped: channel not configured',
            );
            return;
          }
          const ctx: LocalChannelContext = {
            platform: target.platform,
            chatType: 'p2p',
            chatId,
            senderId: 'cron-executor',
            clientName,
          };
          await deps.runner.clients.get(ctx).sendText({
            ctx,
            text,
            ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
          });
        },
      };
    },
    // TODO(cron-im-auto-delivery): `listBindingsByAgent` is intentionally
    // omitted so IM auto-delivery stays OFF. Its presence is what flips
    // `supportsImAutoDelivery` to true, which (a) appends
    // IM_AUTO_DELIVERY_PROMPT_NOTE to the cron prompt and (b) fans the result
    // out via `deliverToAllBoundChannels` after the turn. The desktop product
    // has no IM/Feishu binding UI yet, so bindings are always empty — the note
    // was misleading noise on manually-triggered crons with no real delivery.
    // Re-add when desktop IM binding is wired and useful:
    //   async listBindingsByAgent(agentName) {
    //     const bindings = await deps.bindingStore.list({ agentName });
    //     return bindings.map((b) => ({ clientName: b.clientName, chatId: b.chatId }));
    //   }
  };
}
