/**
 * Cron response collection + channel delivery helpers.
 *
 * Ports of the daemon executor's report/delivery surface
 * (`packages/daemon/src/cron/executor.ts` at 0ed7260c2):
 *
 * - {@link collectCronTurnText} — the shared response-stream accumulator
 *   behind explicit and automatic channel delivery (agent-only text,
 *   user-echo filtered, chunk/full-message dedupe, 5min timeout).
 * - {@link deliverToChannel} — explicit `delivery: { channel, chatId }`.
 * - {@link deliverToAllBoundChannels} — IM auto-delivery to every chat
 *   bound to the agent (daemon commit e6dbc4720), deduped by
 *   `(clientName, chatId)` and best-effort per channel.
 *
 * Kept outside `executor.ts` to hold that file under the repo file-size
 * gate; the executor re-exports nothing from here — it calls in directly.
 */

import {
  logger,
  backgroundCtx,
  getChannelDelivery,
  getMessageQueue,
  type CronHostUtils,
} from './host-utils.js';
import {
  CRON_MESSAGE_LANE,
  type AgentMessage,
  type CronChannelBinding,
  type CronSessionBridgePort,
} from './host-ports.js';
import type { CronTaskState, DeliveryConfig } from './types.js';

/**
 * System note appended to the cron prompt when IM auto-delivery is active,
 * so the agent does not send to IM itself (deliverToAllBoundChannels
 * handles it after the turn — daemon commit b96ae61a8).
 */
export const IM_AUTO_DELIVERY_PROMPT_NOTE =
  '[System: IM delivery is handled automatically after this task completes. Do not send messages to IM/Feishu/Telegram/WeChat yourself.]';

/**
 * IM auto-delivery is available when the host's channel delivery port can
 * enumerate per-agent bindings. Mirrors the daemon's
 * `!!this.channelBindingStore` capability check — presence of the binding
 * surface, not non-empty bindings, gates the prompt note.
 */
export function supportsImAutoDelivery(cronHost: CronHostUtils = {}): boolean {
  return (
    typeof (cronHost.channelDelivery ?? getChannelDelivery())?.listBindingsByAgent === 'function'
  );
}

const RESPONSE_LISTENER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Listen for the cron turn's response stream and hand the accumulated
 * agent text to `onComplete` when the turn ends.
 *
 * Accumulation rules (daemon 2d6d9d38d parity):
 * - only messages for `sessionId` with turn source `'cron'`;
 * - user-role chunks/messages are skipped (cron prompt echo);
 * - full messages whose `msg_id` already streamed as chunks are deduped;
 * - the listener self-unsubscribes on `end` or after a 5min timeout.
 */
export function collectCronTurnText(
  sessionBridge: CronSessionBridgePort,
  input: { agentName: string; cronName: string; sessionId: string; listenerLabel: string },
  onComplete: (text: string) => void,
): void {
  const ctx = backgroundCtx();
  let responseText = '';
  const chunkMsgIds = new Set<string>();

  const timeout = setTimeout(() => {
    unsubscribe();
    logger.warn(
      ctx,
      `[cron] ${input.listenerLabel} listener timed out (5min): agentName=${input.agentName} cronName=${input.cronName} sessionId=${input.sessionId}`,
    );
  }, RESPONSE_LISTENER_TIMEOUT_MS);
  if (typeof timeout.unref === 'function') timeout.unref();

  const unsubscribe = sessionBridge.onResponse((respSessionId: string, message: AgentMessage) => {
    if (respSessionId !== input.sessionId) return;
    if (message.source !== 'cron') return;

    // Accumulate text content from streaming chunks (agent only, skip user echo)
    const chunk = message.respData?.agent_message_chunk;
    if (chunk?.msg_content && (!chunk.role || String(chunk.role) !== 'user')) {
      responseText += chunk.msg_content;
      if (chunk.msg_id) chunkMsgIds.add(chunk.msg_id);
    }

    // Accumulate text content from full messages (agent only, dedupe against chunks)
    const fullMsg = message.respData?.agent_message;
    if (fullMsg?.msg_content && (!fullMsg.role || String(fullMsg.role) !== 'user')) {
      const duplicatedFromChunks = !!(fullMsg.msg_id && chunkMsgIds.has(fullMsg.msg_id));
      if (!duplicatedFromChunks) {
        responseText += fullMsg.msg_content;
      }
    }

    if (message.end) {
      clearTimeout(timeout);
      unsubscribe();
      onComplete(responseText.trim());
    }
  });
}

/** Deliver the cron result to the explicitly configured channel target. */
export async function deliverToChannel(
  state: CronTaskState,
  delivery: NonNullable<DeliveryConfig>,
  text: string,
  sessionId: string,
  cronHost: CronHostUtils = {},
): Promise<void> {
  const ctx = backgroundCtx();
  const channelDelivery = cronHost.channelDelivery ?? getChannelDelivery();
  if (!text || !channelDelivery) return;

  const runner = channelDelivery.getRunner(delivery.channel);
  if (!runner?.isRunning) {
    logger.warn(
      ctx,
      `[cron] Delivery channel runner not available: agentName=${state.agentName} cronName=${state.cronName} channel=${delivery.channel}`,
    );
    return;
  }

  try {
    await runner.sendProactiveMessage(delivery.chatId, text, { sessionId });
    logger.info(
      ctx,
      `[cron] Delivered response to channel: agentName=${state.agentName} cronName=${state.cronName} channel=${delivery.channel} chatId=${delivery.chatId}`,
    );
  } catch (err) {
    logger.error(
      ctx,
      `[cron] Failed to deliver response to channel: agentName=${state.agentName} cronName=${state.cronName} channel=${delivery.channel} err=${(err as Error).message}`,
    );
  }
}

/**
 * Send the cron result to all IM channels bound to the agent.
 * Deduplicates by `(clientName, chatId)` so the same chat does not
 * receive multiple copies when several senders share the binding.
 * Best-effort: offline runners are skipped and per-channel send failures
 * are logged without failing the remaining deliveries.
 */
export async function deliverToAllBoundChannels(
  agentName: string,
  text: string,
  cronSessionId: string,
  cronHost: CronHostUtils = {},
): Promise<void> {
  const ctx = backgroundCtx();
  const channelDelivery = cronHost.channelDelivery ?? getChannelDelivery();
  if (!text || !channelDelivery?.listBindingsByAgent) return;

  let bindings: CronChannelBinding[];
  try {
    bindings = await channelDelivery.listBindingsByAgent(agentName);
  } catch (err) {
    logger.warn(
      ctx,
      `[cron] Failed to list IM bindings for auto-delivery: agentName=${agentName} err=${(err as Error).message}`,
    );
    return;
  }
  if (bindings.length === 0) return;

  const messageQueue = cronHost.messageQueue ?? getMessageQueue();
  const seen = new Set<string>();
  for (const { clientName, chatId } of bindings) {
    if (!clientName || !chatId) continue;
    const dedupeKey = `${clientName}\0${chatId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const runner = channelDelivery.getRunner(clientName);
    if (!runner?.isRunning) continue;

    try {
      const sendTask = async () => {
        await runner.sendProactiveMessage(chatId, text, { sessionId: cronSessionId });
      };
      if (messageQueue) {
        const bucketKey = `cron-report:${clientName}:${chatId}`;
        await messageQueue.enqueue(CRON_MESSAGE_LANE, bucketKey, sendTask, {
          timeoutMs: 30_000,
        });
      } else {
        await sendTask();
      }
    } catch (err) {
      logger.error(
        ctx,
        `[cron] Failed to deliver to IM channel ${clientName}:${chatId}: ${(err as Error).message}`,
      );
    }
  }

  logger.info(
    ctx,
    `[cron] Delivered cron result to ${seen.size} bound IM channel(s): agentName=${agentName}`,
  );
}
