/**
 * ChannelPlugin — multi-channel plugin architecture type definitions.
 *
 * Replaces the BaseChannelPlugin inheritance model with a composition-based
 * adapter pattern. Each channel platform implements ChannelPlugin with
 * 4 required + 6 optional adapters.
 *
 * Design references:
 * - Composition over inheritance
 * - Dual-layer separation: channel messages via adapters, complex ops via CLI
 * - OpenClaw ChannelPlugin patterns (flat adapter composition)
 */

import type { ChannelPlatform } from './channel-route.js';
import type { ChatType } from './channel-context.js';
import type { AskQuestionnaireRequest, AskQuestionnaireReplyPayload } from './questionnaire.js';

// ============================================================================
// Core Types
// ============================================================================

/**
 * Unified parsed event from any channel platform.
 * Produced by ChannelInboundAdapter.parseEvent() from raw platform events.
 */
export interface ChannelParsedEvent {
  /** Event type discriminator */
  kind: 'message' | 'card_action' | 'reaction';
  /** Source platform */
  platform: ChannelPlatform;
  /** Chat/conversation type */
  chatType: ChatType;
  /** Chat/conversation unique ID */
  chatId: string;
  /** Platform message ID */
  messageId: string;
  /** Sender user ID */
  senderId: string;
  /** Sender display name (optional, for logging) */
  senderName?: string;
  /**
   * Client/user language tag reported by the platform (e.g. 'en' / 'zh-hans').
   * Filled best-effort by the inbound adapter; consumed to localize outbound
   * copy. Absent → outbound falls back to the channel default locale.
   */
  locale?: string;
  /** Extracted text content */
  text: string;
  /** Whether the bot was @mentioned */
  hasMention: boolean;
  /** Attached files/images/audio */
  attachments: ChannelAttachment[];
  /** Original unprocessed platform event */
  rawEvent: unknown;
  /** Event timestamp (Unix ms) */
  timestamp: number;
  /**
   * Parent message ID when this message is a reply.
   * Used to fetch the original message for context injection.
   */
  parentMessageId?: string;
  /**
   * Quoted message content when this message is a reply.
   * Populated by the inbound adapter's fetchParentMessage().
   */
  quotedMessage?: {
    /** Extracted text content of the quoted message */
    text: string;
    /** Sender display name (if available) */
    senderName?: string;
  };
}

/** Attachment descriptor from inbound messages. */
export interface ChannelAttachment {
  /** Attachment type */
  type: 'image' | 'file' | 'audio' | 'video';
  /** Platform-specific resource key */
  key: string;
  /** Platform message ID that owns this resource, if different from the event message. */
  sourceMessageId?: string;
  /** Original filename (if known) */
  name?: string;
  /** MIME type (if known) */
  mimeType?: string;
  /** File size in bytes (if known) */
  size?: number;
}

/**
 * Context passed to outbound adapters for sending messages.
 * Constructed from ChannelContext by ChannelPluginRunner.
 */
export interface ChannelOutboundContext {
  /** Target chat/conversation ID */
  chatId: string;
  /** Message ID to reply to (for threading) */
  replyToMessageId?: string;
  /** Thread/topic ID (platform-specific) */
  threadId?: string;
  /** Agent session ID (for state correlation) */
  sessionId?: string;
  /** Agent display name */
  agentName?: string;
  /** Channel client instance name */
  clientName: string;
}

/** Result of a send operation. */
export interface ChannelSendResult {
  /** Whether the send was successful */
  success: boolean;
  /** Platform message ID of the sent message */
  messageId?: string;
  /** Error message if failed */
  error?: string;
}

/** Media payload for sending media messages. */
export interface ChannelMediaPayload {
  /** Media type */
  type: 'image' | 'file' | 'audio' | 'video';
  /** File path or URL */
  source: string;
  /** MIME type */
  mimeType?: string;
  /** Caption text */
  caption?: string;
}

/** Tool call step for rich reply card rendering. */
export interface ChannelToolStep {
  /** Tool name */
  name: string;
  /** Human-readable detail (file path, URL, command, etc.) */
  detail?: string;
  /** Tool call status */
  status: 'running' | 'finished' | 'failed';
  /** Tool call ID */
  callId: string;
  /** Raw tool arguments (JSON string) */
  args?: string;
}

/** Permission request for approval flow. */
export interface ChannelPermissionRequest {
  /** Unique request ID */
  requestId: string;
  /** Agent session ID */
  sessionId: string;
  /** Agent name */
  agentName: string;
  /** Human-readable description of what is being requested */
  description: string;
  /** Tool name that triggered the request */
  toolName?: string;
  /** Tool arguments (JSON) */
  toolArgs?: string;
  /** AI-generated tool description (only present for tools that provide it, e.g. bash) */
  toolDescription?: string;
  /** Human-readable tool input (command, file path, etc.) */
  toolInput?: string;
}

/** User's decision on a permission request. */
export interface ChannelPermissionDecision {
  /** Request ID being decided */
  requestId: string;
  /** User's decision */
  action: 'allow' | 'deny' | 'allow-always';
  /** User ID who made the decision */
  userId: string;
}

/** Connection probe result. */
export interface ChannelProbeResult {
  /** Whether the connection is healthy */
  healthy: boolean;
  /** Bot display name (if retrieved) */
  botName?: string;
  /** Bot platform ID (e.g., open_id for Feishu) */
  botId?: string;
  /** Auth status */
  authStatus: 'valid' | 'expired' | 'unknown' | 'ok' | 'failed';
  /** Error details if unhealthy */
  error?: string;
}

// ============================================================================
// Account Configuration
// ============================================================================

/** Platform-agnostic account configuration. */
export interface ChannelAccountConfig {
  /** Account instance name (e.g., "main-bot", "test-bot") */
  name: string;
  /** Whether this account is enabled */
  enabled: boolean;
  /** Platform identifier */
  platform: ChannelPlatform;
  /** Platform-specific credentials */
  credentials: Record<string, string>;
  /** Connection mode */
  mode?: string;
  /** Additional platform-specific options */
  options?: Record<string, unknown>;
}

// ============================================================================
// Capability Declaration
// ============================================================================

/**
 * Static capability declaration for a channel platform.
 * ChannelPluginRunner uses this to decide behavior paths instead of
 * platform-specific if/else checks.
 */
export interface ChannelCapabilities {
  /** Supported chat types */
  chatTypes: ChatType[];
  /** Supports interactive card messages */
  interactiveCards: boolean;
  /** Supports in-place card content update (streaming) */
  streamingUpdate: boolean;
  /** Supports emoji reactions */
  reactions: boolean;
  /** Supports editing sent messages */
  editMessage: boolean;
  /** Supports native threads/topics */
  threads: boolean;
  /** Supports media messages (images, files) */
  media: boolean;
  /** Supports audio messages and transcription */
  audio: boolean;
  /** Supports @mention detection */
  mentions: boolean;
  /**
   * Whether this channel requires the per-sender owner-on-first-DM gate
   * in `InboundEventHandler`.
   *
   * Public bots (Telegram, Feishu) have no platform-level per-bot
   * authentication: anyone who knows the bot's @username can DM it, so
   * the application layer must restrict each bot to a single owner
   * sender. These plugins should leave this at the default `true`.
   *
   * Bots whose platform enforces per-bot authentication (WeChat iLink
   * Bot — bound to a single authed user via QR) authenticate the user
   * at the platform level and should set this to `false` to skip the
   * owner gate entirely. Skipping the gate also avoids persisting a
   * meaningless `wechat:<agentName>` row to `channel-owner.yaml`.
   *
   * Default: `true` (preserve existing gate behavior for plugins that
   * have not yet opted in).
   */
  requiresOwnerGate?: boolean;
}

/** Plugin metadata for display/registration. */
export interface ChannelMeta {
  /** Human-readable platform name */
  label: string;
  /** Platform description */
  description?: string;
  /** Platform icon URL or emoji */
  icon?: string;
  /** Sort order for UI display */
  order?: number;
}

// ============================================================================
// Required Adapters (4)
// ============================================================================

/**
 * Config Adapter — account configuration management.
 * Responsible for listing and validating accounts from the application config.
 */
export interface ChannelConfigAdapter {
  /**
   * List all account configurations for this platform.
   * @param cfg - Raw application config object
   */
  listAccounts(cfg: Record<string, unknown>): ChannelAccountConfig[];

  /**
   * Validate an account configuration.
   * Returns validation result with potential error messages.
   */
  validateAccount(
    account: ChannelAccountConfig,
  ): { valid: true } | { valid: false; errors: string[] };

  /** Optional JSON schema for platform-specific configuration. */
  configSchema?(): Record<string, unknown>;
}

/**
 * Gateway Adapter — connection lifecycle management.
 * Manages the connection to the channel platform (WebSocket, polling, etc.).
 */
export interface ChannelGatewayAdapter {
  /**
   * Start the connection and begin receiving events.
   * Events are delivered via ctx.onRawEvent callback.
   */
  start(ctx: ChannelGatewayContext): Promise<void>;

  /**
   * Stop the connection gracefully.
   */
  stop(ctx: ChannelGatewayContext): Promise<void>;

  /**
   * Optional health probe — check connection status and credentials.
   */
  probe?(ctx: ChannelGatewayContext): Promise<ChannelProbeResult>;
}

/** Runtime context provided to the gateway adapter. */
export interface ChannelGatewayContext {
  /** Account configuration */
  account: ChannelAccountConfig;
  /** Client instance name */
  clientName: string;
  /** Data directory for persistent storage */
  dataDir: string;
  /** Callback for delivering raw platform events to ChannelPluginRunner */
  onRawEvent: (rawEvent: unknown) => Promise<void>;
  /** Signal for graceful shutdown */
  abortSignal: AbortSignal;
}

/**
 * Inbound Adapter — incoming event parsing.
 * Converts raw platform events into the unified ChannelParsedEvent format.
 */
export interface ChannelInboundAdapter {
  /**
   * Parse a raw platform event into a unified ChannelParsedEvent.
   * Returns null if the event should be ignored (unsupported type, etc.).
   *
   * May be sync or async — async is required when the adapter needs to fetch
   * additional content from the platform (e.g. expanding Feishu merge_forward
   * by calling GET /messages/{id}). Existing sync implementations remain valid.
   */
  parseEvent(
    rawEvent: unknown,
    ctx: ChannelInboundContext,
  ): (ChannelParsedEvent | null) | Promise<ChannelParsedEvent | null>;

  /**
   * Download an attachment from the platform.
   * Returns the local file path of the downloaded file.
   */
  downloadAttachment?(
    event: ChannelParsedEvent,
    attachment: ChannelAttachment,
    ctx: ChannelInboundContext,
  ): Promise<string>;

  /**
   * Transcribe an audio file to text.
   * Returns the transcription text.
   */
  transcribeAudio?(audioPath: string, ctx: ChannelInboundContext): Promise<string>;

  /**
   * Fetch the content of a parent message (for reply context).
   * Returns the text content and optional sender name, or null if not available.
   */
  fetchParentMessage?(
    parentMessageId: string,
    ctx: ChannelInboundContext,
  ): Promise<{ text: string; senderName?: string } | null>;
}

/** Context provided to inbound adapter methods. */
export interface ChannelInboundContext {
  /** Client instance name */
  clientName: string;
  /** Account configuration */
  account: ChannelAccountConfig;
  /** Data directory */
  dataDir: string;
  /** Bot's platform user ID (for @mention detection) */
  botId?: string;
}

/**
 * Outbound Adapter — message sending.
 * Handles sending messages to the channel platform.
 */
export interface ChannelOutboundAdapter {
  /**
   * Send a text message to a chat.
   */
  sendText(ctx: ChannelOutboundContext, text: string): Promise<ChannelSendResult>;

  /**
   * Reply to a specific message (for threading/quoting).
   */
  replyTo?(
    ctx: ChannelOutboundContext,
    messageId: string,
    text: string,
  ): Promise<ChannelSendResult>;

  /**
   * Send a media message (image, file, audio, video).
   */
  sendMedia?(ctx: ChannelOutboundContext, media: ChannelMediaPayload): Promise<ChannelSendResult>;

  /** Maximum text length for a single message. */
  textLimit: number;

  /**
   * Split text into chunks respecting the platform's message length limit.
   * If not provided, ChannelPluginRunner uses a default paragraph-aware splitter.
   */
  chunkText?(text: string, limit: number): string[];
}

// ============================================================================
// Optional Adapters (6)
// ============================================================================

/**
 * RichReply Adapter — interactive card message lifecycle.
 * Implements the Thinking -> Working -> Done card state machine.
 * Only used when capabilities.interactiveCards is true.
 */
export interface ChannelRichReplyAdapter {
  /**
   * Send an initial queued card/message. Returns the card/message ID.
   * Used when a session already has work ahead of this inbound message.
   */
  sendQueued?(
    ctx: ChannelOutboundContext,
    userText: string,
    queueInfo: ChannelQueueInfo,
  ): Promise<string>;

  /**
   * Update an existing queued card/message to the initial thinking state.
   */
  updateThinking?(ctx: ChannelOutboundContext, cardMsgId: string, userText: string): Promise<void>;

  /**
   * Send initial "thinking" card. Returns the card message ID.
   */
  sendThinking(ctx: ChannelOutboundContext, userText: string): Promise<string>;

  /**
   * Update the card to "working" state with tool call progress.
   */
  updateWorking(
    ctx: ChannelOutboundContext,
    cardMsgId: string,
    steps: ChannelToolStep[],
    currentStep: string,
    elapsed: number,
  ): Promise<void>;

  /**
   * Update the card to "done" state with the final response.
   */
  updateDone(
    ctx: ChannelOutboundContext,
    cardMsgId: string,
    text: string,
    steps: ChannelToolStep[],
  ): Promise<void>;

  /**
   * Update the card to show an error state.
   */
  updateError?(
    ctx: ChannelOutboundContext,
    cardMsgId: string,
    error: string,
    info?: ChannelSessionErrorInfo,
  ): Promise<void>;

  /**
   * Send a standalone error card/message (no prior thinking card needed).
   * Used for delayed follow-up failures.
   */
  sendError?(
    ctx: ChannelOutboundContext,
    error: string,
    info?: ChannelSessionErrorInfo,
  ): Promise<string>;

  /**
   * Send a standalone "done" card (no prior thinking card needed).
   * Used for follow-up messages that should appear as cards, not plain text.
   */
  sendDone?(ctx: ChannelOutboundContext, text: string): Promise<string>;

  /**
   * Send a standalone "BTW" (peek / side-channel) reply card.
   * Carries a BTW tag so users can tell it apart from the main reply.
   * Optional — text-only channels fall back to a text prefix.
   */
  sendPeek?(ctx: ChannelOutboundContext, text: string): Promise<string>;
}

export interface ChannelSessionErrorInfo {
  message: string;
  errorCode?: number;
  actionText?: string;
  actionUrl?: string;
}

export interface ChannelQueueInfo {
  /** 1-based position among queued messages, excluding the currently running turn. */
  position: number;
  /** Queued messages before this item. */
  queuedAhead: number;
  /** Currently running turn ahead of this item, if any. */
  activeAhead: number;
  /** Total messages/turns ahead from the user's perspective. */
  totalAhead: number;
}

/**
 * Auth Adapter — read-side access to the current user token.
 *
 * The platform-specific OAuth/device-code flow that *acquires* the user
 * token lives outside this adapter — for Feishu, it is delegated to
 * `lark-cli auth login --recommend` driven by the daemon's onboard
 * route. The adapter exists so the channel-bridge runtime can read the
 * current UAT (refreshing on the fly if needed) without knowing the
 * platform-specific store layout.
 */
export interface ChannelAuthAdapter {
  /**
   * Get the current user token, or null if not authenticated.
   */
  getUserToken(accountId: string): Promise<string | null>;
}

/**
 * Actions Adapter — message-level operations.
 * Handles reactions, message editing, deletion, etc.
 */
export interface ChannelActionsAdapter {
  /**
   * Add an emoji reaction to a message.
   */
  addReaction?(ctx: ChannelOutboundContext, messageId: string, emoji: string): Promise<void>;

  /**
   * Remove an emoji reaction from a message.
   */
  removeReaction?(ctx: ChannelOutboundContext, messageId: string, emoji: string): Promise<void>;

  /**
   * Edit a previously sent message.
   */
  editMessage?(ctx: ChannelOutboundContext, messageId: string, newText: string): Promise<void>;

  /**
   * Delete a message.
   */
  deleteMessage?(ctx: ChannelOutboundContext, messageId: string): Promise<void>;

  /**
   * Start a typing/processing indicator. Returns a cleanup function.
   * Called by PluginRunner on inbound message; cleanup called in finally block.
   */
  startTypingIndicator?(messageId: string): () => void;
}

/**
 * Approval Adapter — permission request/approval flow.
 * Handles interactive permission cards and user approval decisions.
 */
export interface ChannelApprovalAdapter {
  /**
   * Send a permission request card. Returns the card message ID.
   */
  sendPermissionAsk(
    ctx: ChannelOutboundContext,
    request: ChannelPermissionRequest,
  ): Promise<string>;

  /**
   * Embed permission action buttons into a "done" card payload.
   */
  embedInDoneCard?(cardPayload: unknown, requests: ChannelPermissionRequest[]): unknown;

  /**
   * Parse a raw event into a permission decision, or null if not a permission action.
   */
  parsePermissionAction(rawEvent: unknown): ChannelPermissionDecision | null;
}

/**
 * Result of parsing a questionnaire card-action submit event. Carries the
 * structured reply (already mapped from the card's `form_value`) plus the
 * routing context embedded in the submit button's `value` so the handler can
 * dispatch the reply to the right session without an extra store lookup.
 */
export interface ChannelQuestionnaireSubmit {
  requestId: string;
  sessionId?: string;
  reply: AskQuestionnaireReplyPayload;
}

/**
 * Questionnaire Adapter — interactive `ask_user` (V2 questionnaire) flow for
 * card-capable channels (Feishu). Mirrors {@link ChannelApprovalAdapter}:
 * card-capable channels implement it to render a form card and parse the
 * submit callback; text-only channels (WeChat) omit it and the handler falls
 * back to a numbered-text round-trip via the outbound adapter.
 */
export interface ChannelQuestionnaireAdapter {
  /**
   * Send a questionnaire form card. Returns the card message ID (empty on
   * failure so the handler can retry).
   */
  sendQuestionnaireAsk(
    ctx: ChannelOutboundContext,
    request: AskQuestionnaireRequest,
  ): Promise<string>;

  /**
   * Parse a raw card-action submit event into a structured reply, or null
   * when the event is not a questionnaire submit.
   */
  parseQuestionnaireSubmit(rawEvent: unknown): ChannelQuestionnaireSubmit | null;

  /**
   * Best-effort: update the card to a "submitted" state once the answers
   * have been forwarded to the agent.
   */
  updateCardAsSubmitted?(messageId: string, request: AskQuestionnaireRequest): Promise<void>;
}

/**
 * Threading Adapter — thread/topic management.
 * Handles platform-specific thread semantics.
 */
export interface ChannelThreadingAdapter {
  /**
   * Resolve the thread ID for a reply.
   * Different platforms have different threading models.
   */
  resolveThreadId?(event: ChannelParsedEvent): string | undefined;

  /**
   * Create a new thread from a message.
   */
  createThread?(ctx: ChannelOutboundContext, messageId: string, title?: string): Promise<string>;

  /**
   * Send a message into an existing thread.
   */
  sendToThread?(
    ctx: ChannelOutboundContext,
    threadId: string,
    text: string,
  ): Promise<ChannelSendResult>;
}

/**
 * Directory Adapter — user/group directory queries.
 * Provides lookup capabilities for platform users and groups.
 */
export interface ChannelDirectoryAdapter {
  /**
   * Get the bot's own identity on the platform.
   */
  self?(ctx: ChannelInboundContext): Promise<ChannelDirectoryEntry | null>;

  /**
   * List available peer users (DM targets).
   */
  listPeers?(ctx: ChannelInboundContext): Promise<ChannelDirectoryEntry[]>;

  /**
   * List available groups/channels.
   */
  listGroups?(ctx: ChannelInboundContext): Promise<ChannelDirectoryEntry[]>;

  /**
   * List members of a specific group.
   */
  listGroupMembers?(ctx: ChannelInboundContext, groupId: string): Promise<ChannelDirectoryEntry[]>;
}

/** Directory entry representing a user or group. */
export interface ChannelDirectoryEntry {
  /** Platform user/group ID */
  id: string;
  /** Display name */
  name: string;
  /** Entry type */
  type: 'user' | 'group' | 'bot';
  /** Avatar URL */
  avatarUrl?: string;
}

// ============================================================================
// Plugin Main Contract
// ============================================================================

/**
 * ChannelPlugin — the main plugin interface for a channel platform.
 *
 * Each channel platform (Feishu, Telegram, Slack, etc.) implements this
 * interface with 4 required adapters and any applicable optional adapters.
 *
 * ChannelPluginRunner consumes this interface to drive message dispatch,
 * using capabilities + adapter presence to determine behavior paths.
 * No platform-specific logic exists in the Runner.
 */
export interface ChannelPlugin {
  /** Platform identifier (unique across all plugins) */
  readonly id: ChannelPlatform;
  /** Plugin metadata for display */
  readonly meta: ChannelMeta;
  /** Static capability declaration */
  readonly capabilities: ChannelCapabilities;

  // --- Required Adapters ---
  /** Account configuration management */
  readonly config: ChannelConfigAdapter;
  /** Connection lifecycle (WebSocket, polling, etc.) */
  readonly gateway: ChannelGatewayAdapter;
  /** Incoming event parsing */
  readonly inbound: ChannelInboundAdapter;
  /** Message sending */
  readonly outbound: ChannelOutboundAdapter;

  // --- Optional Adapters ---
  /** Interactive card message lifecycle (Thinking -> Working -> Done) */
  readonly richReply?: ChannelRichReplyAdapter;
  /** User authentication flow */
  readonly auth?: ChannelAuthAdapter;
  /** Message-level operations (reactions, edit, delete) */
  readonly actions?: ChannelActionsAdapter;
  /** Permission request/approval flow */
  readonly approval?: ChannelApprovalAdapter;
  /** Interactive questionnaire (ask_user / V2) flow for card-capable channels */
  readonly questionnaire?: ChannelQuestionnaireAdapter;
  /** Thread/topic management */
  readonly threading?: ChannelThreadingAdapter;
  /** User/group directory queries */
  readonly directory?: ChannelDirectoryAdapter;
}
