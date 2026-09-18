import type {
  AskQuestionnaireReplyPayload,
  AskQuestionnaireRequest,
} from '@mavis/shared/questionnaire';
import type { OutboundMediaRef } from '@mavis/shared';

import type { ChannelPlatform } from './route-api.js';
import type { LocalChannelContext } from './infra.js';
import type { ChannelInboundAttachmentRef, ChannelInboundEnvelope } from './envelope.js';
import type {
  ChannelPermissionBehavior,
  ChannelRenderablePermission,
  LocalChannelPermissionPending,
} from './permission-bridge.js';
import type {
  ChannelQuestionnairePending,
  ChannelRenderableQuestionnaire,
} from './questionnaire-bridge.js';
import type { QuestionnaireReplyOutcome } from '../questionnaire/reply-outcome.js';

/**
 * Unified platform adapter contract for the local-runtime channel layer.
 *
 * Every concrete IM platform (Telegram / Feishu / WeChat / mock) is expected to
 * eventually expose a `LocalChannelPlatformAdapter`. The adapter owns the
 * platform-specific edges — credential binding, inbound normalization, outbound
 * delivery, and attachment resolution — so the runner and infra layers stay
 * platform-agnostic.
 *
 * This file is intentionally type-only: it defines the contract that MR-B/C/D
 * implement against. No platform SDK is imported here.
 *
 * Media is modelled with the canonical `OutboundMediaRef` from `@mavis/shared`
 * (the same value object the UI's DeliverAssetsCard and `parseMediaTags`
 * produce) so the IM outbound surface never drifts from the UI on what counts
 * as a deliverable asset. The interactive `ask_user` round-trip rides as an
 * optional `questionnaire` field on `ChannelOutboundMessageInput` — only
 * adapters that can render structured interactive UI (Feishu card today) act
 * on it; the others ignore it and the platform-agnostic
 * {@link LocalChannelQuestionnaireBridge} owns the lifecycle / submit decode.
 */

/**
 * Platform-agnostic questionnaire payload that an outbound channel message can
 * carry. Re-uses {@link AskQuestionnaireRequest} verbatim — the same value
 * object the UI composer renders — so the runtime never has to translate
 * between two questionnaire shapes. Adapters that render structured UI
 * (Feishu card) consume this; adapters that only render text (Telegram /
 * WeChat) either format a numbered fallback or ignore the payload.
 */
export type ChannelQuestionnaire = AskQuestionnaireRequest;

/**
 * Outbound message input handed to an adapter (or to a
 * `LocalMultiChannelClient.sendMessage` shim). `text` stays required so the
 * text-only path is identical to the legacy `sendText` call; `media` carries
 * the structured refs `parseMediaTags` extracted from the reply; the optional
 * `questionnaire` payload, when set, asks the adapter to render the
 * interactive form (card on Feishu, numbered text elsewhere) instead of (or
 * alongside) the plain text body. Adapters MUST treat all three of `text`,
 * `media`, `questionnaire` as additive when more than one is present.
 */
export interface ChannelOutboundMessageInput {
  ctx: LocalChannelContext;
  text: string;
  media?: OutboundMediaRef[];
  questionnaire?: ChannelQuestionnaire;
  sessionId?: string;
  queueItemId?: string;
  /**
   * Internal execution-failure detail. Before any IM send, the shared
   * outbound boundary replaces it with a localized safe reply and removes
   * this field. It is not a transport delivery failure.
   */
  error?: string;
}

export interface ChannelOutboundResult {
  id: string;
  status: 'sent' | 'error';
  error?: string;
}

export interface ChannelBindInput {
  agentName: string;
  clientName?: string;
  credentials: Record<string, unknown>;
}

export interface ChannelBindResult {
  ok: boolean;
  clientName: string;
  error?: string;
  code?: string;
}

export interface ChannelUnbindInput {
  agentName: string;
  clientName?: string;
}

export interface ChannelUnbindResult {
  ok: boolean;
}

export interface ChannelStatusInput {
  agentName?: string;
}

export interface ChannelStatusResult {
  configured: boolean;
  connected: boolean;
  clientName: string;
  detail?: Record<string, unknown>;
}

export interface PlatformInboundInput {
  clientName: string;
  raw: unknown;
}

export interface ChannelAttachmentDownloadInput {
  clientName: string;
  ref: ChannelInboundAttachmentRef;
  /** Inbound message id (Feishu resource API needs it; Telegram ignores). */
  messageId?: string;
  /** Stable session/chat scope for the on-disk path. */
  sessionId?: string;
}

/**
 * Result of {@link LocalChannelPlatformAdapter.downloadAttachmentToLocal}.
 * Distinct from {@link ChannelInboundAttachmentRef} — `filePath` is
 * absolute and the optional `error` marker lets callers degrade gracefully
 * when one of several attachments fails to download.
 */
export interface ChannelInboundAttachment {
  type: 'image' | 'file';
  filePath: string;
  fileName: string;
  mimeType: string;
  error?: string;
}

export type ChannelQuestionnaireReplyHandlingResult =
  | { ctx: LocalChannelContext; reply: AskQuestionnaireReplyPayload }
  | { handled: true }
  | null;

/**
 * The unified platform adapter contract. Required methods cover the inbound →
 * dispatch → outbound core loop; `downloadAttachment` is optional because not
 * every platform message carries resolvable media.
 */
export interface LocalChannelPlatformAdapter {
  readonly platform: ChannelPlatform;
  readonly clientName: string;
  bind(input: ChannelBindInput): Promise<ChannelBindResult>;
  unbind(input: ChannelUnbindInput): Promise<ChannelUnbindResult>;
  status(input?: ChannelStatusInput): Promise<ChannelStatusResult>;
  normalizeInbound(input: PlatformInboundInput): Promise<ChannelInboundEnvelope>;
  sendMessage(input: ChannelOutboundMessageInput): Promise<ChannelOutboundResult>;
  downloadAttachment?(input: ChannelAttachmentDownloadInput): Promise<ChannelInboundAttachmentRef>;
  /**
   * Resolve an inbound attachment ref to a local file on disk. Optional —
   * adapters that wire this method enable multimodal inbound through the
   * unified `/channel-bridge/{platform}/inbound` routes. Implementations
   * are expected to write under `<dataDir>/tmp/im-attachments/<platform>/...`
   * and return an absolute path so the runner can hand it to the agent.
   *
   * Distinct from {@link downloadAttachment}, which only enriches the ref
   * with `mimeType` / `name`. New code should prefer this method.
   */
  downloadAttachmentToLocal?(
    input: ChannelAttachmentDownloadInput,
  ): Promise<ChannelInboundAttachment>;
  /**
   * Render a pending permission ask into this platform's conversation.
   * Optional: an adapter that has not wired permission cards yet simply
   * omits it, and the core `LocalChannelPermissionBridge` degrades to
   * "permission card visible in UI only" without error. Returns the
   * platform message id so the inbound side can correlate the reply.
   *
   * Used by MR-D2 core. Per-platform implementations land in MR-D3
   * (Telegram inline keyboard) / MR-D4 (Feishu interactive card).
   */
  renderPermission?(input: {
    ctx: LocalChannelContext;
    renderable: ChannelRenderablePermission;
  }): Promise<{ outboundMessageId?: string }>;
  renderQuestionnaire?(input: {
    ctx: LocalChannelContext;
    renderable: ChannelRenderableQuestionnaire;
  }): Promise<{ outboundMessageId?: string }>;
  /**
   * @deprecated Use {@link tryHandleQuestionnaireReply} instead. This
   * variant requires the caller to know which `pending` matches the
   * inbound, which forces every caller to enumerate pending state — the
   * adapter is in a better position to track that itself.
   */
  parseQuestionnaireReply?(input: {
    raw: unknown;
    pending: ChannelQuestionnairePending;
  }): Promise<AskQuestionnaireReplyPayload | null>;
  /**
   * Attempt to interpret an inbound chat event as a reply to a
   * previously-rendered questionnaire. The adapter owns its own
   * `pendingByChat` bookkeeping (recorded in `renderQuestionnaire`), so
   * the runner does not need to know which platform encoding (numbered
   * text, inline keyboard, card form) was used.
   *
   * Returns `{ ctx, reply }` when a complete reply is ready — the runner
   * then forwards to the questionnaire bridge instead of dispatching the
   * inbound as a plain user message. Returns `{ handled: true }` when the
   * adapter has consumed an intermediate platform interaction (for example
   * Telegram advancing to the next inline-keyboard step) but there is not
   * yet a complete reply to submit. Returns `null` when the inbound is
   * unrelated (normal chat), and the runner continues with its usual flow.
   *
   * Inputs are intentionally flexible:
   *   - `ctx` — the channel context the runner has already parsed from
   *     the inbound (chatId is the key into pendingByChat).
   *   - `text` — the inbound text body (numbered-text reply for WeChat).
   *   - `raw` — the raw platform event (Bot API `callback_query`, Feishu
   *     `card.action.trigger`). Adapters that need wire-level access
   *     read this; pure-text adapters can ignore it.
   *
   * Implementations MUST consume duplicates for a reply already marked
   * in-flight. The runner settles the pending entry through
   * {@link settleQuestionnaireReply}; a retryable outcome restores it.
   */
  tryHandleQuestionnaireReply?(input: {
    ctx: LocalChannelContext;
    text?: string;
    raw?: unknown;
  }): Promise<ChannelQuestionnaireReplyHandlingResult>;
  /**
   * Commit or roll back the adapter-owned pending entry after the host reply
   * route finishes. A settle failure is handled by the runner and must never
   * turn an already-handled inbound into a normal Agent turn.
   */
  settleQuestionnaireReply?(input: {
    ctx: LocalChannelContext;
    requestId: string;
    outcome: QuestionnaireReplyOutcome;
  }): Promise<void>;
  /**
   * Start a "The other party is typing" / chat-action indicator for the turn. Called by the
   * channel runner immediately before `runQueuedTurn`. Optional — adapters
   * that do not implement typing simply omit the method and the runner
   * skips the indicator. Implementations MUST be best-effort: every
   * failure must be swallowed; typing must never surface to the turn.
   */
  notifyTurnStart?(ctx: LocalChannelContext): Promise<void>;
  /**
   * Stop the typing indicator armed by {@link notifyTurnStart}. Called by
   * the channel runner after `sendCollected` returns, on both success and
   * error paths. Same best-effort contract.
   */
  notifyTurnEnd?(ctx: LocalChannelContext): Promise<void>;
  /**
   * Stop any background work this adapter owns (long-poll loops, WS
   * connections, monitor timers). Called by `host.shutdown()` on
   * graceful Node exit so AbortControllers unwind cleanly before the
   * process terminates. Implementations MUST be idempotent — a host
   * may call this multiple times during shutdown sequencing.
   *
   * Optional because not every adapter has background work (the legacy
   * mock adapter for tests does not). Implementations should NOT throw —
   * a noisy shutdown path that throws can prevent other adapters from
   * being torn down.
   */
  shutdown?(): void | Promise<void>;
  /**
   * Attempt to parse a platform callback as a reply to the given pending
   * permission ask. Returns the decoded decision behavior, or `null` when
   * the inbound is a normal message that should flow to `handleInbound`
   * instead. The bridge maps the behavior to the daemon's
   * `allowOnce / allowAlways / deny` vocabulary at the route boundary.
   */
  parsePermissionReply?(input: {
    raw: unknown;
    pending: LocalChannelPermissionPending;
  }): Promise<{ behavior: ChannelPermissionBehavior } | null>;
}
