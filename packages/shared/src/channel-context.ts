/**
 * Channel Context & Trace Context types for the multi-channel plugin architecture.
 *
 * ChannelContext unifies the scattered context objects (ChannelMessageContext, MessageOrigin,
 * RequestContext) into a single object that flows through the entire message pipeline.
 *
 * TraceContext provides distributed-tracing semantics (traceId + spanId + parentSpanId)
 * for end-to-end message tracing from IM platform to agent response.
 */

import { randomUUID, getRandomValues } from 'node:crypto';
import type { ChannelPlatform, SessionStrategy } from './channel-route.js';

// ---------------------------------------------------------------------------
// TraceContext
// ---------------------------------------------------------------------------

/**
 * Distributed tracing context for a single message processing chain.
 *
 * Lifecycle: created when the Gateway receives a raw event, propagated through
 * inbound parsing → routing → agent processing → outbound response.
 */
export interface TraceContext {
  /** Global trace ID spanning the entire processing chain (32-char hex, UUID without dashes). */
  readonly traceId: string;
  /** Current span ID within the trace (16-char hex). */
  readonly spanId: string;
  /** Parent span ID — used to build the span tree. */
  readonly parentSpanId?: string;
  /** Message source identifier: `{platform}:{clientName}`. */
  readonly source: string;
  /** Inbound platform message ID — correlates with platform-side logs. */
  readonly platformMessageId?: string;
  /** Span creation timestamp (Unix ms). */
  readonly startedAt: number;
}

// ---------------------------------------------------------------------------
// ChannelContext
// ---------------------------------------------------------------------------

/** Chat type across IM platforms. */
export type ChatType = 'p2p' | 'group' | 'channel' | 'thread';

/**
 * Unified channel context carried from message receipt to response delivery.
 *
 * Replaces the combination of ChannelMessageContext + MessageOrigin + RequestContext
 * with a single object that contains identity, message, routing, and tracing info.
 */
export interface ChannelContext {
  // ── Identity (where the message came from) ──
  /** IM platform identifier. */
  readonly platform: ChannelPlatform;
  /** Client instance name as defined in config (e.g. "main-bot", "test-bot"). */
  readonly clientName: string;
  /** Chat/channel ID (Feishu chat_id, Telegram chat_id, etc.). */
  readonly chatId: string;
  /** Chat type. */
  readonly chatType: ChatType;
  /** Sender's platform user ID. */
  readonly senderId: string;
  /** Sender display name (optional, for logging). */
  readonly senderName?: string;
  /**
   * Client/user language tag (e.g. 'en' / 'zh-Hans') as reported by the
   * platform on inbound. Used to localize outbound IM copy; filled best-effort
   * per platform. Absent → outbound code falls back to the channel default.
   */
  readonly locale?: string;

  // ── Message identification ──
  /** Platform-native message ID. */
  readonly platformMessageId: string;
  /** Thread/topic ID (Feishu root_id, Slack thread_ts, etc.). */
  readonly threadId?: string;
  /** Whether the bot was @-mentioned. */
  readonly hasMention: boolean;

  // ── Routing (populated after route resolution) ──
  /** Binding composite key: `{clientName}:{chatId}:{senderId}`. */
  readonly bindingKey: string;
  /** Target agent ID — filled by route resolver. */
  agentId?: string;
  /** Target session ID — filled by route resolver. */
  sessionId?: string;
  /** Routing strategy used. */
  sessionStrategy?: SessionStrategy;

  // ── Tracing ──
  /** End-to-end trace context. */
  readonly trace: TraceContext;

  // ── Timestamps ──
  /** Message receive time (Unix ms). */
  readonly receivedAt: number;
}

// ---------------------------------------------------------------------------
// Factory: TraceContext
// ---------------------------------------------------------------------------

/**
 * Generate a 32-char hex trace ID (UUID without dashes).
 * Compatible with the existing `RequestContext.traceId` format.
 */
function generateTraceId(): string {
  return randomUUID().replace(/-/g, '');
}

/** Generate a 16-char hex span ID. */
function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Create a root TraceContext for a new inbound message. */
export function createTraceContext(
  platform: ChannelPlatform,
  clientName: string,
  platformMessageId?: string,
): TraceContext {
  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    source: `${platform}:${clientName}`,
    ...(platformMessageId !== undefined ? { platformMessageId } : {}),
    startedAt: Date.now(),
  };
}

/** Derive a child span under an existing trace (e.g. agent call, tool execution). */
export function childSpan(parent: TraceContext): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: generateSpanId(),
    parentSpanId: parent.spanId,
    source: parent.source,
    ...(parent.platformMessageId !== undefined
      ? { platformMessageId: parent.platformMessageId }
      : {}),
    startedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Factory: ChannelContext
// ---------------------------------------------------------------------------

/** Minimal input for constructing a ChannelContext from a parsed IM event. */
export interface ChannelContextParams {
  platform: ChannelPlatform;
  chatId: string;
  chatType: ChatType;
  senderId: string;
  senderName?: string;
  /** Client/user language tag (e.g. 'en' / 'zh-Hans'); optional, best-effort. */
  locale?: string;
  messageId: string;
  threadId?: string;
  hasMention: boolean;
  timestamp?: number;
}

/**
 * Build a ChannelContext from parsed event data.
 *
 * The `params` shape is intentionally decoupled from `ChannelParsedEvent` to avoid
 * circular imports — callers extract the needed fields from their event type.
 */
export function createChannelContext(
  params: ChannelContextParams,
  clientName: string,
): ChannelContext {
  const trace = createTraceContext(params.platform, clientName, params.messageId);
  return {
    platform: params.platform,
    clientName,
    chatId: params.chatId,
    chatType: params.chatType,
    senderId: params.senderId,
    ...(params.senderName !== undefined ? { senderName: params.senderName } : {}),
    ...(params.locale !== undefined ? { locale: params.locale } : {}),
    platformMessageId: params.messageId,
    ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
    hasMention: params.hasMention,
    bindingKey: `${clientName}:${params.chatId}:${params.senderId}`,
    trace,
    receivedAt: params.timestamp ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Compatibility bridges
// ---------------------------------------------------------------------------

/**
 * Convert a ChannelContext to the legacy `RequestContext` shape.
 * This enables gradual migration — HTTP/Hono handlers that expect RequestContext
 * can consume the trace ID from the IM pipeline.
 */
export function toRequestContext(ctx: ChannelContext): { traceId: string } {
  return { traceId: ctx.trace.traceId };
}

/** Convert a standalone TraceContext to RequestContext. */
export function traceToRequestContext(trace: TraceContext): { traceId: string } {
  return { traceId: trace.traceId };
}

// ---------------------------------------------------------------------------
// InboundContext — metadata about where an inbound message came from
// ---------------------------------------------------------------------------

/**
 * Inbound message context — metadata about where a message came from.
 *
 * Constructed by ChannelPluginRunner from ChannelParsedEvent + ChannelContext,
 * attached to MessageRequest, and injected into the model's prompt so the
 * model can adapt behavior based on source platform, chat type, sender, etc.
 *
 * Design: Two-layer injection modeled after OpenClaw:
 * - Trusted layer (system-level): platform, chatType, responseFormat → <system-reminder>
 * - Untrusted layer (message-level): sender, messageId, timestamp → content prefix
 */
export interface InboundContext {
  // ── Trusted metadata (system-level, cache-friendly) ──
  /** Source platform identifier. */
  platform: ChannelPlatform;
  /** Chat type. */
  chatType: ChatType;
  /** Whether this is a group chat (convenience flag). */
  isGroupChat: boolean;
  /** Bot account name / instance name. */
  accountName: string;

  // ── Untrusted metadata (per-message, sender-controlled) ──
  /** Sender's platform user ID. */
  senderId: string;
  /** Sender display name (may be attacker-controlled in group chats). */
  senderName?: string;
  /** Platform message ID. */
  messageId: string;
  /** Whether the bot was @-mentioned. */
  hasMention: boolean;
  /** Message timestamp (Unix ms). */
  timestamp: number;

  // ── Source discriminator ──
  /** Message source type for conditional injection. */
  sourceType: 'channel' | 'cron' | 'cron-report' | 'api' | 'delegation' | 'internal-cron';

  // ── Cron-specific fields (only when sourceType === 'cron' or 'cron-report') ──
  /** Cron task name. */
  cronName?: string;
  /** Cron schedule expression. */
  cronSchedule?: string;

  // ── Reply context (only when the message is a reply to another message) ──
  /** Quoted/replied-to message content. */
  quotedMessage?: {
    /** Text content of the original message being replied to. */
    text: string;
    /** Display name of the original message sender (if available). */
    senderName?: string;
  };
}
