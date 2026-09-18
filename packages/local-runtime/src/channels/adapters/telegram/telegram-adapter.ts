/**
 * Telegram unified-channel adapter. Composes:
 *   - `LocalTelegramChannelStore`        — binding persistence
 *   - `TelegramSender`                   — outbound text + media (Bot API)
 *   - `TelegramAttachmentDownloader`     — inbound media download
 *   - `parseLocalTelegramUpdate`         — inbound normalisation
 *
 * Multi-instance: registry can hold several adapters keyed by `clientName`.
 */

import type { OutboundMediaRef } from '@mavis/shared';

import { readFirstString } from '../../../api/http-helpers.js';

import type {
  ChannelAttachmentDownloadInput,
  ChannelBindInput,
  ChannelBindResult,
  ChannelOutboundMessageInput,
  ChannelOutboundResult,
  ChannelStatusInput,
  ChannelStatusResult,
  ChannelUnbindInput,
  ChannelUnbindResult,
  LocalChannelPlatformAdapter,
  PlatformInboundInput,
} from '../../adapter.js';
import { prepareChannelOutboundMessage } from '../../outbound-message.js';
import type { QuestionnaireReplyOutcome } from '../../../questionnaire/reply-outcome.js';
import type { ChannelInboundAttachmentRef, ChannelInboundEnvelope } from '../../envelope.js';
import type { LocalChannelContext } from '../../infra.js';
import type { LocalChannelOwnerStore } from '../../owner-store.js';
import { clearOwnerAllConventions } from '../../owner-store.js';
import {
  toRenderablePermission,
  type ChannelPermissionBehavior,
  type ChannelRenderablePermission,
  type LocalChannelPermissionPending,
} from '../../permission-bridge.js';
import {
  isUsableTelegramBinding,
  LocalTelegramChannelStore,
  parseLocalTelegramUpdate,
  telegramClientId,
} from '../../telegram.js';
import {
  TelegramAttachmentDownloader,
  type TelegramAttachmentKind,
} from './telegram-attachment-downloader.js';
import { buildPermissionKeyboard, decodePermissionCallback } from './telegram-keyboard.js';
import { LocalTelegramPollWire } from './telegram-poll-wire.js';
import { TelegramQuestionnaireRuntime } from './telegram-questionnaire-runtime.js';
import { TelegramSender } from './telegram-sender.js';
import { imLogger as logger } from '../../../common/im-logger.js';

export type { ChannelInboundDispatchInput } from './telegram-adapter-shared.js';

export interface TelegramPlatformAdapterOptions {
  /** Backing store — shared with the legacy `LocalTelegramChannelApi`. */
  store: LocalTelegramChannelStore;
  /**
   * Default agent name. Used when an inbound/status call carries no agent
   * id (CLI / sandbox tests typically omit it). Defaults to `mavis`.
   */
  defaultAgentName?: string;
  /** Override the adapter's stable `clientName`. */
  clientName?: string;
  /** Override the `getMe` fetch used by bind. */
  tokenVerifyFetcher?: typeof fetch;
  /** Construct the outbound `TelegramSender` for an SDK-mode binding. */
  senderFactory?: (botToken: string) => TelegramSender;
  /** Construct the inbound `TelegramAttachmentDownloader`. */
  downloaderFactory?: (input: {
    botToken: string;
    scopeDirName: string;
  }) => TelegramAttachmentDownloader;
  /**
   * Optional owner store. When provided, {@link unbind} clears any recorded
   * owner under both the daemon (`telegram:<agent>`) and imGateway
   * (`<agent>:telegram`) conventions, mirroring `LocalTelegramChannelApi`.
   */
  ownerStore?: LocalChannelOwnerStore;
  /** Host-owned exact edge cleanup for direct unified `telegram/unbind`. */
  onUnbind?: (agentName: string) => void | Promise<void>;
  /**
   * Optional inbound dispatcher. When provided, `bind()` starts a Bot API
   * long-poll (see {@link TelegramPoller}) and translates every received
   * update into a `dispatchInbound` call. Without this, the adapter only
   * sends — production wiring always passes this; unit tests that only
   * exercise outbound omit it.
   */
  dispatchInbound?: (
    input: import('./telegram-adapter-shared.js').ChannelInboundDispatchInput,
  ) => Promise<unknown>;
  /**
   * Injected for tests; defaults to global `fetch`. Used by both
   * `tokenVerifyFetcher` (override that takes precedence) and the poller's
   * own `getUpdates` fetcher when no specific override is given.
   */
  pollerFetcher?: typeof fetch;
  /** Fired after bind persists an SDK binding so host can register exact outbound. */
  onBindingChanged?: (
    record: import('../../telegram.js').LocalTelegramBindingRecord,
  ) => void | Promise<void>;
}

/**
 * Decompose `clientName` into the underlying agent name. Strips the
 * `telegram:` prefix when present; otherwise returns the input unchanged.
 * Falls back to the supplied default when the input is empty.
 */
function agentNameForCtx(ctx: LocalChannelContext, defaultAgentName: string): string {
  const clientName = ctx.clientName?.trim();
  if (!clientName) return defaultAgentName;
  return clientName.startsWith('telegram:')
    ? clientName.slice('telegram:'.length).trim() || defaultAgentName
    : clientName;
}

function agentNameForAdapter(adapterClientName: string, defaultAgentName: string): string {
  return adapterClientName.startsWith('telegram:')
    ? adapterClientName.slice('telegram:'.length).trim() || defaultAgentName
    : adapterClientName.trim() || defaultAgentName;
}

export class TelegramPlatformAdapter implements LocalChannelPlatformAdapter {
  readonly platform = 'telegram' as const;
  readonly clientName: string;

  private readonly defaultAgentName: string;
  private readonly senderFactory: (botToken: string) => TelegramSender;
  private readonly downloaderFactory: (input: {
    botToken: string;
    scopeDirName: string;
  }) => TelegramAttachmentDownloader;
  /** Long-poll wire; null when no inbound dispatcher is wired or bind hasn't fired. */
  private pollWire: LocalTelegramPollWire | null = null;
  private readonly questionnaires: TelegramQuestionnaireRuntime;
  /**
   * Per-chat typing-refresh timers. Telegram clears a chat action after ~5 s,
   * so a turn-long indicator must re-send on a timer until {@link notifyTurnEnd}
   * stops it. Parity with the historical TelegramChannelClient typing path
   * and with `LocalWeChatChannelAdapter.typingTimers`.
   */
  private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private readonly options: TelegramPlatformAdapterOptions) {
    this.defaultAgentName = options.defaultAgentName ?? 'mavis';
    this.clientName = options.clientName ?? telegramClientId(this.defaultAgentName);
    this.senderFactory = options.senderFactory ?? ((botToken) => new TelegramSender(botToken));
    this.downloaderFactory =
      options.downloaderFactory ??
      ((input) =>
        new TelegramAttachmentDownloader({
          botToken: input.botToken,
          dataDir: () => options.store.getDataDir(),
          scopeDirName: input.scopeDirName,
        }));
    this.questionnaires = new TelegramQuestionnaireRuntime((ctx) =>
      this.resolveQuestionnaireSender(ctx),
    );
  }

  /**
   * Verify the bot token via `getMe` and persist the binding. The token
   * MUST validate successfully — a network failure or `ok: false` from
   * Telegram fails the bind. Silent mock-mode fallback (legacy behaviour)
   * was the root cause of users seeing "bind succeeded" while messages
   * never reached Telegram.
   */
  async bind(input: ChannelBindInput): Promise<ChannelBindResult> {
    const credentials = input.credentials ?? {};
    const botToken = readFirstString(credentials, ['botToken', 'token']);
    const agentName = (input.agentName?.trim() || this.defaultAgentName).trim();
    const requestedMode = readFirstString(credentials, ['mode'])?.toLowerCase();
    if (requestedMode === 'mock') {
      return {
        ok: false,
        clientName: telegramClientId(agentName),
        error: 'mock channel mode is not supported',
        code: 'CHANNEL_MOCK_MODE_UNSUPPORTED',
      };
    }
    if (requestedMode && requestedMode !== 'sdk') {
      return {
        ok: false,
        clientName: telegramClientId(agentName),
        error: 'unsupported channel mode',
        code: 'VALIDATION_ERROR',
      };
    }
    if (!botToken) {
      return {
        ok: false,
        clientName: telegramClientId(agentName),
        error: 'botToken is required',
        code: 'VALIDATION_ERROR',
      };
    }

    let verifiedBotName: string | undefined;
    const verifyFetch = this.options.tokenVerifyFetcher ?? fetch;
    try {
      const response = await verifyFetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const data = (await response.json()) as {
        ok: boolean;
        result?: { first_name?: string; username?: string };
        description?: string;
      };
      if (!data.ok) {
        return {
          ok: false,
          clientName: telegramClientId(agentName),
          error: `Invalid bot token: ${data.description ?? 'getMe returned ok=false'}`,
          code: 'INVALID_BOT_TOKEN',
        };
      }
      // Store just the `@username` handle (see LocalTelegramChannelApi.bind):
      // it is the only token Telegram uses in @mentions / `/command@bot`, so
      // it is what mention + command matching compares against.
      verifiedBotName = data.result?.username
        ? `@${data.result.username}`
        : (data.result?.first_name ?? undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        clientName: telegramClientId(agentName),
        error: `Failed to verify bot token via Telegram getMe: ${msg}`,
        code: 'TELEGRAM_VERIFY_UNREACHABLE',
      };
    }

    const botName =
      verifiedBotName ?? readFirstString(credentials, ['botName', 'username', 'botUsername']);
    const record = await this.options.store.bind({
      agentName,
      botToken,
      ...(botName ? { botName } : {}),
      mode: 'sdk',
    });
    // Plan §5.2: a staged / non-winner primary-family record starts nothing.
    // Only the reconciler's winner and the single startup restore may.
    if (record.enabled === false || (await this.options.store.isPrimaryFamilyAgent(agentName))) {
      logger.info(
        { agentName, platform: 'telegram', clientName: record.clientId },
        'Telegram bind transport start delegated to family reconciler',
      );
      return { ok: true, clientName: record.clientId };
    }
    await this.options.onBindingChanged?.(record);
    // Start the long-poll so inbound updates flow into the runner. Failure
    // to start the poller is non-fatal: the bind still succeeds (outbound
    // works), inbound stays dark with a loud log.
    this.startPollerBestEffort(botToken);
    return { ok: true, clientName: record.clientId };
  }

  /**
   * Start the Bot API long-poll for the bound token. Idempotent: a no-op
   * when no inbound dispatcher is configured or the poller is already
   * running. Production callers use this on the `restoreActiveBindings`
   * boot path; `bind()` calls it internally.
   */
  async startPoller(botToken: string): Promise<boolean> {
    if (!this.options.dispatchInbound) return false;
    if (this.pollWire?.isRunning()) return true;
    await this.buildAndStartPoller(botToken);
    return this.pollWire?.isRunning() === true;
  }

  /** Stop the long-poll. Safe to call without a started poller. */
  shutdown(): void {
    const hadPoller = Boolean(this.pollWire);
    logger.info(
      {
        agentName: this.defaultAgentName,
        clientName: this.clientName,
        hadPoller,
        reason: 'adapter-shutdown',
      },
      'Telegram poller shutdown requested (intentional)',
    );
    this.pollWire?.stop();
    this.pollWire = null;
    for (const timer of this.typingTimers.values()) {
      clearInterval(timer);
    }
    this.typingTimers.clear();
  }

  private startPollerBestEffort(botToken: string): void {
    void this.startPoller(botToken).catch((err) => {
      logger.error(
        { err, agentName: this.defaultAgentName, clientName: this.clientName },
        'Telegram poller start failed',
      );
    });
  }

  private async buildAndStartPoller(botToken: string): Promise<void> {
    const dispatchInbound = this.options.dispatchInbound;
    if (!dispatchInbound) return;
    if (this.pollWire?.isRunning()) return;
    // Resolve the bound bot's @username so group `@bot` mention detection +
    // `/command@bot` suffix stripping work in polling mode. Without it, group
    // messages are dropped by the mention policy before reaching the handler.
    let botName: string | undefined;
    try {
      const record = await this.options.store.get(this.defaultAgentName);
      botName = record?.botName ?? undefined;
    } catch {
      botName = undefined;
    }
    // Re-check after the await: bind()/restore may have raced us here.
    if (this.pollWire?.isRunning()) return;
    const wireOptions: import('./telegram-poll-wire.js').LocalTelegramPollWireOptions = {
      botToken,
      defaultAgentName: this.defaultAgentName,
      clientName: this.clientName,
      dispatchInbound,
      // Pass `this` as the adapter so the wire can resolve attachmentRefs
      // through `downloadAttachmentToLocal`. Without this, polling-mode
      // inbound silently drops images / voice / files (the webhook route
      // already does this same hop via `telegram-adapter-routes.ts`).
      adapter: this,
      ...(botName ? { botName } : {}),
    };
    if (this.options.pollerFetcher) wireOptions.fetcher = this.options.pollerFetcher;
    this.pollWire = new LocalTelegramPollWire(wireOptions);
    this.pollWire.start();
  }

  async unbind(input: ChannelUnbindInput): Promise<ChannelUnbindResult> {
    const agentName = (input.agentName?.trim() || this.defaultAgentName).trim();
    // Stop the long-poll before the store-side unbind so the in-flight
    // fetch is aborted while the token is still valid (avoid an extra
    // 401 round-trip on the way out).
    this.pollWire?.stop();
    this.pollWire = null;
    await this.options.onUnbind?.(agentName);
    const removed = await this.options.store.unbind(agentName);
    // Mirror `LocalTelegramChannelApi.unbind`: clear the recorded owner under
    // both daemon (`telegram:<agent>`) and imGateway (`<agent>:telegram`)
    // conventions so the next DM after re-bind can claim ownership cleanly.
    if (removed && this.options.ownerStore) {
      await clearOwnerAllConventions(
        this.options.ownerStore,
        agentName,
        'telegram',
        telegramClientId(agentName),
      );
    }
    return { ok: removed };
  }

  async status(input?: ChannelStatusInput): Promise<ChannelStatusResult> {
    const agentName = (
      input?.agentName?.trim() || agentNameForAdapter(this.clientName, this.defaultAgentName)
    ).trim();
    const record = await this.options.store.get(agentName);
    const detail: Record<string, unknown> = {};
    if (record) {
      detail.mode = record.mode;
      detail.enabled = record.enabled;
      if (record.botName) detail.botName = record.botName;
      detail.tokenMasked = maskToken(record.botToken);
      detail.createdAt = record.createdAt;
      detail.updatedAt = record.updatedAt;
    }
    const configured = isUsableTelegramBinding(record);
    return {
      configured,
      connected: configured,
      clientName: record?.clientId ?? telegramClientId(agentName),
      ...(record ? { detail } : {}),
    };
  }

  /**
   * Normalise a raw Telegram update payload into the platform-neutral
   * {@link ChannelInboundEnvelope}.
   */
  async normalizeInbound(input: PlatformInboundInput): Promise<ChannelInboundEnvelope> {
    const raw = input.raw;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('TelegramPlatformAdapter.normalizeInbound: raw must be an object');
    }
    const body = raw as Record<string, unknown>;
    const parsed = parseLocalTelegramUpdate(body, this.defaultAgentName);
    if ('error' in parsed) {
      const text = await parsed.error.clone().text();
      throw new Error(`TelegramPlatformAdapter.normalizeInbound: ${text || 'invalid payload'}`);
    }
    return parsed;
  }

  /**
   * Deliver an outbound message. Text + each media ref are dispatched via
   * the Bot API; an unavailable or legacy mock binding fails closed.
   */
  async sendMessage(input: ChannelOutboundMessageInput): Promise<ChannelOutboundResult> {
    const outbound = prepareChannelOutboundMessage(input);
    const agentName = agentNameForCtx(outbound.ctx, this.defaultAgentName);
    const record = await this.options.store.get(agentName);
    const id = `telegram:${outbound.ctx.chatId}:${Date.now()}`;
    if (!isUsableTelegramBinding(record)) {
      return { id, status: 'error', error: 'Telegram binding is not configured' };
    }
    if (!outbound.ctx.chatId) {
      return { id, status: 'error', error: 'ctx.chatId is required' };
    }
    const sender = this.senderFactory(record.botToken);
    try {
      const text = outbound.text?.trim() ?? '';
      if (outbound.questionnaire) {
        await this.questionnaires.sendInitial({
          ctx: outbound.ctx,
          request: outbound.questionnaire,
          sender,
        });
      } else if (text) {
        await sender.sendText(outbound.ctx.chatId, outbound.text, undefined, outbound.ctx.threadId);
      }
      for (const ref of outbound.media ?? []) {
        await this.sendOneMediaSafely(sender, outbound.ctx.chatId, ref, outbound.ctx.threadId);
      }
      return { id, status: 'sent' };
    } catch (err) {
      return { id, status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Optional `downloadAttachment` — proxies to `TelegramAttachmentDownloader`
   * and only enriches the incoming ref with detected `mimeType` / `name`.
   */
  async downloadAttachment(
    input: ChannelAttachmentDownloadInput,
  ): Promise<ChannelInboundAttachmentRef> {
    const agentName = agentNameForAdapter(input.clientName, this.defaultAgentName);
    const record = await this.options.store.get(agentName);
    if (!isUsableTelegramBinding(record)) {
      throw new Error('Telegram binding is not configured');
    }
    const downloader = this.downloaderFactory({
      botToken: record.botToken,
      scopeDirName: input.clientName,
    });
    const kind = inferTelegramKindFromRef(input.ref);
    const attachment = await downloader.downloadAttachment(kind, input.ref);
    return {
      ...input.ref,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(attachment.fileName ? { name: attachment.fileName } : {}),
    };
  }

  /** Resolve an inbound Telegram ref to an absolute local file path. */
  async downloadAttachmentToLocal(
    input: ChannelAttachmentDownloadInput,
  ): Promise<import('../../adapter.js').ChannelInboundAttachment> {
    const agentName = agentNameForAdapter(input.clientName, this.defaultAgentName);
    const record = await this.options.store.get(agentName);
    if (!isUsableTelegramBinding(record)) throw new Error('Telegram binding is not configured');
    const downloader = this.downloaderFactory({
      botToken: record.botToken,
      scopeDirName: input.sessionId ?? input.clientName,
    });
    const kind = inferTelegramKindFromRef(input.ref);
    const a = await downloader.downloadAttachment(kind, input.ref);
    return {
      type: a.type === 'image' ? 'image' : 'file',
      filePath: a.filePath,
      fileName: a.fileName,
      mimeType: a.mimeType,
      ...(a.error ? { error: a.error } : {}),
    };
  }

  /**
   * Send a single media attachment, isolating per-media failures behind a
   * `[Media send failed: …]` text note.
   */
  private async sendOneMediaSafely(
    sender: TelegramSender,
    chatId: string,
    ref: OutboundMediaRef,
    messageThreadId?: string,
  ): Promise<void> {
    try {
      await sender.sendMedia(chatId, ref, messageThreadId);
    } catch (err) {
      const name = ref.name || basenamePath(ref.path) || ref.kind;
      logger.warn({ err, kind: ref.kind, name, chatId }, 'Telegram media send failed');
      try {
        await sender.sendText(chatId, `[媒体发送失败: ${name}]`, undefined, messageThreadId);
      } catch {
        /* placeholder is best-effort too */
      }
    }
  }

  /**
   * Render a pending permission ask into the bound Telegram conversation as
   * an inline-keyboard card (Allow / Deny / Always allow). Consumed by
   * {@link LocalChannelPermissionBridge.onPermissionAsk} via the shared
   * adapter registry.
   *
   * Degrades gracefully:
   *   - A missing, disabled, or mock-mode binding → text-only no-op so a
   *     half-configured agent cannot crash the permission ask path.
   *   - An oversize requestId that exceeds the 64-byte callback_data cap →
   *     `buildPermissionKeyboard` returns `undefined`; we still post the
   *     card text so the user sees the ask even if buttons are unavailable.
   *
   * The `outboundMessageId` carries the Bot API `message_id` of the rendered
   * card (when the send path returns one). The inbound side correlates
   * replies through the encoded `requestId` in `callback_data`, but the
   * message id lets the reply path PATCH the original card into its terminal
   * state (Allowed / Denied) and drop the inline keyboard once the ask is
   * settled. A send path that yields no message id degrades to `{}` — the
   * reply still resolves; only the card edit is skipped.
   */
  async renderPermission(input: {
    ctx: LocalChannelContext;
    renderable: ChannelRenderablePermission;
  }): Promise<{ outboundMessageId?: string }> {
    const agentName = agentNameForCtx(input.ctx, this.defaultAgentName);
    const record = await this.options.store.get(agentName);
    if (!isUsableTelegramBinding(record)) {
      // Mock-mode / unbound: degrade silently. The renderer-side UI still
      // shows the ask; the IM card is best-effort.
      return {};
    }
    if (!input.ctx.chatId) return {};
    const text = formatPermissionText(input.renderable);
    const markup = buildPermissionKeyboard(input.renderable.requestId);
    const sender = this.senderFactory(record.botToken);
    try {
      // Forum-topic routing: pass the ctx threadId through like the normal
      // reply path, so the card lands in the originating topic instead of
      // the General (top-level) chat. Absent → unchanged.
      const sent = await sender.sendText(input.ctx.chatId, text, markup, input.ctx.threadId);
      if (sent?.messageId !== undefined) {
        return { outboundMessageId: String(sent.messageId) };
      }
    } catch (err) {
      logger.warn(
        { err, requestId: input.renderable.requestId },
        'Telegram permission render failed',
      );
    }
    return {};
  }

  async tryHandleQuestionnaireReply(input: {
    ctx: LocalChannelContext;
    raw?: unknown;
  }): ReturnType<TelegramQuestionnaireRuntime['tryHandleReply']> {
    return this.questionnaires.tryHandleReply(input);
  }

  async settleQuestionnaireReply(input: {
    ctx: LocalChannelContext;
    requestId: string;
    outcome: QuestionnaireReplyOutcome;
  }): Promise<void> {
    await this.questionnaires.settleReply(input);
  }

  private async resolveQuestionnaireSender(
    ctx: LocalChannelContext,
  ): Promise<{ sender: TelegramSender; chatId: string } | null> {
    const agentName = agentNameForCtx(ctx, this.defaultAgentName);
    const record = await this.options.store.get(agentName);
    if (!isUsableTelegramBinding(record) || !ctx.chatId) return null;
    return { sender: this.senderFactory(record.botToken), chatId: ctx.chatId };
  }

  /**
   * Decode a Telegram update as a permission reply. Returns `null` when:
   *   - the inbound is not a `callback_query` (normal chat messages flow on),
   *   - the `callback_data` does not parse as a permission payload, or
   *   - the decoded `requestId` does not match the pending ask the bridge
   *     handed us (multi-instance isolation — sibling bots cannot resolve
   *     each other's pendings).
   *
   * On a hit, the click is acknowledged best-effort BEFORE the decode result
   * is returned: `answerCallbackQuery` stops the button spinner with a toast,
   * and the original card is edited into its terminal state (Allowed /
   * Denied, keyboard removed). This runs at decode time on purpose — even
   * when the route-side reply later no-ops (desktop UI settled the request
   * first), the card must still reach a terminal state. Acknowledgement
   * failures are swallowed; they never suppress the decoded reply.
   */
  async parsePermissionReply(input: {
    raw: unknown;
    pending: LocalChannelPermissionPending;
  }): Promise<{ behavior: ChannelPermissionBehavior } | null> {
    const raw = isRecord(input.raw) ? input.raw : {};
    const update = isRecord(raw.update) ? raw.update : raw;
    const callbackQuery = isRecord(update.callback_query) ? update.callback_query : undefined;
    if (!callbackQuery || typeof callbackQuery.data !== 'string') return null;
    const decoded = decodePermissionCallback(callbackQuery.data);
    if (!decoded) return null;
    if (decoded.requestId !== input.pending.requestId) return null;
    await this.acknowledgePermissionReply(callbackQuery, input.pending, decoded.decision);
    return { behavior: decoded.decision };
  }

  /**
   * Best-effort UX acknowledgement for a decoded permission click: toast via
   * `answerCallbackQuery`, then edit the rendered card into its terminal
   * state (text rebuilt from the pending snapshot + decision line, inline
   * keyboard dropped so a settled ask cannot be clicked again). Every
   * failure is swallowed — feedback must never block the reply resolution.
   */
  private async acknowledgePermissionReply(
    callbackQuery: Record<string, unknown>,
    pending: LocalChannelPermissionPending,
    decision: ChannelPermissionBehavior,
  ): Promise<void> {
    try {
      const agentName = agentNameForAdapter(pending.clientName, this.defaultAgentName);
      const record = await this.options.store.get(agentName);
      if (!isUsableTelegramBinding(record)) return;
      const sender = this.senderFactory(record.botToken);
      const label = permissionDecisionLabel(decision);
      const callbackQueryId = typeof callbackQuery.id === 'string' ? callbackQuery.id : undefined;
      if (callbackQueryId) {
        try {
          await sender.answerCallbackQuery(callbackQueryId, { text: label });
        } catch (err) {
          logger.warn(
            { err, requestId: pending.requestId },
            'Telegram permission answerCallbackQuery failed',
          );
        }
      }
      const messageId = pending.outboundMessageId ? Number(pending.outboundMessageId) : NaN;
      if (!Number.isFinite(messageId)) return;
      const text = `${formatPermissionText(toRenderablePermission(pending.request))}\n\n${permissionDecisionLine(decision)}`;
      try {
        await sender.editMessageText(pending.chatId, messageId, text);
      } catch (err) {
        logger.warn(
          { err, requestId: pending.requestId, chatId: pending.chatId },
          'Telegram permission card edit failed',
        );
      }
    } catch (err) {
      logger.warn(
        { err, requestId: pending.requestId },
        'Telegram permission reply acknowledgement failed',
      );
    }
  }

  /**
   * Push a `sendChatAction('typing')` and arm a 4 s refresh until
   * {@link notifyTurnEnd} stops it. Best-effort — every failure is swallowed;
   * typing must never surface to the turn. Telegram clears the action after
   * ~5 s, so we refresh slightly before that. Mirrors the historical
   * `TelegramChannelClient.notifyTurnStart` and the WeChat adapter's
   * implementation so both platforms behave identically.
   */
  async notifyTurnStart(ctx: LocalChannelContext): Promise<void> {
    const agentName = agentNameForCtx(ctx, this.defaultAgentName);
    const record = await this.options.store.get(agentName);
    if (!isUsableTelegramBinding(record)) return;
    if (!ctx.chatId) return;
    const sender = this.senderFactory(record.botToken);
    const chatId = ctx.chatId;
    const fire = async (): Promise<void> => {
      try {
        await sender.sendChatAction(chatId, 'typing');
      } catch {
        // best-effort: typing never surfaces to the turn.
      }
    };
    void fire();
    if (this.typingTimers.has(chatId)) return;
    const timer = setInterval(() => void fire(), 4000);
    if (typeof timer.unref === 'function') timer.unref();
    this.typingTimers.set(chatId, timer);
  }

  /**
   * Stop the typing-refresh timer armed by {@link notifyTurnStart}. Telegram
   * has no explicit "cancel typing" action — letting the last sent action
   * expire is the contract — so we only clear the timer here. Best-effort.
   */
  async notifyTurnEnd(ctx: LocalChannelContext): Promise<void> {
    if (!ctx.chatId) return;
    const timer = this.typingTimers.get(ctx.chatId);
    if (!timer) return;
    clearInterval(timer);
    this.typingTimers.delete(ctx.chatId);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Map a {@link ChannelInboundAttachmentRef} back to the Telegram-specific
 * kind so the downloader picks the right MIME fallback. `image` collapses
 * to `photo` (the dominant inbound kind); callers that need sticker / voice
 * disambiguation should construct the downloader directly.
 */
function inferTelegramKindFromRef(ref: ChannelInboundAttachmentRef): TelegramAttachmentKind {
  switch (ref.type) {
    case 'image':
      return 'photo';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    case 'file':
    default:
      return 'document';
  }
}

function maskToken(token: string): string {
  if (token.length <= 6) return '***';
  return `${token.slice(0, 3)}***${token.slice(-3)}`;
}

function basenamePath(path: string): string | undefined {
  const stripped = path.split('?')[0]?.split('#')[0] ?? '';
  const segment = stripped.replace(/^.*[\\/]/u, '');
  return segment.trim() || undefined;
}

/**
 * Flatten a {@link ChannelRenderablePermission} into the text body of the
 * Telegram card. Header + tool name are always present; description is
 * folded in only when distinct from the name (the route layer copies the
 * tool name into `toolDescription` when nothing better is available);
 * `reason` and the rule list each get their own blank-line-separated
 * paragraph so the card reads cleanly on a phone.
 */
function formatPermissionText(renderable: ChannelRenderablePermission): string {
  const lines: string[] = ['Permission request', `Tool: ${renderable.toolName}`];
  if (renderable.toolDescription && renderable.toolDescription !== renderable.toolName) {
    lines.push(renderable.toolDescription);
  }
  if (renderable.reason) {
    lines.push('');
    lines.push(renderable.reason);
  }
  if (renderable.ruleContents.length > 0) {
    lines.push('');
    for (const rule of renderable.ruleContents) {
      lines.push(`• ${rule}`);
    }
  }
  return lines.join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Short human label for a decoded permission decision (toast text). */
function permissionDecisionLabel(decision: ChannelPermissionBehavior): string {
  switch (decision) {
    case 'always':
      return 'Always allowed';
    case 'deny':
      return 'Denied';
    case 'allow':
    default:
      return 'Allowed';
  }
}

/** Terminal status line appended to the card text after a decision. */
function permissionDecisionLine(decision: ChannelPermissionBehavior): string {
  return decision === 'deny'
    ? `🚫 ${permissionDecisionLabel(decision)}`
    : `✅ ${permissionDecisionLabel(decision)}`;
}
