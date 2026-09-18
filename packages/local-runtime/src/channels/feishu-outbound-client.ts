import type { LocalChannelContext } from './infra.js';
import {
  LocalChannelClientUnavailableError,
  type LocalChannelOutboundStore,
  type LocalChannelOutboundMessage,
  type LocalMultiChannelClient,
} from './runner.js';
import type { ChannelOutboundMessageInput } from './adapter.js';
import { prepareChannelOutboundMessage } from './outbound-message.js';
import type { LocalFeishuBindingRecord, LocalFeishuChannelStore } from './feishu.js';
import { isUsableFeishuBinding } from './adapters/feishu/feishu-adapter-utils.js';
import { buildReplyCard, buildQuestionnaireCard } from './adapters/feishu/feishu-card.js';
import { FeishuSender, type FeishuSenderOptions } from './adapters/feishu/feishu-sender.js';
import {
  removeAckReaction,
  type FeishuPendingReactionStore,
  type FeishuPendingThinkingStore,
} from './adapters/feishu/feishu-ws.js';
import type { AskQuestionnaireRequest } from '@mavis/shared/questionnaire';
import { imLogger as logger } from '../common/im-logger.js';

/** Called after a Card 2.0 questionnaire was successfully posted. */
export type FeishuQuestionnaireRenderedHook = (event: {
  chatId: string;
  request: AskQuestionnaireRequest;
  messageId: string;
  clientName: string;
}) => void;

export class LocalFeishuChannelClient implements LocalMultiChannelClient {
  readonly id: string;
  readonly platform = 'feishu';
  private sender: FeishuSender | undefined;
  private senderFor: { appId: string; appSecret: string } | undefined;

  constructor(
    private readonly outboundStore: LocalChannelOutboundStore,
    private readonly store: LocalFeishuChannelStore,
    private readonly defaultAgentName: string,
    private readonly senderOptions: FeishuSenderOptions = {},
    private readonly pendingThinkingStore?: FeishuPendingThinkingStore,
    /**
     * Shared store of pending 👀 `OnIt` ack reactions (keyed by inbound
     * messageId). Written by the WS dispatcher; consumed here to revoke the
     * ack once the final reply / questionnaire has been delivered.
     */
    private readonly pendingReactionStore?: FeishuPendingReactionStore,
    private readonly onQuestionnaireRendered?: FeishuQuestionnaireRenderedHook,
    clientName?: string,
  ) {
    this.id = clientName?.trim() || defaultAgentName.trim() || 'feishu-local';
  }

  sendText(input: {
    ctx: LocalChannelContext;
    text: string;
    media?: ChannelOutboundMessageInput['media'];
    sessionId?: string;
    queueItemId?: string;
    error?: string;
  }): Promise<LocalChannelOutboundMessage> {
    return this.sendMessage(input);
  }

  async sendMessage(input: ChannelOutboundMessageInput): Promise<LocalChannelOutboundMessage> {
    const outbound = prepareChannelOutboundMessage(input);
    try {
      const record = await this.requireRealBinding(outbound.ctx);
      await this.deliver(outbound, record);
      return this.recordOutbound(outbound, 'sent');
    } catch (err) {
      // An audit failure is retained as an error, but the SDK/credential
      // failure remains observable to the runner. Never fabricate `sent` for
      // a missing exact edge or an unsuccessful platform call.
      await this.recordOutbound(outbound, 'error', 'CHANNEL_DELIVERY_FAILED');
      throw err;
    }
  }

  private recordOutbound(
    input: ChannelOutboundMessageInput,
    status: 'sent' | 'error',
    error = input.error,
  ): Promise<LocalChannelOutboundMessage> {
    return this.outboundStore.append({
      ctx: input.ctx,
      text: input.text,
      status,
      ...(input.media && input.media.length > 0 ? { media: input.media } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.queueItemId ? { queueItemId: input.queueItemId } : {}),
      ...(error ? { error } : {}),
    });
  }

  private async requireRealBinding(ctx: LocalChannelContext): Promise<LocalFeishuBindingRecord> {
    const record = await this.store.get(agentNameFromContext(ctx, this.defaultAgentName));
    if (!isUsableFeishuBinding(record)) {
      throw new LocalChannelClientUnavailableError(ctx);
    }
    return record;
  }

  private async deliver(
    input: ChannelOutboundMessageInput,
    record: LocalFeishuBindingRecord,
  ): Promise<void> {
    const sender = this.ensureSender(record);
    const chatId = input.ctx.chatId;

    // Inbound message id anchoring this turn. Doubles as (a) the thread-reply
    // anchor and (b) the key whose 👀 `OnIt` ack reaction gets revoked once
    // the final reply is delivered. MUST be resolved before the questionnaire
    // path deletes the pending thinking card below.
    const ackMessageId =
      input.ctx.sourceMessageId ?? this.pendingThinkingStore?.get(chatId)?.inboundMessageId;
    const revokeAckReaction = () =>
      removeAckReaction({
        store: this.pendingReactionStore,
        inboundMessageId: ackMessageId,
        remove: (m, r) => sender.removeReaction(m, r),
      });

    // Thread-aware reply: when the inbound message lived inside a Feishu
    // thread/topic (`ctx.threadId` set), route fresh sends through the `reply`
    // endpoint anchored on a message ID inside that thread so the reply lands
    // in-thread. PATCH-into-final paths keep their own message ID and need no
    // anchor. Prefer the triggering message ID; fall back to the pending
    // thinking card's inbound message ID.
    const thread =
      input.ctx.threadId && ackMessageId ? { replyToMessageId: ackMessageId } : undefined;

    // Card 2.0 form questionnaire — when present, it must be rendered as
    // the first interactive bubble (consuming any pending "🤔 Thinking…" card
    // via PATCH so the chat stays at one bubble per turn). Mirror of the
    // adapter sendMessage path (feishu-adapter.ts:300+) so the runner
    // outbound surface stays the single source of truth.
    if (input.questionnaire) {
      const card = buildQuestionnaireCard(input.questionnaire);
      let messageId: string | undefined;
      const pending = this.pendingThinkingStore?.get(chatId);
      logger.info(
        {
          requestId: input.questionnaire.id,
          chatId,
          pendingThinkingMsgId: pending?.messageId ?? null,
        },
        'Feishu questionnaire delivery started',
      );
      if (pending) {
        this.pendingThinkingStore?.delete(chatId);
        try {
          await sender.patchCard(pending.messageId, card);
          messageId = pending.messageId;
          logger.info(
            { messageId: pending.messageId },
            'Feishu questionnaire patched thinking card',
          );
        } catch {
          /* patch failed — fall through to a fresh card send */
        }
      }
      if (!messageId) {
        const result = await sender.sendCard(chatId, card, 'chat_id', thread);
        messageId = result?.messageId;
        logger.info({ messageId: messageId ?? null }, 'Feishu questionnaire sent fresh card');
      }
      if (messageId) {
        this.onQuestionnaireRendered?.({
          chatId,
          request: input.questionnaire,
          messageId,
          clientName: this.id,
        });
        // Questionnaire delivered — revoke the 👀 inbound ack reaction.
        await revokeAckReaction();
      }
      // Feishu Card 2.0 form already carries the question text inside the
      // card — never double-post a tail reply card on the questionnaire
      // path. Skip the legacy text/media tail entirely.
      return;
    }

    const hasMedia = !!input.media?.length;
    const hasText = input.text.trim().length > 0;
    if (!hasMedia && !hasText) return;

    // Send all media before the tail reply. A failed SDK call rejects the
    // delivery so audit state cannot claim a complete real-platform send.
    for (const ref of input.media ?? []) {
      await sender.sendMedia(chatId, ref, 'chat_id', thread);
    }
    const finalText = input.text.trim() || (hasMedia ? '[已发送媒体]' : '');
    const pending = this.pendingThinkingStore?.get(chatId);
    if (pending) {
      this.pendingThinkingStore?.delete(chatId);
      try {
        await sender.patchCard(pending.messageId, buildReplyCard(finalText || ' '));
        // Final reply patched in place — revoke the 👀 inbound ack reaction.
        await revokeAckReaction();
        return;
      } catch {
        // patchCard failed — fall through to a fresh card so the user still
        // gets the message (even if the grey card stays orphaned).
      }
    }
    if (finalText) {
      await sender.sendCard(chatId, buildReplyCard(finalText), 'chat_id', thread);
      // Final reply delivered as a fresh card — revoke the 👀 inbound ack.
      await revokeAckReaction();
    }
  }

  private ensureSender(record: LocalFeishuBindingRecord): FeishuSender {
    if (
      this.sender &&
      this.senderFor?.appId === record.appId &&
      this.senderFor.appSecret === record.appSecret
    ) {
      return this.sender;
    }
    this.sender?.invalidateToken();
    this.sender = new FeishuSender(record.appId, record.appSecret, {
      ...this.senderOptions,
      clientName: this.id,
    });
    this.senderFor = { appId: record.appId, appSecret: record.appSecret };
    return this.sender;
  }
}

function agentNameFromContext(ctx: LocalChannelContext, fallback: string): string {
  const name = ctx.clientName.trim();
  if (!name || name.startsWith('platform:') || name === 'feishu-local') return fallback;
  return name;
}
