/**
 * Telegram poll wire — the seam that turns started {@link TelegramPoller}
 * updates into `dispatchInbound` calls.
 *
 * Split out of `telegram-adapter.ts` to stay under the per-file layout
 * budget. The wire owns the poller lifecycle (start/stop/restart) and the
 * `Update → ChannelInboundDispatchInput` translation; the adapter just
 * `attach()`es a wire on bind and `detach()`es on unbind/shutdown.
 *
 * Filtering rules:
 *   - `callback_query` updates are NOT forwarded as plain inbound — the
 *     questionnaire / permission reply hooks own them. `parseLocalTelegramUpdate`
 *     rejects them outright, so forwarding here would surface as noise.
 *   - Any other update kind that `parseLocalTelegramUpdate` rejects is
 *     silently dropped (best-effort: the SDK keeps advancing the offset
 *     so a poison update does not freeze the loop).
 */
import { parseLocalTelegramUpdate } from '../../telegram.js';
import { TelegramPoller, type TelegramPollerOptions } from './telegram-poller.js';
import {
  downloadAttachmentsForUnifiedInbound,
  ensureUnifiedInboundText,
  type ChannelInboundDispatchInput,
} from './telegram-adapter-shared.js';
import type { LocalChannelPlatformAdapter } from '../../adapter.js';
import { imLogger as logger } from '../../../common/im-logger.js';

export interface LocalTelegramPollWireOptions {
  botToken: string;
  defaultAgentName: string;
  clientName: string;
  /**
   * The bound bot's `@username`. Threaded into `parseLocalTelegramUpdate` so
   * group `@bot` mention detection (`hasMention`) and `/command@bot` stripping
   * work in polling mode — without it, group messages are dropped by the
   * mention policy and slash commands never reach the handler.
   */
  botName?: string;
  dispatchInbound: (input: ChannelInboundDispatchInput) => Promise<unknown>;
  /**
   * Adapter used to resolve `envelope.attachmentRefs` to absolute on-disk
   * files. When omitted, attachments are forwarded as refs only (legacy
   * behaviour) and the agent sees an empty multimodal turn — keep this
   * wired in production so polling-mode Telegram inbound matches the
   * webhook route's multimodal pipeline.
   */
  adapter?: LocalChannelPlatformAdapter;
  /** Injected for tests; defaults to global `fetch`. */
  fetcher?: typeof fetch;
  /** Injected for tests; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

export class LocalTelegramPollWire {
  private poller: TelegramPoller | null = null;
  private readonly options: LocalTelegramPollWireOptions;

  constructor(options: LocalTelegramPollWireOptions) {
    this.options = options;
  }

  start(): void {
    if (this.poller?.isRunning()) return;
    const agentName = this.options.defaultAgentName;
    const clientName = this.options.clientName;
    logger.info({ agentName, clientName }, 'Telegram poll wire start');
    const pollerOptions: TelegramPollerOptions = { botToken: this.options.botToken };
    if (this.options.fetcher) pollerOptions.fetcher = this.options.fetcher;
    if (this.options.sleep) pollerOptions.sleep = this.options.sleep;
    const poller = new TelegramPoller(pollerOptions);
    poller.on('update', (update) => {
      this.handleUpdate(update).catch((err) => {
        logger.error({ err, agentName, clientName }, 'Telegram poller update handler failed');
      });
    });
    poller.on('error', (err) => {
      logger.error({ err, kind: err.kind, agentName, clientName }, 'Telegram poller error event');
    });
    poller.on('status', (status) => {
      logger.info({ status, agentName, clientName }, 'Telegram poller status changed');
    });
    this.poller = poller;
    poller.start();
  }

  stop(): void {
    if (!this.poller) return;
    const agentName = this.options.defaultAgentName;
    const clientName = this.options.clientName;
    logger.info(
      { agentName, clientName, wasRunning: this.poller.isRunning() },
      'Telegram poll wire stop',
    );
    this.poller.stop();
    this.poller = null;
  }

  isRunning(): boolean {
    return this.poller?.isRunning() === true;
  }

  private async handleUpdate(update: Record<string, unknown>): Promise<void> {
    // callback_query updates are NOT a normal text message — they cannot
    // go through parseLocalTelegramUpdate (it would reject them). They
    // ARE valid inputs to `tryHandleQuestionnaireReply` and
    // `parsePermissionReply` hooks; route them through the runner with a
    // synthetic ctx so the interception layer can claim them.
    if (isRecord(update.callback_query)) {
      const cbq = update.callback_query;
      const ctx = synthesizeCallbackQueryCtx(
        cbq,
        this.options.defaultAgentName,
        this.options.clientName,
      );
      if (!ctx) return;
      try {
        await this.options.dispatchInbound({
          ctx,
          text: '',
          raw: { update },
          ...(typeof update.update_id === 'number' ? { eventId: String(update.update_id) } : {}),
        });
      } catch (err) {
        logger.error({ err, updateKind: 'callback_query' }, 'Telegram poller dispatch failed');
      }
      return;
    }
    const parsed = parseLocalTelegramUpdate(
      {
        update,
        agentName: this.options.defaultAgentName,
        clientName: this.options.clientName,
        ...(this.options.botName ? { botName: this.options.botName } : {}),
      },
      this.options.defaultAgentName,
    );
    if ('error' in parsed) return;
    let attachments: import('../../../messages/input.js').LocalMessageAttachment[] = [];
    if (this.options.adapter && parsed.attachmentRefs.length > 0) {
      try {
        attachments = await downloadAttachmentsForUnifiedInbound(this.options.adapter, parsed);
      } catch (err) {
        logger.error({ err }, 'Telegram poller attachment download failed');
      }
    }
    const dispatchText = ensureUnifiedInboundText(parsed.text, parsed.attachmentRefs);
    try {
      await this.options.dispatchInbound({
        ctx: parsed.ctx,
        text: dispatchText,
        ...(parsed.eventId ? { eventId: parsed.eventId } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
    } catch (err) {
      logger.error({ err }, 'Telegram poller dispatch failed');
    }
  }
}

/**
 * Synthesise a {@link LocalChannelContext} from a `callback_query`
 * payload so the questionnaire / permission intercept layer has a usable
 * chatId + senderId without going through `parseLocalTelegramUpdate`.
 * Returns `null` when the payload lacks the required ids (rare — the
 * Bot API guarantees them on real callback_query updates).
 */
function synthesizeCallbackQueryCtx(
  cbq: Record<string, unknown>,
  defaultAgentName: string,
  clientName: string,
): import('../../infra.js').LocalChannelContext | null {
  const message = isRecord(cbq.message) ? cbq.message : {};
  const chat = isRecord(message.chat) ? message.chat : {};
  const from = isRecord(cbq.from) ? cbq.from : {};
  const chatId = stringish(chat.id);
  const senderId = stringish(from.id) ?? chatId;
  if (!chatId || !senderId) return null;
  return {
    platform: 'telegram',
    chatType: typeof chat.type === 'string' ? chat.type : 'private',
    chatId,
    senderId,
    clientName: clientName || `telegram:${defaultAgentName}`,
    hasMention: true,
  };
}

function stringish(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
