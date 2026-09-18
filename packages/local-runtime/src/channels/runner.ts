import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

import type { OutboundMediaRef } from '@mavis/shared';
import {
  type ConversationCommittedMessage,
  type RuntimeConversationChannelView,
} from '@mavis/conversation-contract';

import type {
  LocalChannelBridgeInfra,
  LocalChannelContext,
  LocalChannelImReceipt,
  LocalChannelMessageFilter,
  LocalChannelPreflightResult,
  LocalChannelPreflightToken,
} from './infra.js';
import type {
  ChannelPermissionBehavior,
  ChannelPermissionReplyMatch,
} from './permission-bridge.js';
import type { ChannelOutboundMessageInput } from './adapter.js';
import type { QuestionnaireReplyOutcome } from '../questionnaire/reply-outcome.js';
import type { LocalMessageAttachment, LocalMessageQuotedMessage } from '../messages/input.js';
import type { LocalQueuedMessage } from '../messages/queue.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import { formatQueuedNoticeText } from './channel-queue-drain.js';
import { rebaseMediaPath } from './media-path-resolve.js';
import { prepareChannelOutboundMessage } from './outbound-message.js';
import {
  collectChannelResponseFromMessages,
  collectChannelResponseFromSse,
  type LocalChannelResponseCollectionOptions,
} from './sse-collector.js';
import { imLogger as logger } from '../common/im-logger.js';
import type { ModuleMetricsReporter } from '../common/metrics.js';

// Re-exported for backward compatibility: SSE collection lives in
// `./sse-collector.js`, but existing call sites (cron/api, index barrel, tests)
// import `collectChannelResponseFromSse` from this module.
export { collectChannelResponseFromSse } from './sse-collector.js';

export interface LocalChannelOutboundMessage {
  id: string;
  platform: string;
  clientName: string;
  chatId: string;
  senderId: string;
  threadId?: string;
  sessionId?: string;
  queueItemId?: string;
  text: string;
  media?: OutboundMediaRef[];
  status: 'sent' | 'error';
  createdAt: number;
  error?: string;
}

interface LocalChannelOutboundFile {
  schemaVersion: number;
  messages: LocalChannelOutboundMessage[];
}

/** Persisted outbound audit history used by real platform clients. */
export class LocalChannelOutboundStore {
  private loaded = false;
  private messages: LocalChannelOutboundMessage[] = [];

  constructor(
    private readonly dataDir: () => string,
    private readonly nowMs: () => number,
    private readonly makeId: (prefix: string) => string,
  ) {}

  async list(
    filter: { sessionId?: string; chatId?: string } = {},
  ): Promise<LocalChannelOutboundMessage[]> {
    await this.load();
    return this.messages
      .filter((message) => !filter.sessionId || message.sessionId === filter.sessionId)
      .filter((message) => !filter.chatId || message.chatId === filter.chatId)
      .map((message) => ({ ...message }));
  }

  async append(input: {
    ctx: LocalChannelContext;
    text: string;
    status?: 'sent' | 'error';
    media?: OutboundMediaRef[];
    sessionId?: string;
    queueItemId?: string;
    error?: string;
  }): Promise<LocalChannelOutboundMessage> {
    await this.load();
    const message: LocalChannelOutboundMessage = {
      id: this.makeId('channel_outbound'),
      platform: input.ctx.platform,
      clientName: input.ctx.clientName,
      chatId: input.ctx.chatId,
      senderId: input.ctx.senderId,
      ...(input.ctx.threadId ? { threadId: input.ctx.threadId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.queueItemId ? { queueItemId: input.queueItemId } : {}),
      text: input.text,
      ...(input.media && input.media.length > 0 ? { media: input.media } : {}),
      status: input.status ?? 'sent',
      createdAt: this.nowMs(),
      ...(input.error ? { error: input.error } : {}),
    };
    this.messages.push(message);
    await this.save();
    return { ...message };
  }

  async clear(): Promise<number> {
    await this.load();
    const count = this.messages.length;
    this.messages = [];
    await this.save();
    return count;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const raw = await readFile(this.filePath, 'utf8').catch(() => undefined);
    if (!raw) return;
    const parsed = yaml.load(raw) as Partial<LocalChannelOutboundFile> | null;
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    this.messages = messages.flatMap((message) => normalizeOutboundMessage(message));
  }

  private async save(): Promise<void> {
    const payload: LocalChannelOutboundFile = {
      schemaVersion: 1,
      messages: this.messages,
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, yaml.dump(payload, { lineWidth: 120, noRefs: true }), 'utf8');
  }

  private get filePath(): string {
    return join(this.dataDir(), 'channel-outbound-messages.yaml');
  }
}

export interface LocalMultiChannelClient {
  readonly id: string;
  readonly platform: string;
  sendText(input: {
    ctx: LocalChannelContext;
    text: string;
    media?: OutboundMediaRef[];
    sessionId?: string;
    queueItemId?: string;
    error?: string;
  }): Promise<LocalChannelOutboundMessage>;
  /**
   * Unified outbound entry point (text + media + questionnaire). Optional for
   * backward compatibility: clients that only implement `sendText` keep
   * working unchanged, and the runner falls back to `sendText` for them via
   * {@link deliverOutbound}. New SDK-backed clients (MR-B/C/D) implement this
   * to deliver media and interactive payloads. For a text-only input the
   * behaviour MUST be identical to `sendText`.
   */
  sendMessage?(input: ChannelOutboundMessageInput): Promise<LocalChannelOutboundMessage>;
}

/** Stable failure for a bound channel whose exact delivery edge is absent. */
export const CHANNEL_CLIENT_UNAVAILABLE = 'CHANNEL_CLIENT_UNAVAILABLE';

export class LocalChannelClientUnavailableError extends Error {
  readonly status = 503;
  readonly code = CHANNEL_CLIENT_UNAVAILABLE;

  constructor(ctx: Pick<LocalChannelContext, 'platform' | 'clientName'>) {
    super(`${CHANNEL_CLIENT_UNAVAILABLE}: ${ctx.platform}:${ctx.clientName}`);
    this.name = 'LocalChannelClientUnavailableError';
  }
}

/**
 * Deliver an outbound message through a channel client, preferring the unified
 * `sendMessage` contract when the client implements it and falling back to the
 * legacy `sendText` path otherwise. Centralises the capability check so call
 * sites stay uniform and the text-only path is provably equivalent to the
 * pre-existing `sendText` behaviour.
 */
export function deliverOutbound(
  client: LocalMultiChannelClient,
  input: ChannelOutboundMessageInput,
): Promise<LocalChannelOutboundMessage> {
  const outbound = prepareChannelOutboundMessage(input);
  if (client.sendMessage) return client.sendMessage(outbound);
  return client.sendText({
    ctx: outbound.ctx,
    text: outbound.text,
    ...(outbound.media && outbound.media.length > 0 ? { media: outbound.media } : {}),
    ...(outbound.sessionId ? { sessionId: outbound.sessionId } : {}),
    ...(outbound.queueItemId ? { queueItemId: outbound.queueItemId } : {}),
    ...(outbound.error ? { error: outbound.error } : {}),
  });
}

export class LocalMultiChannelClientRegistry {
  private readonly clients = new Map<string, LocalMultiChannelClient>();

  /**
   * Register a real SDK-bound client under its exact platform client id (for
   * example `telegram:mavis`). The registry intentionally has no platform or
   * default fallback: an absent exact edge is a delivery failure, never a fake
   * local success.
   */
  registerExact(client: LocalMultiChannelClient): void {
    this.clients.set(client.id, client);
  }

  unregister(clientId: string): void {
    this.clients.delete(clientId);
  }

  get(ctx: LocalChannelContext): LocalMultiChannelClient {
    const client = this.clients.get(ctx.clientName);
    if (client) return client;
    throw new LocalChannelClientUnavailableError(ctx);
  }

  status(): Record<string, unknown> {
    return {
      clients: [...this.clients.values()].map((client) => ({
        id: client.id,
        platform: client.platform,
      })),
    };
  }
}

export interface LocalChannelCollectedResponse {
  text: string;
  chunks: string[];
  finalMessages: number;
  media?: OutboundMediaRef[];
  error?: string;
}

export class LocalChannelResponseCollector {
  async collect(
    response: Response,
    filter?: LocalChannelMessageFilter,
    options?: LocalChannelResponseCollectionOptions,
  ): Promise<LocalChannelCollectedResponse> {
    if (response.status >= 400) {
      const text = await response.text();
      return {
        text: '',
        chunks: [],
        finalMessages: 0,
        error: text || `HTTP ${response.status}`,
      };
    }
    return collectChannelResponseFromSse(await response.text(), filter, options);
  }
}

export interface LocalChannelRunnerDispatch {
  sessionId: string;
  queueItemId: string;
  collected: LocalChannelCollectedResponse;
  outbound?: LocalChannelOutboundMessage;
}

export interface LocalChannelRunnerInboundResult {
  inbound: Awaited<ReturnType<LocalChannelBridgeInfra['handleInbound']>>;
  dispatch?: LocalChannelRunnerDispatch;
  /**
   * True when the inbound event was suppressed by the dedup cache
   * (`${platform}:${clientName}:${eventId}` matched a recent key).
   * The runner still records a successful `handled: true` inbound so upstream
   * HTTP handlers can answer 200, but no enqueue / dispatch happens.
   */
  deduplicated?: boolean;
  /**
   * True when the inbound matched a pending questionnaire ask and was
   * forwarded to the questionnaire bridge instead of dispatched as a
   * plain user message. The runner short-circuits before
   * `infra.handleInbound`, so the `inbound` field is a synthetic
   * `{ handled: true }` result rather than a real bridge result.
   */
  questionnaireReply?: boolean;
  /**
   * True when the inbound resolved a pending permission ask
   * (`tryPermissionReply` matched) and was forwarded to the permission
   * reply handler instead of dispatched as a plain user message. Like
   * `questionnaireReply`, the runner short-circuits before
   * `infra.handleInbound` and `inbound` is a synthetic `{ handled: true }`.
   */
  permissionReply?: boolean;
}

export interface LocalChannelRunnerOptions {
  infra: LocalChannelBridgeInfra;
  dataDir: () => string;
  nowMs: () => number;
  makeId: (prefix: string) => string;
  conversation?: Pick<RuntimeConversationChannelView, 'ingress'>;
  getSessionById: (sessionId: string) => Promise<LocalSessionRecord | undefined>;
  getQueuedMessage?: (
    sessionId: string,
    queueItemId: string,
  ) => Promise<LocalQueuedMessage | undefined>;
  runQueuedTurn?: (input: {
    session: LocalSessionRecord;
    queuedMessage: LocalQueuedMessage;
  }) => Promise<Response>;
  /**
   * Optional questionnaire reply forwarder. When set, every
   * `dispatchInbound` first asks the resolved adapter
   * `tryHandleQuestionnaireReply({ ctx, text, raw })`; on a hit, the
   * runner forwards the decoded reply here and short-circuits before
   * the inbound bridge. Host wires this to
   * `LocalChannelQuestionnaireBridge.submit`.
   */
  questionnaireReplyHandler?: (input: {
    ctx: LocalChannelContext;
    reply: import('@mavis/shared/questionnaire').AskQuestionnaireReplyPayload;
  }) => Promise<QuestionnaireReplyOutcome | void>;
  /**
   * Optional permission reply resolver. When set, `dispatchInbound` asks
   * it FIRST (before the questionnaire interception) whether the raw
   * inbound event resolves a pending permission ask for this conversation.
   * Host wires this to `LocalChannelPermissionBridge.tryPermissionReply`,
   * which owns the pending map (consume-once) and delegates the
   * platform-specific decode to `adapter.parsePermissionReply`. Returns
   * `null` for unrelated inbound — the runner then continues with its
   * normal flow. MUST be fail-quiet at the bridge level; the runner adds
   * its own try/catch as a backstop.
   */
  tryPermissionReply?: (
    ctx: LocalChannelContext,
    raw: unknown,
  ) => Promise<ChannelPermissionReplyMatch | null>;
  /**
   * Optional permission reply forwarder called on a `tryPermissionReply`
   * hit. Host wires this to `applyPermissionReply(permissionRouteContext,
   * requestId, behavior)` so the decoded IM decision settles the pending
   * request through the existing `replyLocalPermissionRequests` flow
   * (rule persisted + waiter settled + blocked tool call resumes).
   * Handler errors are logged and swallowed — a permission click is never
   * re-dispatched as a plain user message.
   */
  permissionReplyHandler?: (input: {
    ctx: LocalChannelContext;
    requestId: string;
    behavior: ChannelPermissionBehavior;
  }) => Promise<void>;
  /**
   * Optional channel-queue kick callback wired by the host. Replaces the
   * legacy "dispatch immediately" branch in `dispatchInbound`. When set,
   * the runner calls this for inbound items that produced a `queueItemId`
   * and lets the host decide whether to dispatch now (idle queue head) or
   * enqueue a "queued, N ahead" notice before draining later via
   * `notifySessionTurnFinished`.
   */
  kickChannelDrain?: (input: {
    ctx: LocalChannelContext;
    sessionId: string;
    queueItemId: string;
  }) => Promise<void>;
  /**
   * Optional defence-in-depth binding gate. When set, `dispatchInbound`
   * checks it FIRST and drops any inbound whose `(agentName × platform)`
   * binding is gone (returns `false`) — no session lookup, no outbound. This
   * closes the race between "unbind stops the transport" and "a message
   * already in the transport's buffer reaches the runner", and guards against
   * any future inbound source that forgets to tear its transport down on
   * unbind. Wired by the host (see `wireChannelSubsystem`) against the
   * per-platform binding stores; unwired in unit tests, where it stays inert.
   */
  hasActiveChannelBinding?: (ctx: LocalChannelContext) => Promise<boolean>;
  /**
   * Optional host-injected metrics reporter. Absent = noop: no counters, no
   * latency samples, zero behavior change. Metric names are BARE (the server
   * prepends the `local_runtime_` service prefix); label values are bounded
   * enums only (platform names, fixed status/phase strings).
   */
  metrics?: ModuleMetricsReporter;
}

export class LocalChannelRunner {
  readonly outboundStore: LocalChannelOutboundStore;
  readonly clients: LocalMultiChannelClientRegistry;
  readonly collector: LocalChannelResponseCollector;
  /**
   * Defence-in-depth binding gate, injected AFTER construction by the wire
   * layer (`host-channels.ts`) once the per-platform binding stores exist.
   * Mutable so the host can patch it in without forcing the runner options to
   * depend on the store types (mirrors `infra.accessControlDenyReply`). When
   * set, `dispatchInbound` drops any inbound whose binding is gone. Falls back
   * to the constructor option so tests can still wire it via options if they
   * prefer.
   */
  hasActiveChannelBinding: ((ctx: LocalChannelContext) => Promise<boolean>) | undefined;

  constructor(private readonly options: LocalChannelRunnerOptions) {
    this.outboundStore = new LocalChannelOutboundStore(
      options.dataDir,
      options.nowMs,
      options.makeId,
    );
    this.clients = new LocalMultiChannelClientRegistry();
    this.collector = new LocalChannelResponseCollector();
    this.hasActiveChannelBinding = options.hasActiveChannelBinding;
  }

  status(): Record<string, unknown> {
    return {
      enabled: true,
      localRuntime: true,
      responseCollector: this.options.conversation ? 'committed-messages' : 'sse',
      ...this.clients.status(),
    };
  }

  /**
   * Gate an inbound before a transport performs platform-visible side effects.
   * Denied preflights are metered here; allowed ones are metered by the normal
   * dispatch wrapper after the token is consumed by infra.
   */
  async preflightInbound(input: {
    ctx: LocalChannelContext;
    text: string;
    eventId?: string;
  }): Promise<LocalChannelPreflightResult> {
    if (this.hasActiveChannelBinding && !(await this.hasActiveChannelBinding(input.ctx))) {
      const result: LocalChannelRunnerInboundResult = {
        inbound: {
          handled: true,
          lane: input.ctx.lane ?? 'interactive',
          accessDeniedReason: 'channel-unbound',
        },
      };
      this.options.metrics?.incr('channel_inbound_total', {
        channel: input.ctx.platform,
        status: inboundMetricStatus(result),
      });
      return { allowed: false, inbound: result.inbound };
    }
    try {
      const result = await this.options.infra.preflightInbound(input);
      if (!result.allowed) {
        this.options.metrics?.incr('channel_inbound_total', {
          channel: input.ctx.platform,
          status: inboundMetricStatus({ inbound: result.inbound }),
        });
      }
      return result;
    } catch (err) {
      this.options.metrics?.incr('channel_inbound_total', {
        channel: input.ctx.platform,
        status: 'error',
      });
      throw err;
    }
  }

  async dispatchInbound(input: {
    ctx: LocalChannelContext;
    text: string;
    attachments?: LocalMessageAttachment[];
    quotedMessage?: LocalMessageQuotedMessage;
    /**
     * Optional platform-specific event id (Telegram `update_id`, Feishu
     * `event_id`/`message_id`, WeChat `message_id`). Forwarded to
     * `LocalChannelBridgeInfra.handleInbound` so the dedup cache can key
     * `${platform}:${clientName}:${eventId}` and drop replays.
     */
    eventId?: string;
    /** One-shot access decision produced by `LocalChannelBridgeInfra.preflightInbound`. */
    preflight?: LocalChannelPreflightToken;
    /**
     * Optional raw platform event (Bot API update, Feishu card-action
     * trigger). Forwarded verbatim to `tryHandleQuestionnaireReply` so
     * adapters that need wire-level access (e.g. Telegram
     * `callback_query.data`) can short-circuit before the bridge.
     */
    raw?: unknown;
  }): Promise<LocalChannelRunnerInboundResult> {
    // Metering wrapper: one `channel_inbound_total{channel,status}` count per
    // inbound outcome plus a `channel_dispatch_duration_ms` sample, around the
    // otherwise-unchanged dispatch flow in `dispatchInboundInner`.
    const metrics = this.options.metrics;
    const startMs = this.options.nowMs();
    try {
      const result = await this.dispatchInboundInner(input);
      metrics?.incr('channel_inbound_total', {
        channel: input.ctx.platform,
        status: inboundMetricStatus(result),
      });
      return result;
    } catch (err) {
      metrics?.incr('channel_inbound_total', { channel: input.ctx.platform, status: 'error' });
      throw err;
    } finally {
      metrics?.latency('channel_dispatch_duration_ms', this.options.nowMs() - startMs, {
        channel: input.ctx.platform,
      });
    }
  }

  private async dispatchInboundInner(input: {
    ctx: LocalChannelContext;
    text: string;
    attachments?: LocalMessageAttachment[];
    quotedMessage?: LocalMessageQuotedMessage;
    eventId?: string;
    preflight?: LocalChannelPreflightToken;
    raw?: unknown;
  }): Promise<LocalChannelRunnerInboundResult> {
    // Defence-in-depth: drop inbound whose (agentName × platform) binding is
    // gone before ANY processing (questionnaire interception, dedup, dispatch,
    // outbound). This is the central backstop for unbind's mandatory disconnect — even if a
    // transport failed to tear itself down, a message that slips through here
    // is discarded with no session work and no reply. `handled: true` so the
    // HTTP layer answers 200; `accessDeniedReason` tags it for ops.
    if (this.hasActiveChannelBinding && !(await this.hasActiveChannelBinding(input.ctx))) {
      const inbound = { handled: true, accessDeniedReason: 'channel-unbound' } as Awaited<
        ReturnType<LocalChannelBridgeInfra['handleInbound']>
      >;
      return { inbound };
    }
    // Permission reply interception — MUST run BEFORE the questionnaire
    // interception. Both ride platform callback events (Telegram
    // callback_query), but the permission bridge matches strictly on its
    // own pending map + `p:<requestId>:<decision>` codec, so a click
    // claimed here can never be a questionnaire answer. A hit settles the
    // pending permission request through the handler and short-circuits —
    // the callback is never dispatched as a plain user message. Fail-quiet:
    // a resolver error falls through to the normal inbound flow; a handler
    // error (e.g. the desktop UI already settled the request) is logged
    // and the inbound is still treated as consumed.
    if (this.options.tryPermissionReply && this.options.permissionReplyHandler) {
      let permissionMatch: ChannelPermissionReplyMatch | null = null;
      try {
        permissionMatch = await this.options.tryPermissionReply(input.ctx, input.raw);
      } catch (err) {
        logger.error(
          { err, platform: input.ctx.platform, clientName: input.ctx.clientName },
          'Channel permission reply resolver failed',
        );
        // Fall through to the normal inbound path on resolver errors.
      }
      if (permissionMatch) {
        // The click IS the user's permission decision — count the replied
        // phase regardless of how the handler settles (fail-quiet below).
        this.options.metrics?.incr('channel_permission_ask_total', {
          channel: input.ctx.platform,
          phase: 'replied',
        });
        const inbound = { handled: true } as Awaited<
          ReturnType<LocalChannelBridgeInfra['handleInbound']>
        >;
        try {
          await this.options.permissionReplyHandler({
            ctx: input.ctx,
            requestId: permissionMatch.requestId,
            behavior: permissionMatch.behavior,
          });
        } catch (err) {
          logger.error(
            { err, requestId: permissionMatch.requestId },
            'Channel permission reply handler failed',
          );
        }
        return { inbound, permissionReply: true };
      }
    }
    // Questionnaire reply interception. Adapters track their own pending
    // questionnaire state (see `ChannelQuestionnairePending` in the
    // platform adapter) so the runner does not need to know which
    // encoding (numbered text, inline keyboard, card form) the platform
    // used. A `null` return falls through to the normal inbound flow.
    if (this.options.questionnaireReplyHandler) {
      const adapter = this.options.infra.adapterRegistry.get(
        input.ctx.platform,
        input.ctx.clientName,
      );
      if (adapter?.tryHandleQuestionnaireReply) {
        try {
          const handlerInput = {
            ctx: input.ctx,
            text: input.text,
            ...(input.raw !== undefined ? { raw: input.raw } : {}),
          };
          const questionnaireResult = await adapter.tryHandleQuestionnaireReply(handlerInput);
          if (questionnaireResult) {
            const inbound = { handled: true } as Awaited<
              ReturnType<LocalChannelBridgeInfra['handleInbound']>
            >;
            if (!('reply' in questionnaireResult)) {
              return { inbound, questionnaireReply: true };
            }
            // Only a forwarded reply payload counts as the user answering —
            // consumed-no-reply events (acks) are not replies.
            this.options.metrics?.incr('channel_ask_user_total', {
              channel: input.ctx.platform,
              phase: 'replied',
            });
            let outcome: QuestionnaireReplyOutcome;
            try {
              const resolved = await this.options.questionnaireReplyHandler(questionnaireResult);
              outcome = resolved ?? { status: 'accepted' };
            } catch (err) {
              // The host classifies LocalQuestionnaireError before it reaches
              // this boundary. A bridge/unknown throw is still retryable, but
              // the inbound remains handled and never falls into a normal turn.
              outcome = { status: 'retryable' };
              logger.error(
                {
                  err,
                  requestId: questionnaireResult.reply.requestId,
                  platform: input.ctx.platform,
                  clientName: input.ctx.clientName,
                },
                'Channel questionnaire reply handler failed',
              );
            }
            if (adapter.settleQuestionnaireReply) {
              try {
                await adapter.settleQuestionnaireReply({
                  ctx: questionnaireResult.ctx,
                  requestId: questionnaireResult.reply.requestId,
                  outcome,
                });
              } catch (err) {
                // Settlement can change channel state as well as terminal UI.
                // The inbound is already consumed; never re-dispatch it as an
                // Agent turn if this follow-up fails.
                logger.error(
                  {
                    err,
                    platform: input.ctx.platform,
                    clientName: input.ctx.clientName,
                    requestId: questionnaireResult.reply.requestId,
                    outcome,
                  },
                  'Channel questionnaire reply settle failed',
                );
              }
            }
            return { inbound, questionnaireReply: true };
          }
        } catch (err) {
          logger.error(
            { err, platform: input.ctx.platform, clientName: input.ctx.clientName },
            'Channel questionnaire reply adapter failed',
          );
          // Fall through to the normal inbound path on adapter errors —
          // dropping the message would lose the user's reply silently.
        }
      }
    }

    const inbound = await this.options.infra.handleInbound({
      ctx: input.ctx,
      text: input.text,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.quotedMessage ? { quotedMessage: input.quotedMessage } : {}),
      ...(input.eventId ? { eventId: input.eventId } : {}),
      ...(input.preflight ? { preflight: input.preflight } : {}),
      // Interim-progress seam for slash commands (today: `/compact`'s two-stage
      // "started" line). Backed by the same `deliverOutbound` + client registry
      // the terminal reply uses, so a mid-flight line lands on the same channel.
      onProgress: (text: string) =>
        this.sendOutbound(input.ctx, {
          ctx: input.ctx,
          text,
        }).then(() => undefined),
    });
    // P1.4 wires `deduplicated: true` through the infra layer; this pass-through
    // makes the flag visible to HTTP handlers once the infra emits it.
    if (inbound.deduplicated) {
      return { inbound, deduplicated: true };
    }
    if (inbound.reply && !inbound.queueItemId) {
      try {
        const outbound = await this.sendOutbound(input.ctx, {
          ctx: input.ctx,
          text: inbound.reply,
          ...(inbound.sessionId ? { sessionId: inbound.sessionId } : {}),
        });
        if (inbound.imReceipt) {
          logImReceiptDelivery(
            input.ctx.platform,
            inbound.imReceipt,
            outbound.status === 'sent' ? 'sent' : 'returned_error',
          );
        }
      } catch (error) {
        if (inbound.imReceipt) {
          logImReceiptDelivery(input.ctx.platform, inbound.imReceipt, 'threw');
        }
        throw error;
      }
      return { inbound };
    }
    if (!inbound.sessionId || !inbound.queueItemId) return { inbound };
    if (this.options.conversation) {
      if ((inbound.queueAhead ?? 0) > 0) {
        await this.deliverQueuedNotice(input.ctx, inbound.queueAhead ?? 0);
      }
      return { inbound };
    }
    // Channel items are routed through the host-owned channel-queue drain
    // (mirrors cron's drainQueuedCronPrompts) instead of being dispatched
    // unconditionally from the inbound hot path. The kick callback is
    // responsible for: (1) computing the queue head / busy state, (2)
    // sending the "queued, N ahead" notice when the item has to wait, and
    // (3) running the actual drain (which calls back into this runner's
    // dispatchQueued when the session is idle). This guarantees FIFO
    // ordering, avoids busy → error-reply regressions, and keeps the IM
    // reply delivery path (collect SSE → deliverOutbound) authoritative.
    //
    // Legacy fallback: if the host did not wire a kickChannelDrain (older
    // test scaffolding), preserve the original synchronous dispatch
    // behaviour so existing unit tests keep working.
    if (this.options.kickChannelDrain) {
      await this.options.kickChannelDrain({
        ctx: input.ctx,
        sessionId: inbound.sessionId,
        queueItemId: inbound.queueItemId,
      });
      return { inbound };
    }
    const dispatch = await this.dispatchQueued({
      ctx: input.ctx,
      sessionId: inbound.sessionId,
      queueItemId: inbound.queueItemId,
    });
    return { inbound, dispatch };
  }

  async dispatchQueued(input: {
    ctx: LocalChannelContext;
    sessionId: string;
    queueItemId: string;
  }): Promise<LocalChannelRunnerDispatch> {
    if (this.options.conversation) {
      throw new Error('Queued channel turns are dispatched by Session V2');
    }
    const session = await this.options.getSessionById(input.sessionId);
    if (!session) {
      const collected = {
        text: '',
        chunks: [],
        finalMessages: 0,
        error: `Session not found: ${input.sessionId}`,
      };
      const outbound = await this.sendCollected(
        input.ctx,
        input.sessionId,
        input.queueItemId,
        collected,
      );
      return { sessionId: input.sessionId, queueItemId: input.queueItemId, collected, outbound };
    }
    const getQueuedMessage = this.options.getQueuedMessage;
    const runQueuedTurn = this.options.runQueuedTurn;
    if (!getQueuedMessage || !runQueuedTurn) {
      throw new Error('Local Runtime V1 channel dispatch is unavailable');
    }
    const queuedMessage = await getQueuedMessage(input.sessionId, input.queueItemId);
    if (!queuedMessage) {
      const collected = {
        text: '',
        chunks: [],
        finalMessages: 0,
        error: `Queue item not found: ${input.queueItemId}`,
      };
      const outbound = await this.sendCollected(
        input.ctx,
        input.sessionId,
        input.queueItemId,
        collected,
      );
      return { sessionId: input.sessionId, queueItemId: input.queueItemId, collected, outbound };
    }
    // Typing hook: start the indicator BEFORE the agent turn runs so the
    // user sees "The other party is typing" during the bulk of the wait (LLM inference +
    // tool calls + outbound flush). Adapters that don't implement typing
    // (notifyTurnStart === undefined) are skipped. notifyTurnEnd fires after
    // sendCollected on both success and error paths.
    await this.notifyTurnStart(input.ctx);
    let outbound: LocalChannelOutboundMessage | undefined;
    try {
      const response = await runQueuedTurn({ session, queuedMessage });
      // 409 = lost the idle race (session became busy between the caller's
      // activePiTurns check and openLocalMessageStream's gate). Return a
      // retryable result WITHOUT sending the error to the user — the queue
      // item stays 'queued' and the next terminal event retries. This mirrors
      // cron drain's direct `response.status === 409` check (cron/api.ts:429)
      // and fixes the channel drain's original broken regex detection that
      // never matched (the response body is JSON, not "HTTP 409").
      if (response.status === 409) {
        // Consume the body to avoid resource leak.
        void response.text().catch(() => {});
        return {
          sessionId: input.sessionId,
          queueItemId: input.queueItemId,
          collected: {
            text: '',
            chunks: [],
            finalMessages: 0,
            error: `HTTP ${response.status}`,
          },
        };
      }
      // §4.2/§4.3: resolve the per-client filter (concise mode + tool summary)
      // for this dispatch. Best-effort + dual-convention; omitted/default filter
      // == legacy behavior, so a lookup miss never regresses output.
      const filter = await this.resolveMessageFilter(input.ctx);
      const collected = await this.collector.collect(response, filter, {
        preserveAssistantTextAcrossToolCalls: true,
      });
      outbound = await this.sendCollected(
        input.ctx,
        input.sessionId,
        input.queueItemId,
        collected,
        session.workspaceDir,
      );
      return {
        sessionId: input.sessionId,
        queueItemId: input.queueItemId,
        collected,
        outbound,
      };
    } finally {
      await this.notifyTurnEnd(input.ctx);
    }
  }

  /** Best-effort product hook used by both legacy and v2 Turn execution. */
  async notifyTurnStart(ctx: LocalChannelContext): Promise<void> {
    const adapter = this.options.infra.adapterRegistry?.get(ctx.platform, ctx.clientName);
    logger.info(
      {
        platform: ctx.platform,
        clientName: ctx.clientName,
        adapterConfigured: Boolean(adapter),
        hasNotifyTurnStart: Boolean(adapter?.notifyTurnStart),
      },
      'Channel Turn typing resolved adapter',
    );
    if (!adapter?.notifyTurnStart) return;
    try {
      await adapter.notifyTurnStart(ctx);
    } catch {
      // Typing must never surface to the Turn.
    }
  }

  /** Best-effort counterpart to {@link notifyTurnStart}. */
  async notifyTurnEnd(ctx: LocalChannelContext): Promise<void> {
    const adapter = this.options.infra.adapterRegistry?.get(ctx.platform, ctx.clientName);
    if (!adapter?.notifyTurnEnd) return;
    try {
      await adapter.notifyTurnEnd(ctx);
    } catch {
      // Typing must never surface to terminal reply delivery.
    }
  }

  private sendCollected(
    ctx: LocalChannelContext,
    sessionId: string,
    queueItemId: string,
    collected: LocalChannelCollectedResponse,
    workspaceDir?: string,
  ): Promise<LocalChannelOutboundMessage | undefined> {
    const text = collected.error ? '' : collected.text.trim();
    const hasMedia = !collected.error && !!collected.media && collected.media.length > 0;
    if (!text && !hasMedia && !collected.error) return Promise.resolve(undefined);
    // Rebase relative media paths to <workspace>/<path> so IM senders
    // don't ENOENT on bare basenames.
    const media = hasMedia
      ? collected.media!.map((m) => rebaseMediaPath(m, workspaceDir))
      : undefined;
    return this.sendOutbound(ctx, {
      ctx,
      text,
      ...(media ? { media } : {}),
      sessionId,
      queueItemId,
      ...(collected.error ? { error: collected.error } : {}),
    });
  }

  /**
   * Drain a questionnaire reply continuation's SSE stream and deliver the
   * collected text + media back to the channel the question originated from.
   * Mirrors `sendCollected` shape so the reply lands in the origin chat
   * exactly like a normal turn reply, but the entry point is the SSE body
   * (not a `runQueuedTurn` Response) because the reply route fires the
   * synthetic user-message turn detached.
   */
  async deliverReplyFromSse(
    ctx: LocalChannelContext,
    sseText: string,
    sessionId: string,
  ): Promise<LocalChannelOutboundMessage | undefined> {
    const filter = await this.resolveMessageFilter(ctx);
    const collected = collectChannelResponseFromSse(sseText, filter, {
      preserveAssistantTextAcrossToolCalls: true,
    });
    const text = collected.error ? '' : collected.text.trim();
    const hasMedia = !collected.error && !!collected.media && collected.media.length > 0;
    if (!text && !hasMedia && !collected.error) return undefined;
    const media = hasMedia ? collected.media : undefined;
    return this.sendOutbound(ctx, {
      ctx,
      text,
      ...(media ? { media } : {}),
      sessionId,
      ...(collected.error ? { error: collected.error } : {}),
    });
  }

  /** Delivers a continuation from the v2 committed-message projection. */
  async deliverReplyFromMessages(
    ctx: LocalChannelContext,
    messages: readonly ConversationCommittedMessage[],
    sessionId: string,
    workspaceDir?: string,
    error?: string,
  ): Promise<LocalChannelOutboundMessage | undefined> {
    const filter = await this.resolveMessageFilter(ctx);
    const collected = collectChannelResponseFromMessages(messages, filter, error);
    return this.sendCollected(ctx, sessionId, '', collected, workspaceDir);
  }

  /**
   * Send a single "queued, N ahead" notice to the originating IM chat.
   * Called from the channel queue drain kick path when the enqueued item
   * is going to wait (session busy or items ahead in the channel queue).
   *
   * Best-effort: a delivery failure must never block the dispatch flow —
   * the kick path runs alongside idle-drain and cannot be allowed to fail
   * the entire enqueue. We swallow errors here.
   */
  async deliverQueuedNotice(ctx: LocalChannelContext, ahead: number): Promise<void> {
    if (ahead <= 0) return;
    const text = formatQueuedNoticeText(ahead);
    try {
      await this.sendOutbound(ctx, {
        ctx,
        text,
      });
    } catch (err) {
      logger.warn(
        { err, platform: ctx.platform, chatId: ctx.chatId },
        'Channel queued notice delivery failed',
      );
    }
  }

  /**
   * Metered wrapper over {@link deliverOutbound}: resolves the client from the
   * registry and counts every outbound attempt as
   * `channel_outbound_total{channel,status}`. A throw counts as `error` and is
   * rethrown — callers keep their existing error semantics.
   */
  private async sendOutbound(
    ctx: LocalChannelContext,
    input: ChannelOutboundMessageInput,
  ): Promise<LocalChannelOutboundMessage> {
    try {
      const message = await deliverOutbound(this.clients.get(ctx), input);
      this.options.metrics?.incr('channel_outbound_total', {
        channel: ctx.platform,
        // Normalize: test doubles may return partial messages without status.
        status: message.status === 'error' ? 'error' : 'sent',
      });
      return message;
    } catch (err) {
      this.options.metrics?.incr('channel_outbound_total', {
        channel: ctx.platform,
        status: 'error',
      });
      throw err;
    }
  }

  /**
   * Resolve the per-client message filter for a dispatch. Dual-convention
   * fallback: try `ctx.clientName` first, then the daemon `*ClientId` key.
   * Any error → default filter so a lookup miss never throws out of dispatch.
   */
  private async resolveMessageFilter(ctx: LocalChannelContext): Promise<LocalChannelMessageFilter> {
    try {
      const primary = await this.options.infra.bindingStore.getMessageFilter(ctx.clientName);
      if (!isDefaultMessageFilter(primary)) return primary;
      const altKey = daemonClientIdForCtx(ctx);
      if (altKey && altKey !== ctx.clientName) {
        const alt = await this.options.infra.bindingStore.getMessageFilter(altKey);
        if (!isDefaultMessageFilter(alt)) return alt;
      }
      return primary;
    } catch {
      return { mode: 'result', includeToolSummary: false };
    }
  }
}

function isDefaultMessageFilter(f: LocalChannelMessageFilter): boolean {
  return f.mode === 'result' && f.includeToolSummary !== true;
}

function logImReceiptDelivery(
  platform: string,
  receipt: LocalChannelImReceipt,
  outcome: 'sent' | 'returned_error' | 'threw',
): void {
  const fields = {
    requestKey: receipt.requestKey,
    platform,
    connectionId: receipt.imRoute.connectionId,
    bindingId: receipt.imRoute.bindingId,
    ...(receipt.imRoute.imConversationId
      ? { imConversationId: receipt.imRoute.imConversationId }
      : {}),
    ...(receipt.sessionId ? { sessionId: receipt.sessionId } : {}),
    stage: 'receipt_delivery',
    receiptStage: receipt.stage,
    code: receipt.code,
    outcome,
  };
  if (outcome === 'sent') {
    logger.info(fields, 'IM receipt delivery completed');
  } else {
    logger.warn(fields, 'IM receipt delivery did not complete');
  }
}

/**
 * Map an inbound dispatch result to the bounded `channel_inbound_total` status
 * enum: `permission_reply` | `questionnaire_reply` | `deduplicated` |
 * `unbound` | `denied` | `ok` (plus `error` emitted by the wrapper on throw).
 * Free-form denial reason strings never become label values.
 */
function inboundMetricStatus(result: LocalChannelRunnerInboundResult): string {
  if (result.permissionReply) return 'permission_reply';
  if (result.questionnaireReply) return 'questionnaire_reply';
  if (result.deduplicated) return 'deduplicated';
  if (result.inbound.accessDeniedReason === 'channel-unbound') return 'unbound';
  if (result.inbound.accessDeniedReason) return 'denied';
  return 'ok';
}

/**
 * Rebuild the daemon `*ClientId(agentName)` storage key for `ctx` — the key the
 * UI / REST WRITES the message filter under (from
 * `feishu/telegram/wechat.statusClients()` → `record.clientId`), which differs
 * from the dispatch `ctx.clientName` (`${agent}:${platform}`). The per-platform
 * `*ClientId` helpers live in the channel modules, but those import from THIS
 * file — importing them back would create a cycle — so the trivial convention
 * is duplicated here (same rationale as `owner-store.imGatewayInboundClientName`).
 */
function daemonClientIdForCtx(ctx: LocalChannelContext): string | undefined {
  const platform = ctx.platform;
  const suffix = `:${platform}`;
  const agentRaw = ctx.clientName.endsWith(suffix)
    ? ctx.clientName.slice(0, -suffix.length)
    : ctx.clientName;
  const agent = agentRaw.trim() || 'mavis';
  switch (platform) {
    case 'feishu':
      return agent; // feishuClientId(agent) === agent
    case 'telegram':
      return `telegram:${agent}`; // telegramClientId
    case 'wechat':
      return `wechat:${agent}`; // wechatClientId
    default:
      return undefined;
  }
}

function normalizeOutboundMessage(value: unknown): LocalChannelOutboundMessage[] {
  if (!value || typeof value !== 'object') return [];
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.platform !== 'string' ||
    typeof raw.clientName !== 'string' ||
    typeof raw.chatId !== 'string' ||
    typeof raw.senderId !== 'string' ||
    typeof raw.text !== 'string' ||
    typeof raw.createdAt !== 'number'
  ) {
    return [];
  }
  return [
    {
      id: raw.id,
      platform: raw.platform,
      clientName: raw.clientName,
      chatId: raw.chatId,
      senderId: raw.senderId,
      ...(typeof raw.threadId === 'string' ? { threadId: raw.threadId } : {}),
      ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
      ...(typeof raw.queueItemId === 'string' ? { queueItemId: raw.queueItemId } : {}),
      text: raw.text,
      status: raw.status === 'error' ? 'error' : 'sent',
      createdAt: raw.createdAt,
      ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    },
  ];
}
