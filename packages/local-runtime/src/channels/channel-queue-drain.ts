/**
 * IM-channel idle drain — collects still-queued channel-sourced items and
 * dispatches one turn at a time, mirroring cron's `drainQueuedCronPrompts`.
 *
 * The channel drain reuses {@link LocalChannelRunner.dispatchQueued} for the
 * heavy lifting (typing indicator + SSE collect + outbound delivery) so the
 * existing channel adapter contract stays the single source of truth.
 *
 * Invariants:
 *   - Picks `source.startsWith('channel:')` queued items only.
 *   - One turn per call; the turn's own terminal event re-drains any
 *     remaining items via `notifySessionTurnFinished` in the host.
 *   - 409 (session became busy again) returns silently — terminal retry
 *     covers the lost race.
 *   - Missing `channelContext` items are marked failed (not retried) —
 *     they cannot be delivered back to a chat anyway.
 *   - Dispatching the same item twice is impossible: dispatchQueued calls
 *     `runQueuedTurn` which transitions the item to `running`; the next
 *     list pass filters it out via `status === 'queued'`.
 */

import type { LocalQueuedMessage } from '../messages/queue.js';
import { imLogger as logger } from '../common/im-logger.js';
import type { LocalChannelContext } from './infra.js';
import type { LocalChannelRunner } from './runner.js';

export interface ChannelQueueDrainDeps {
  queueStore: {
    list(sessionId: string): Promise<LocalQueuedMessage[]>;
    /** Mark items as failed so orphan channel items don't re-surface. */
    finishDrain(sessionId: string, itemIds: string[], status: string): Promise<void>;
  };
  activePiTurns: { has(sessionId: string): boolean };
  runner: Pick<LocalChannelRunner, 'dispatchQueued' | 'deliverQueuedNotice'>;
}

export interface ChannelQueueInboundKickInput {
  ctx: LocalChannelContext;
  sessionId: string;
  queueItemId: string;
}

/**
 * Rebuild a {@link LocalChannelContext} from the queue item's persisted
 * `channelContext`. Returns `undefined` when the field is missing — callers
 * must skip dispatch in that case.
 */
function buildChannelContextFromQueueItem(
  item: LocalQueuedMessage,
): LocalChannelContext | undefined {
  const ctx = item.channelContext;
  if (!ctx) return undefined;
  return {
    platform: ctx.platform as LocalChannelContext['platform'],
    chatType: ctx.chatType,
    chatId: ctx.chatId,
    senderId: ctx.senderId,
    clientName: ctx.clientName,
    ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
  };
}

/**
 * Drain still-queued IM-channel messages for `sessionId`. No-op when the
 * session has an active turn, has no queued channel items, or the session
 * record is missing.
 */
export async function drainQueuedChannelMessages(
  deps: ChannelQueueDrainDeps,
  sessionId: string,
): Promise<void> {
  if (deps.activePiTurns.has(sessionId)) return;
  const queued = (await deps.queueStore.list(sessionId)).filter(
    (item) => item.status === 'queued' && item.source.startsWith('channel:'),
  );
  if (queued.length === 0) return;
  for (const item of queued) {
    if (deps.activePiTurns.has(sessionId)) return;
    const ctx = buildChannelContextFromQueueItem(item);
    if (!ctx) {
      // No persisted channel context — we cannot route the reply back to a
      // chat. Mark the item failed so it does not re-surface on every
      // terminal event.
      logger.warn(
        { itemId: item.itemId, sessionId, reason: 'missing_channel_context' },
        'Channel queue item failed',
      );
      try {
        await deps.queueStore.finishDrain(sessionId, [item.itemId], 'failed');
      } catch {
        // Best-effort; failure here just means the item stays queued until
        // the next drain pass or the 30-min TTL expires.
      }
      continue;
    }
    const result = await deps.runner.dispatchQueued({
      ctx,
      sessionId,
      queueItemId: item.itemId,
    });
    if (result.collected.error && /HTTP 409/.test(result.collected.error)) {
      // Lost the idle race; the next terminal event will retry.
      return;
    }
    // Drain one frame per call. The terminal event of this turn triggers
    // drainQueuedChannelMessages again via notifySessionTurnFinished.
    return;
  }
}

/**
 * Compute the queue position ahead of `itemId` for a channel item. Counts
 *   1 (if the session has an active turn) + N queued channel items that
 * sit before `itemId` in FIFO order.
 *
 * Returns 0 when the item is the channel queue head AND the session is idle,
 * meaning the kick path will dispatch immediately and the caller should
 * suppress the queued-notice reply.
 */
export async function computeChannelQueueAhead(
  queueStore: { list(sessionId: string): Promise<LocalQueuedMessage[]> },
  activePiTurns: { has(sessionId: string): boolean },
  sessionId: string,
  itemId: string,
): Promise<number> {
  const queued = await queueStore.list(sessionId);
  const channelQueued = queued.filter(
    (item) => item.status === 'queued' && item.source.startsWith('channel:'),
  );
  const myIndex = channelQueued.findIndex((item) => item.itemId === itemId);
  if (myIndex < 0) {
    // Item already drained / not a channel item; treat as "no wait".
    return 0;
  }
  const aheadInQueue = myIndex; // items before me
  const aheadBusy = activePiTurns.has(sessionId) ? 1 : 0;
  return aheadInQueue + aheadBusy;
}

export async function kickChannelDrainForInbound(
  deps: ChannelQueueDrainDeps,
  input: ChannelQueueInboundKickInput,
): Promise<void> {
  try {
    const ahead = await computeChannelQueueAhead(
      deps.queueStore,
      deps.activePiTurns,
      input.sessionId,
      input.queueItemId,
    );
    if (ahead > 0) {
      await deps.runner.deliverQueuedNotice(input.ctx, ahead);
    }
  } catch (err) {
    logger.warn(
      { err, sessionId: input.sessionId, queueItemId: input.queueItemId },
      'Channel drain preflight failed',
    );
  }
  void drainQueuedChannelMessages(deps, input.sessionId).catch((err: unknown) => {
    logger.warn({ err, sessionId: input.sessionId }, 'Channel drain kick failed');
  });
}

export function notifyChannelTurnFinished(deps: ChannelQueueDrainDeps, sessionId: string): void {
  void drainQueuedChannelMessages(deps, sessionId).catch((err: unknown) => {
    logger.warn({ err, sessionId }, 'Channel drain terminal-event failed');
  });
}

/**
 * Format the queued-notice text. Aligned with the historical IM gateway
 * wording so the desktop experience matches the legacy daemon.
 */
export function formatQueuedNoticeText(ahead: number): string {
  const count = Math.max(1, ahead);
  return `⏳ 已加入队列，前方还有 ${count} 条消息，请稍候...`;
}
