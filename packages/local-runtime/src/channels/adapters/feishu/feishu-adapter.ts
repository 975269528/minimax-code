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
import type { ChannelInboundAttachmentRef, ChannelInboundEnvelope } from '../../envelope.js';
import type { LocalChannelContext, LocalChannelPreflightResult } from '../../infra.js';
import type { ChannelPlatform } from '../../route-api.js';
import {
  type FeishuAttachmentDownloader,
  type LocalFeishuBindingRecord,
  type LocalFeishuChannelStore,
  feishuClientId,
  feishuMessageSnapshotToQuotedMessage,
  parseLocalFeishuEvent,
} from '../../feishu.js';
import type { LocalMessageQuotedMessage } from '../../../messages/input.js';
import {
  buildQuestionnaireCard,
  buildReplyCard,
  unwrapMaybeEncryptedFeishuEvent,
} from './feishu-card.js';
import { buildPermissionCard, extractPermissionActionValue } from './feishu-permission-card.js';
import type {
  ChannelPermissionBehavior,
  ChannelRenderablePermission,
  LocalChannelPermissionPending,
} from '../../permission-bridge.js';
import { FeishuSender, type FeishuSenderOptions, type FeishuThreadReply } from './feishu-sender.js';
import { enrichFeishuSenderName } from './feishu-sender-name.js';
import {
  type FeishuPendingReactionStore,
  type FeishuPendingThinkingStore,
  type FeishuWsAttachmentDownloader,
  makeFeishuWsAttachmentDownloader,
  removeAckReaction,
  startFeishuEventDispatcher,
} from './feishu-ws.js';
import {
  errorMessage,
  isUsableFeishuBinding,
  normalizeMode,
  pickString,
} from './feishu-adapter-utils.js';
import { imLogger as logger } from '../../../common/im-logger.js';

/**
 * Unified Feishu / Lark platform adapter. Composes:
 *   - bind/unbind/status → `LocalFeishuChannelStore`
 *   - inbound parsing    → `unwrapMaybeEncryptedFeishuEvent` + `parseLocalFeishuEvent`
 *   - outbound delivery  → `FeishuSender`
 *   - card builders      → `feishu-card.ts`
 *   - WS long-connection → dynamic `@larksuiteoapi/node-sdk` (factory-injected)
 *   - multimodal inbound → `FeishuWsAttachmentDownloader`
 *
 * Multi-instance is honoured by the registry layer (keyed on
 * `${platform}:${clientName}`).
 */

/** Tiny shape we need out of the lark SDK's `WSClient`. */
export interface FeishuWsClientLike {
  start(input: { eventDispatcher?: unknown }): Promise<void> | void;
  close?(): Promise<void> | void;
}

/**
 * Shape of the object the lark-suite SDK's `WSClient` accepts as its
 * `logger` constructor param (mirrors its internal `Logger` interface).
 * We build one of these from our pino facade so every WS lifecycle
 * event that the SDK emits (`[ws] ws connect success`, `[ws] reconnect`,
 * `[ws] client closed`, `[ws] ws error`, `[ws] unable to connect after
 * N tries`) shows up in our engineering logs as a safe lifecycle event,
 * without needing SDK patches.
 */
export interface FeishuSdkLoggerBridge {
  error: (...msg: unknown[]) => void;
  warn: (...msg: unknown[]) => void;
  info: (...msg: unknown[]) => void;
  debug: (...msg: unknown[]) => void;
  trace: (...msg: unknown[]) => void;
}

/**
 * Build a {@link FeishuSdkLoggerBridge} for a specific per-agent WS
 * client. The bridge:
 *
 *   1. emits a stable `{ source, agentName, event }` record instead of
 *      SDK-provided text;
 *   2. promotes `[ws] client closed`, `[ws] ws connect success`, and
 *      `[ws] reconnect success` from SDK debug to our info level so
 *      the important runtime lifecycle transitions land at the default
 *      log level (they would otherwise be silent by default);
 *   3. updates the adapter's `wsStatus` on the transitions we can
 *      detect from string matching:
 *        - `error` on SDK error (unless we're already reconnecting)
 *        - `connecting` on `[ws] reconnect` (started reconnection loop)
 *        - `connected` on `[ws] reconnect success`
 *        - `idle` on `[ws] client closed`
 *      so the status API stops echoing "connected: true" during a
 *      reconnect window;
 *   4. drops SDK trace (ping/pong internals) — high volume, low signal.
 *
 * Exported so the SDK-log-to-pino contract can be unit-tested without
 * pulling in the real `@larksuiteoapi/node-sdk` (which requires network
 * to actually connect).
 */
export function buildFeishuSdkLoggerBridge(input: {
  agentName: string;
  getStatus: () => FeishuWsStatusInfo['status'];
  setStatus: (next: FeishuWsStatusInfo['status'], lastError?: string | undefined) => void;
}): FeishuSdkLoggerBridge {
  const { agentName, getStatus, setStatus } = input;
  const bridgeCtx = { source: 'feishu-sdk' as const, agentName };
  const logMessage = 'Feishu SDK lifecycle event';
  const stringify = (msg: unknown[]): string =>
    msg
      .map((m) => {
        if (typeof m === 'string') return m;
        if (m instanceof Error) return m.message;
        try {
          return JSON.stringify(m);
        } catch {
          return String(m);
        }
      })
      .join(' ');
  return {
    error: (...msg: unknown[]) => {
      const rendered = stringify(msg);
      logger.error({ ...bridgeCtx, event: 'sdk_error' }, logMessage);
      // Surface into wsStatus so the status API + retry decisions see
      // "the SDK just yelled at us". Only overwrite the connected state
      // — if we're already reconnecting, a downstream SDK-side warning
      // is part of that loop, not a fresh terminal error.
      if (getStatus() === 'connected') {
        setStatus('error', rendered);
      }
    },
    warn: () => {
      logger.warn({ ...bridgeCtx, event: 'sdk_warning' }, logMessage);
    },
    info: (...msg: unknown[]) => {
      const rendered = stringify(msg);
      const isReconnectStarted = rendered.includes('reconnect') && !rendered.includes('success');
      logger.info(
        { ...bridgeCtx, event: isReconnectStarted ? 'reconnect_started' : 'sdk_info' },
        logMessage,
      );
      // `[ws] reconnect` fires when the SDK gives up the current socket
      // and starts a reconnection loop. Flip our status so callers stop
      // echoing 'connected' during the retry window.
      if (isReconnectStarted) {
        if (getStatus() === 'connected') {
          setStatus('connecting', rendered);
        }
      }
    },
    debug: (...msg: unknown[]) => {
      const rendered = stringify(msg);
      if (rendered.includes('client closed')) {
        logger.info({ ...bridgeCtx, event: 'client_closed' }, logMessage);
        if (getStatus() !== 'idle') {
          setStatus('idle', undefined);
        }
      } else if (rendered.includes('reconnect success')) {
        logger.info({ ...bridgeCtx, event: 'reconnect_succeeded' }, logMessage);
        setStatus('connected', undefined);
      } else if (rendered.includes('ws connect success')) {
        logger.info({ ...bridgeCtx, event: 'connect_succeeded' }, logMessage);
      } else {
        logger.info({ ...bridgeCtx, event: 'sdk_info' }, logMessage);
      }
    },
    trace: () => {
      // Ping/pong internals — high volume, low signal. Dropped.
    },
  };
}

export interface FeishuWsClientFactoryInput {
  appId: string;
  appSecret: string;
  /** App domain — Feishu CN ("feishu.cn") vs Lark Intl ("larksuite.com"). */
  domain?: string;
}

/**
 * Factory the host wiring layer provides to materialise a WS client. Pass
 * `false` to disable WS entirely (the adapter still works over webhook + mock).
 */
export type FeishuWsClientFactory =
  | ((input: FeishuWsClientFactoryInput) => Promise<FeishuWsClientLike>)
  | false;

/**
 * Live, in-memory WS transport state for one adapter instance. Complements
 * the persisted binding record's `connected: true` (which only says "bind
 * succeeded at some point") with what the transport is doing *right now*:
 *
 *   - `idle`       — no WS running (never started, preconditions unmet,
 *                    factory disabled, or torn down via `invalidateTransport`).
 *   - `connecting` — `startWebSocket` in flight.
 *   - `connected`  — `startWebSocket` completed and the SDK client started.
 *   - `error`      — the last `startWebSocket` threw; `lastError` carries the
 *                    error message (never credentials or message bodies).
 *
 * Not persisted — a process restart resets to `idle` until the restore pass
 * re-attempts the connection.
 */
export interface FeishuWsStatusInfo {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  lastError?: string;
}

export interface FeishuPlatformAdapterOptions {
  /** Default agent name used by inbound parsing when the body omits one. */
  defaultAgentName?: string;
  /** Optional client-name override; defaults to `feishuClientId(agentName)`. */
  clientName?: string;
  /** Injectable sender constructor options. */
  senderOptions?: FeishuSenderOptions;
  /** Optional attachment downloader (webhook path). */
  attachmentDownloader?: FeishuAttachmentDownloader;
  /** WS factory or `false` to disable. Defaults to a deferred dynamic import. */
  wsClientFactory?: FeishuWsClientFactory;
  /** Fired after `sendMessage` delivered a Card 2.0 form questionnaire. */
  onQuestionnaireRendered?: (input: {
    chatId: string;
    request: import('@mavis/shared/questionnaire').AskQuestionnaireRequest;
    messageId: string;
  }) => void;
  /**
   * Fired after {@link FeishuPlatformAdapter.renderPermission} delivered a
   * permission card. Mirrors {@link onQuestionnaireRendered} so the host can
   * record a `requestId`-keyed pending entry (chatId + messageId + renderable)
   * for the card-action HTTP handler to resolve the click and PATCH the card
   * into its terminal state — the Feishu card-action path does NOT flow through
   * the runner's `dispatchInbound`, so it cannot reuse the bridge's chatId-keyed
   * pending map.
   */
  onPermissionRendered?: (input: {
    chatId: string;
    renderable: ChannelRenderablePermission;
    messageId: string;
  }) => void;
  /** Shared store of pending "🤔 Thinking…" card ids (keyed by chatId). */
  pendingThinkingStore?: FeishuPendingThinkingStore;
  /**
   * Shared store of pending 👀 `OnIt` ack reactions (keyed by inbound
   * messageId). Written by the WS dispatcher, consumed by `sendMessage` to
   * revoke the ack once the final reply has been delivered.
   */
  pendingReactionStore?: FeishuPendingReactionStore;
  /** Bot display name forwarded to the thinking card header. */
  botName?: string;
  /** WS-side downloader for multimodal inbound (image/file/audio/video). */
  wsAttachmentDownloader?: FeishuWsAttachmentDownloader;
  /** Fired after bind persists a binding so host can register exact outbound. */
  onBindingChanged?: (record: LocalFeishuBindingRecord) => void | Promise<void>;
}

/**
 * Concrete adapter instance bound to a single agentName. Re-bind through
 * the store rotates credentials in-place; the cached sender + WS client are
 * torn down so the next call uses the fresh values.
 */
export class FeishuPlatformAdapter implements LocalChannelPlatformAdapter {
  readonly platform: ChannelPlatform = 'feishu';
  readonly clientName: string;

  private readonly store: LocalFeishuChannelStore;
  private readonly agentName: string;
  private readonly defaultAgentName: string;
  private readonly senderOptions: FeishuSenderOptions;
  private readonly wsClientFactory: FeishuWsClientFactory;
  private readonly onQuestionnaireRendered?: FeishuPlatformAdapterOptions['onQuestionnaireRendered'];
  private readonly onPermissionRendered?: FeishuPlatformAdapterOptions['onPermissionRendered'];
  private readonly onBindingChanged?: FeishuPlatformAdapterOptions['onBindingChanged'];
  private readonly pendingThinkingStore?: FeishuPendingThinkingStore;
  private readonly pendingReactionStore?: FeishuPendingReactionStore;
  private readonly botName?: string;
  private wsAttachmentDownloader?: FeishuWsAttachmentDownloader;
  readonly attachmentDownloader?: FeishuAttachmentDownloader;

  private sender: FeishuSender | undefined;
  private senderForCredentials: { appId: string; appSecret: string } | undefined;
  private wsClient: FeishuWsClientLike | undefined;
  /** Live WS transport state — see {@link FeishuWsStatusInfo}. */
  private wsStatus: FeishuWsStatusInfo['status'] = 'idle';
  private wsLastError?: string;

  constructor(
    input: { store: LocalFeishuChannelStore; agentName: string },
    options: FeishuPlatformAdapterOptions = {},
  ) {
    this.store = input.store;
    this.agentName = input.agentName.trim() || 'mavis';
    this.defaultAgentName = options.defaultAgentName ?? this.agentName;
    this.clientName = options.clientName ?? feishuClientId(this.agentName);
    this.senderOptions = options.senderOptions ?? {};
    this.wsClientFactory =
      options.wsClientFactory ??
      (async (factoryInput) => {
        const sdkSpecifier = '@larksuiteoapi/node-sdk';
        const sdk = (await import(sdkSpecifier)) as unknown as {
          WSClient: new (config: {
            appId: string;
            appSecret: string;
            domain?: string;
            logger?: FeishuSdkLoggerBridge;
          }) => FeishuWsClientLike;
        };
        // Bridge the SDK's internal logger into our pino facade so every
        // runtime WS lifecycle event (connect success/failure, reconnect
        // attempts, close, error, `unable to connect after N tries`) is
        // captured with the same trace context, agentName tag, and disk
        // fan-out as the rest of local-runtime.
        //
        // Without this bridge the SDK writes to `console.*` — those lines
        // never make it into the diagnostic bundle, so a user reporting
        // "WS drops mid-session" would give us zero evidence to inspect.
        const sdkLogger = buildFeishuSdkLoggerBridge({
          agentName: this.agentName,
          getStatus: () => this.wsStatus,
          setStatus: (next, err) => {
            this.wsStatus = next;
            if (err !== undefined) this.wsLastError = err;
          },
        });
        return new sdk.WSClient({
          appId: factoryInput.appId,
          appSecret: factoryInput.appSecret,
          ...(factoryInput.domain ? { domain: factoryInput.domain } : {}),
          logger: sdkLogger,
        });
      });
    if (options.attachmentDownloader) {
      this.attachmentDownloader = options.attachmentDownloader;
    }
    if (options.onQuestionnaireRendered) {
      this.onQuestionnaireRendered = options.onQuestionnaireRendered;
    }
    if (options.onPermissionRendered) {
      this.onPermissionRendered = options.onPermissionRendered;
    }
    if (options.onBindingChanged) {
      this.onBindingChanged = options.onBindingChanged;
    }
    if (options.pendingThinkingStore) {
      this.pendingThinkingStore = options.pendingThinkingStore;
    }
    if (options.pendingReactionStore) {
      this.pendingReactionStore = options.pendingReactionStore;
    }
    if (options.botName) {
      this.botName = options.botName;
    }
    if (options.wsAttachmentDownloader) {
      this.wsAttachmentDownloader = options.wsAttachmentDownloader;
    }
  }

  async bind(input: ChannelBindInput): Promise<ChannelBindResult> {
    const credentials = input.credentials ?? {};
    const appId = pickString(credentials, ['appId', 'app_id']);
    const appSecret = pickString(credentials, ['appSecret', 'app_secret']);
    if (!appId || !appSecret) {
      return {
        ok: false,
        clientName: this.clientName,
        error: 'appId and appSecret are required',
        code: 'VALIDATION_ERROR',
      };
    }
    const agentName = input.agentName?.trim() || this.agentName;
    const requestedMode = pickString(credentials, ['mode'])?.toLowerCase();
    if (requestedMode === 'mock') {
      return {
        ok: false,
        clientName: this.clientName,
        error: 'mock channel mode is not supported',
        code: 'CHANNEL_MOCK_MODE_UNSUPPORTED',
      };
    }
    if (requestedMode && !['webhook', 'websocket', 'ws'].includes(requestedMode)) {
      return {
        ok: false,
        clientName: this.clientName,
        error: 'unsupported channel mode',
        code: 'VALIDATION_ERROR',
      };
    }
    const mode = normalizeMode(requestedMode);
    const pick = (keys: string[]) => pickString(credentials, keys);
    const verificationToken = pick(['verificationToken', 'verification_token', 'token']);
    const encryptKey = pick(['encryptKey', 'encrypt_key', 'encryptToken', 'encrypt_token']);
    const botName = pick(['botName', 'bot_name']);
    const record = await this.store.bind({
      agentName,
      appId,
      appSecret,
      ...(verificationToken ? { verificationToken } : {}),
      ...(encryptKey ? { encryptKey } : {}),
      ...(botName ? { botName } : {}),
      mode,
    });
    // Plan §5.2: a staged / non-winner primary-family record starts nothing.
    // Only the reconciler's winner and the single startup restore may.
    if (record.enabled === false || (await this.store.isPrimaryFamilyAgent(agentName))) {
      logger.info(
        { agentName, platform: 'feishu', clientName: this.clientName },
        'Feishu bind transport start delegated to family reconciler',
      );
      return { ok: true, clientName: this.clientName };
    }
    await this.onBindingChanged?.(record);
    // Invalidate cached transport on credential change so the next send mints
    // a fresh tenant_access_token + (optionally) a fresh WS client.
    this.invalidateTransport();
    if (record.mode === 'websocket' && this.wsClientFactory !== false) {
      try {
        await this.ensureWsClient(record);
      } catch {
        /* swallow — bind succeeds regardless of WS availability */
      }
    }
    return {
      ok: true,
      clientName: this.clientName,
    };
  }

  async unbind(input: ChannelUnbindInput): Promise<ChannelUnbindResult> {
    const agentName = input.agentName?.trim() || this.agentName;
    const ok = await this.store.unbind(agentName);
    this.invalidateTransport();
    return { ok };
  }

  async status(input?: ChannelStatusInput): Promise<ChannelStatusResult> {
    const agentName = input?.agentName?.trim() || this.agentName;
    const record = await this.store.get(agentName);
    const configured = isUsableFeishuBinding(record);
    // Prefer the bot's real Feishu app name (fetched live, cached) over the
    // placeholder label stored at onboard time. Best-effort: fall back to the
    // stored botName if the lookup is unavailable (permissions / offline).
    let botName = record?.botName;
    if (record && configured) {
      const liveName = await this.resolveBotName(record);
      if (liveName) botName = liveName;
    }
    return {
      configured,
      connected: Boolean(record?.connected && record?.enabled),
      clientName: this.clientName,
      detail: record
        ? {
            mode: record.mode,
            enabled: record.enabled,
            hasEncryptKey: Boolean(record.encryptKey),
            hasVerificationToken: Boolean(record.verificationToken),
            ...(botName ? { botName } : {}),
          }
        : { mode: 'unconfigured' },
    };
  }

  /**
   * Decode an inbound webhook body (already-parsed JSON) into the canonical
   * envelope. Handles the encrypt envelope before delegating to the
   * existing `parseLocalFeishuEvent` so this adapter remains the single
   * entry point that knows about Feishu's transport peculiarities.
   *
   * Throws when the body is unrecoverable (decrypt failed, no message
   * shape). The caller — the infra route handler — translates the throw
   * into a 4xx response so a misconfigured webhook fails fast.
   */
  async normalizeInbound(input: PlatformInboundInput): Promise<ChannelInboundEnvelope> {
    const record = await this.store.get(this.agentName);
    const body =
      input.raw && typeof input.raw === 'object' && !Array.isArray(input.raw)
        ? (input.raw as Record<string, unknown>)
        : {};
    const unwrapped = unwrapMaybeEncryptedFeishuEvent(body, record?.encryptKey);
    if (!unwrapped) {
      throw new Error('feishu inbound encrypt payload could not be decoded');
    }
    const enriched = isUsableFeishuBinding(record)
      ? await enrichFeishuSenderName(unwrapped, this.ensureSender(record))
      : unwrapped;
    const botIdentity = isUsableFeishuBinding(record)
      ? await this.ensureSender(record).getBotIdentity()
      : undefined;
    const resolvedBotIdentity = botIdentity
      ? {
          ...botIdentity,
          ...(!botIdentity.name && record?.botName ? { name: record.botName } : {}),
        }
      : record?.botName
        ? { name: record.botName }
        : undefined;
    const envelope = parseLocalFeishuEvent(enriched, this.defaultAgentName, resolvedBotIdentity);
    if ('error' in envelope) {
      throw new Error('feishu inbound payload is not a recognised message event');
    }
    // The parser fills `clientName` from the body; override here so a
    // multi-instance host always sees this adapter's own client name on the
    // envelope (parser is shared across the legacy webhook route too).
    envelope.ctx.clientName = this.clientName;
    const quotedMessage = await this.resolveQuotedMessageForEnvelope(envelope, record);
    if (quotedMessage) envelope.quotedMessage = quotedMessage;
    return envelope;
  }

  async resolveQuotedMessageByThreadId(
    threadId: string,
  ): Promise<LocalMessageQuotedMessage | undefined> {
    const record = await this.store.get(this.agentName);
    return this.resolveQuotedMessageFromRecord(threadId, record);
  }

  /**
   * Resolve the bot's real Feishu display name (app name) for a binding record.
   * Best-effort: returns `undefined` when credentials are missing or the live
   * lookup fails, so callers keep the stored placeholder.
   */
  async resolveBotName(record: LocalFeishuBindingRecord): Promise<string | undefined> {
    if (!isUsableFeishuBinding(record)) return undefined;
    try {
      return await this.ensureSender(record).getBotName();
    } catch {
      return undefined;
    }
  }

  /**
   * Compute the thread-reply option for an outbound send. When the ctx lives
   * inside a Feishu thread/topic (`ctx.threadId` set) AND we hold a concrete
   * anchor message ID inside that thread, the send is routed through the
   * `reply` endpoint (`reply_in_thread`). The anchor prefers the triggering
   * message ID; falls back to the pending thinking card's inbound message ID.
   * No threadId / no anchor → `undefined` (top-level send, unchanged).
   * Shared by {@link sendMessage} and {@link renderPermission} so permission
   * cards route exactly like normal replies.
   */
  private resolveThreadReply(ctx: LocalChannelContext): FeishuThreadReply | undefined {
    const threadAnchorId =
      ctx.sourceMessageId ?? this.pendingThinkingStore?.get(ctx.chatId)?.inboundMessageId;
    return ctx.threadId && threadAnchorId ? { replyToMessageId: threadAnchorId } : undefined;
  }

  /**
   * Send an outbound message. The three message parts (`text` / `media` /
   * `questionnaire`) are additive per the contract:
   *   - `questionnaire` present → interactive card first
   *   - then per-media uploads (best-effort: one failure does not block
   *     the others, but the overall result reports the FIRST error so the
   *     caller's retry policy still kicks in)
   *   - then plain text (if non-empty)
   *
   * Returns the platform message id of the LAST successful send, or
   * `'error'` status with the first failure surfaced.
   */
  async sendMessage(input: ChannelOutboundMessageInput): Promise<ChannelOutboundResult> {
    const executionFailure = Boolean(input.error);
    const outbound = prepareChannelOutboundMessage(input);
    const record = await this.store.get(this.agentName);
    if (!isUsableFeishuBinding(record)) {
      return {
        id: '',
        status: 'error',
        error: 'feishu binding is not configured',
      };
    }
    const sender = this.ensureSender(record);
    const chatId = outbound.ctx.chatId;
    let lastId = '';
    let firstError: string | undefined;

    // Thread-aware reply: when the inbound message lived inside a Feishu
    // thread/topic (`ctx.threadId` set), route every outbound send through the
    // `reply` endpoint anchored on a message ID inside that thread, so the
    // reply lands in the thread instead of the top-level conversation.
    const thread = this.resolveThreadReply(outbound.ctx);

    // Inbound message id whose 👀 `OnIt` ack reaction should be revoked once
    // the reply is delivered. MUST be resolved before the questionnaire path
    // below deletes the pending thinking card (its `inboundMessageId` is the
    // fallback when the ctx carries no `sourceMessageId`).
    const ackInboundMessageId =
      outbound.ctx.sourceMessageId ?? this.pendingThinkingStore?.get(chatId)?.inboundMessageId;
    const revokeAckReaction = () =>
      removeAckReaction({
        store: this.pendingReactionStore,
        inboundMessageId: ackInboundMessageId,
        remove: (m, r) => sender.removeReaction(m, r),
      });

    if (outbound.questionnaire) {
      try {
        const card = buildQuestionnaireCard(outbound.questionnaire);
        // Consume any pending "🤔 Thinking…" grey card by patching it into
        // the questionnaire card so the chat stays at one bubble per turn.
        const pendingThinking = this.pendingThinkingStore?.get(chatId);
        let messageId: string | undefined;
        if (pendingThinking) {
          this.pendingThinkingStore?.delete(chatId);
          try {
            await sender.patchCard(pendingThinking.messageId, card);
            messageId = pendingThinking.messageId;
          } catch {
            /* patch failed — fall through to fresh card send */
          }
        }
        if (!messageId) {
          const result = await sender.sendCard(chatId, card, 'chat_id', thread);
          messageId = result?.messageId;
        }
        if (messageId) {
          lastId = messageId;
          this.onQuestionnaireRendered?.({
            chatId,
            request: outbound.questionnaire,
            messageId,
          });
          // Questionnaire delivered — revoke the 👀 inbound ack reaction.
          await revokeAckReaction();
        }
      } catch (err) {
        firstError ??= errorMessage(err);
      }
    }

    if (outbound.media && outbound.media.length > 0) {
      for (const ref of outbound.media) {
        try {
          const result = await sender.sendMedia(chatId, ref, 'chat_id', thread);
          if (result?.messageId) lastId = result.messageId;
        } catch (err) {
          firstError ??= errorMessage(err);
        }
      }
    }

    // Feishu Card 2.0 form already carries the question text inside the card.
    // Avoid double-posting a tail text when a questionnaire is rendered —
    // historical behaviour (`feat/im-genui-full-mr`) was card-only.
    if (outbound.text.trim() && !outbound.questionnaire) {
      try {
        // Wrap the reply text in a Card 2.0 "Reply" card (green header,
        // `chat_outlined` icon, `Reply` tag) to match the historical
        // `feat/im-genui-full-mr` style. Plain `msg_type: text` would show as
        // a bare text bubble — inconsistent with how Ask user / media render.
        const replyCard = buildReplyCard(outbound.text);
        let patchedFailureReply = false;
        if (executionFailure) {
          const pendingThinking = this.pendingThinkingStore?.get(chatId);
          if (pendingThinking) {
            this.pendingThinkingStore?.delete(chatId);
            try {
              await sender.patchCard(pendingThinking.messageId, replyCard);
              lastId = pendingThinking.messageId;
              patchedFailureReply = true;
            } catch {
              // The pre-existing card may have expired. Fall through to a
              // thread-aware fresh reply so the failure remains visible.
            }
          }
        }
        if (!patchedFailureReply) {
          const result = await sender.sendCard(chatId, replyCard, 'chat_id', thread);
          if (result?.messageId) lastId = result.messageId;
        }
        // Reply card delivered — revoke the 👀 inbound ack reaction.
        await revokeAckReaction();
      } catch (err) {
        firstError ??= errorMessage(err);
      }
    }

    if (firstError) {
      return {
        id: lastId,
        status: 'error',
        error: firstError,
      };
    }
    return { id: lastId, status: 'sent' };
  }

  private async resolveQuotedMessageForEnvelope(
    envelope: ChannelInboundEnvelope & { quotedThreadId?: string },
    record: LocalFeishuBindingRecord | undefined,
  ): Promise<LocalMessageQuotedMessage | undefined> {
    if (envelope.quotedMessage || !envelope.quotedThreadId) {
      logger.info(
        {
          clientName: this.clientName,
          hasQuoted: !!envelope.quotedMessage,
          quotedThreadId: envelope.quotedThreadId ?? null,
          threadId: envelope.ctx.threadId ?? null,
        },
        'Feishu inbound: no thread to resolve',
      );
      return envelope.quotedMessage;
    }
    return this.resolveQuotedMessageFromRecord(envelope.quotedThreadId, record);
  }

  private async resolveQuotedMessageFromRecord(
    threadId: string,
    record: LocalFeishuBindingRecord | undefined,
  ): Promise<LocalMessageQuotedMessage | undefined> {
    if (!isUsableFeishuBinding(record)) return undefined;
    try {
      // The inbound event carries a thread id (`omt_…`), not a message id, so
      // the topic root must be fetched via the thread-container listing.
      const snapshot = await this.ensureSender(record).getThreadRootMessage(threadId);
      const quoted = feishuMessageSnapshotToQuotedMessage(snapshot);
      logger.info(
        {
          clientName: this.clientName,
          threadId,
          resolved: !!quoted,
          hasSnapshot: !!snapshot,
        },
        'Feishu quoted context resolved',
      );
      return quoted;
    } catch (err) {
      // Best-effort only. Missing `im:message:readonly` or an expired message
      // should not block the user's current inbound turn — but surface it in
      // logs so a permissions gap is diagnosable instead of silently dropped.
      logger.warn(
        {
          clientName: this.clientName,
          threadId,
          status: (err as { status?: number } | undefined)?.status,
          err: errorMessage(err),
        },
        'Feishu quoted context lookup failed',
      );
      return undefined;
    }
  }

  async downloadAttachment(
    input: ChannelAttachmentDownloadInput,
  ): Promise<ChannelInboundAttachmentRef> {
    const record = await this.store.get(this.agentName);
    if (!isUsableFeishuBinding(record)) {
      throw new Error('feishu attachment downloader: binding not configured');
    }
    if (!this.attachmentDownloader) {
      throw new Error('feishu adapter has no attachment downloader configured');
    }
    const filePath = await this.attachmentDownloader({
      messageId: input.messageId ?? input.ref.key,
      fileKey: input.ref.key,
      type: input.ref.type,
      sessionId: input.sessionId ?? input.clientName,
    });
    return { ...input.ref, key: filePath };
  }

  /** Resolve an inbound ref to a local file via the WS-shape downloader. */
  async downloadAttachmentToLocal(
    input: ChannelAttachmentDownloadInput,
  ): Promise<import('../../adapter.js').ChannelInboundAttachment> {
    const record = await this.store.get(this.agentName);
    if (!isUsableFeishuBinding(record)) {
      throw new Error('feishu attachment downloader: binding not configured');
    }
    if (!this.wsAttachmentDownloader)
      throw new Error('feishu adapter: wsAttachmentDownloader not wired');
    if (!input.messageId) throw new Error('feishu adapter: messageId required');
    const a = await this.wsAttachmentDownloader({
      messageId: input.messageId,
      ref: input.ref,
      sessionId: input.sessionId ?? input.clientName,
    });
    return {
      type: a.type === 'image' ? 'image' : 'file',
      filePath: a.filePath,
      fileName: a.fileName,
      mimeType: a.mimeType,
    };
  }

  /**
   * Build a {@link FeishuWsAttachmentDownloader} bound to this adapter's
   * sender (lazy, so token cache + retry policy are shared with outbound
   * delivery). `dataDir` is supplied by the host so attachments land under
   * the runtime's data root.
   */
  buildAttachmentDownloader(dataDir: () => string): FeishuWsAttachmentDownloader {
    return makeFeishuWsAttachmentDownloader({
      senderProvider: async () => {
        const record = await this.store.get(this.agentName);
        if (!isUsableFeishuBinding(record)) {
          throw new Error('feishu attachment downloader: binding not configured');
        }
        return this.ensureSender(record);
      },
      dataDir,
    });
  }

  /** Wire a WS-side attachment downloader after construction (host calls this). */
  setWsAttachmentDownloader(downloader: FeishuWsAttachmentDownloader): void {
    this.wsAttachmentDownloader = downloader;
  }

  async patchCard(messageId: string, card: object): Promise<void> {
    const record = await this.store.get(this.agentName);
    if (!isUsableFeishuBinding(record)) throw new Error('feishu patchCard: not bound');
    await this.ensureSender(record).patchCard(messageId, card);
  }

  /**
   * Render a pending permission ask into the bound Feishu conversation as an
   * interactive Card 2.0 (Allow once / Always allow / Deny). Consumed by
   * {@link LocalChannelPermissionBridge.onPermissionAsk} via the shared adapter
   * registry.
   *
   * Degrades gracefully:
   *   - A missing, disabled, or mock-mode binding → text-only no-op so a
   *     half-configured agent cannot crash the permission ask path (the
   *     desktop UI still shows the ask; the IM card is best-effort).
   *   - A send failure is swallowed and reported as `{}` — the reply can still
   *     resolve through the UI; only the card is missing.
   *
   * The returned `outboundMessageId` is the Feishu message id of the rendered
   * card. It is also forwarded through {@link onPermissionRendered} so the host
   * can record a `requestId`-keyed pending entry the card-action HTTP handler
   * uses to PATCH the card into its terminal state.
   */
  async renderPermission(input: {
    ctx: LocalChannelContext;
    renderable: ChannelRenderablePermission;
  }): Promise<{ outboundMessageId?: string }> {
    const record = await this.store.get(this.agentName);
    if (!isUsableFeishuBinding(record)) {
      // Unbound / mock-mode: degrade silently (best-effort IM surface).
      return {};
    }
    const chatId = input.ctx.chatId;
    if (!chatId) return {};
    try {
      const card = buildPermissionCard(input.renderable, this.botName);
      // Thread-aware delivery: same anchor resolution as `sendMessage`, so a
      // thread-originated ask renders its card inside the thread instead of
      // the top-level conversation. Non-thread ctx → undefined → unchanged.
      const thread = this.resolveThreadReply(input.ctx);
      const result = await this.ensureSender(record).sendCard(chatId, card, 'chat_id', thread);
      const messageId = result?.messageId;
      if (messageId) {
        this.onPermissionRendered?.({ chatId, renderable: input.renderable, messageId });
        return { outboundMessageId: messageId };
      }
    } catch (err) {
      logger.warn(
        {
          err: errorMessage(err),
          requestId: input.renderable.requestId,
          clientName: this.clientName,
        },
        'Feishu permission render failed',
      );
    }
    return {};
  }

  /**
   * Decode a Feishu card-action event as a permission reply for the given
   * pending ask. Returns `null` when the action is not a permission click
   * (`kind !== 'permission_action'` — e.g. a questionnaire submit) or when the
   * decoded `requestId` does not match the pending the caller handed us
   * (requestId isolation — mirrors the Telegram adapter, so a sibling card can
   * never resolve another request). Pure decode with no side effects; the
   * terminal-card PATCH is owned by the card-action HTTP handler.
   */
  async parsePermissionReply(input: {
    raw: unknown;
    pending: LocalChannelPermissionPending;
  }): Promise<{ behavior: ChannelPermissionBehavior } | null> {
    const value = extractPermissionActionValue(input.raw);
    if (!value) return null;
    if (value.requestId !== input.pending.requestId) return null;
    return { behavior: value.behavior };
  }

  async startWebSocket(input: {
    dispatchInbound: (message: {
      ctx: ChannelInboundEnvelope['ctx'];
      text: string;
      eventId?: string;
      attachments?: import('../../../messages/input.js').LocalMessageAttachment[];
      quotedMessage?: LocalMessageQuotedMessage;
      preflight?: Extract<LocalChannelPreflightResult, { allowed: true }>['token'];
    }) => Promise<unknown>;
    preflightInbound?: (input: {
      ctx: ChannelInboundEnvelope['ctx'];
      text: string;
      eventId?: string;
    }) => Promise<LocalChannelPreflightResult>;
    onCardAction?: (data: unknown) => Promise<unknown> | unknown;
  }): Promise<boolean> {
    // Track the live transport state so status APIs stop echoing only the
    // persisted `connected: true` (which is bind-time, not transport-time).
    const prevStatus = this.wsStatus;
    this.wsStatus = 'connecting';
    this.wsLastError = undefined;
    logger.info(
      { agentName: this.agentName, platform: 'feishu', prevStatus },
      'Feishu WS start attempt',
    );
    const record = await this.store.get(this.agentName);
    if (!isUsableFeishuBinding(record)) {
      logger.info(
        {
          agentName: this.agentName,
          platform: 'feishu',
          hasRecord: Boolean(record),
          mode: record?.mode ?? null,
          hasAppId: Boolean(record?.appId),
          hasAppSecret: Boolean(record?.appSecret),
        },
        'Feishu WS start skipped: binding is not usable',
      );
      this.wsStatus = 'idle';
      return false;
    }
    if (this.wsClientFactory === false) {
      logger.info(
        { agentName: this.agentName, platform: 'feishu' },
        'Feishu WS start skipped: factory disabled',
      );
      this.wsStatus = 'idle';
      return false;
    }
    const sender = this.ensureSender(record);
    try {
      this.wsClient = await startFeishuEventDispatcher({
        record,
        clientFactory: () => this.ensureWsClient(record),
        normalizeInbound: (data) =>
          this.normalizeInbound({ clientName: this.clientName, raw: data }),
        dispatchInbound: input.dispatchInbound,
        ...(input.preflightInbound ? { preflightInbound: input.preflightInbound } : {}),
        sender,
        ...(this.pendingThinkingStore ? { pendingThinkingStore: this.pendingThinkingStore } : {}),
        ...(this.pendingReactionStore ? { pendingReactionStore: this.pendingReactionStore } : {}),
        ...(this.botName ? { botName: this.botName } : {}),
        ...(this.wsAttachmentDownloader
          ? { attachmentDownloader: this.wsAttachmentDownloader }
          : {}),
        ...(input.onCardAction ? { onCardAction: input.onCardAction } : {}),
      });
    } catch (err) {
      // Record the failure for `getWsStatus` and re-throw — callers own the
      // error logging (host-channels `startFeishuWs` / `onBindingChanged`).
      this.wsStatus = 'error';
      this.wsLastError = errorMessage(err);
      const code = err && typeof err === 'object' ? (err as NodeJS.ErrnoException).code : undefined;
      logger.error(
        {
          agentName: this.agentName,
          errorName: err instanceof Error ? err.name : typeof err,
          ...(typeof code === 'string' ? { code } : {}),
          platform: 'feishu',
        },
        'Feishu WS transport transition -> error',
      );
      throw err;
    }
    this.wsStatus = 'connected';
    logger.info({ agentName: this.agentName, platform: 'feishu' }, 'Feishu WS connected');
    return true;
  }

  /**
   * Live WS transport state for status/list responses. In-memory only — see
   * {@link FeishuWsStatusInfo} for the state semantics.
   */
  getWsStatus(): FeishuWsStatusInfo {
    return {
      status: this.wsStatus,
      ...(this.wsLastError ? { lastError: this.wsLastError } : {}),
    };
  }

  /**
   * Tear down cached sender + WS client. Safe to call when nothing is
   * cached (idempotent). Adapters call this on bind / unbind so the next
   * outbound call always mints a fresh transport using the current
   * credentials.
   */
  invalidateTransport(): void {
    if (this.sender) {
      this.sender.invalidateToken();
    }
    this.sender = undefined;
    this.senderForCredentials = undefined;
    const ws = this.wsClient;
    this.wsClient = undefined;
    // Mark this teardown as intentional. When the SDK's `client closed`
    // log fires shortly after, an operator grepping the log can tell it
    // was caused by our side (this line) rather than a server-initiated
    // drop (SDK closed with no adapter teardown log preceding it).
    logger.info(
      {
        clientName: this.clientName,
        agentName: this.agentName,
        hadWsClient: Boolean(ws),
        prevStatus: this.wsStatus,
        reason: 'adapter-invalidate',
      },
      'Feishu WS transport teardown (intentional)',
    );
    this.wsStatus = 'idle';
    this.wsLastError = undefined;
    if (ws && typeof ws.close === 'function') {
      void Promise.resolve(ws.close()).catch((err) => {
        logger.warn(
          {
            err: errorMessage(err),
            clientName: this.clientName,
            agentName: this.agentName,
          },
          'Feishu WS close failed during teardown',
        );
      });
    }
  }

  private ensureSender(record: LocalFeishuBindingRecord): FeishuSender {
    if (!isUsableFeishuBinding(record)) {
      throw new Error('feishu binding is not configured');
    }
    const sig = this.senderForCredentials;
    if (this.sender && sig && sig.appId === record.appId && sig.appSecret === record.appSecret) {
      return this.sender;
    }
    if (this.sender) this.sender.invalidateToken();
    this.sender = new FeishuSender(record.appId, record.appSecret, {
      ...this.senderOptions,
      clientName: this.clientName,
    });
    this.senderForCredentials = { appId: record.appId, appSecret: record.appSecret };
    return this.sender;
  }

  private async ensureWsClient(record: LocalFeishuBindingRecord): Promise<FeishuWsClientLike> {
    if (!isUsableFeishuBinding(record)) {
      throw new Error('feishu binding is not configured');
    }
    if (this.wsClient) return this.wsClient;
    if (this.wsClientFactory === false) {
      throw new Error('feishu WS client factory is disabled');
    }
    const client = await this.wsClientFactory({
      appId: record.appId,
      appSecret: record.appSecret,
    });
    this.wsClient = client;
    return client;
  }
}
