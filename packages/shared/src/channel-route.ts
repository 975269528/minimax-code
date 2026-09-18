/**
 * Channel Route Mapping types.
 *
 * Defines the data model for configurable channel/user → Agent/Session routing.
 * Route rules are stored in <dataDir>/channel-routes.yaml.
 */

export type ChannelPlatform = 'feishu' | 'telegram' | 'wechat';

/**
 * Session strategy determines how incoming channel messages are mapped to sessions.
 *
 * - root:        Route to the target agent's root session (ensureRootSession),
 *                formerly named 'main'.
 * - per-sender:  One task session per sender ID, title: `{platform}:{senderId}`.
 * - per-chat:    One task session per chat/channel ID, title: `{platform}-chat-{chatId}`.
 * - shared-task: A single shared task session with an explicit title template.
 *
 * @deprecated 'main' is accepted as a legacy alias for 'root'; consumers normalize
 * at intake. Removal target: 2 minor releases.
 */
export type SessionStrategy = 'root' | 'main' | 'per-sender' | 'per-chat' | 'shared-task' | 'pin';

/** Normalized session strategy after intake (never contains 'main'). */
export type NormalizedSessionStrategy = Exclude<SessionStrategy, 'main'>;

/**
 * Rootless routing intent persisted by Channel v2.
 *
 * `project-main` means the most recent visible top-level conversation inside
 * one canonical Project.  It is an ordinary Session, never an Agent Root.
 */
export type ChannelRoutingMode = 'project-main' | 'per-sender' | 'per-chat' | 'shared-task';

/** Normalize a SessionStrategy: legacy 'main' → 'root'. */
export function normalizeSessionStrategy(strategy: SessionStrategy): NormalizedSessionStrategy {
  return strategy === 'main' ? 'root' : strategy;
}

/** Keep every legacy Root-shaped intent readable while making v2 Rootless. */
export function channelRoutingModeForStrategy(strategy: SessionStrategy): ChannelRoutingMode {
  switch (strategy) {
    case 'per-sender':
    case 'per-chat':
    case 'shared-task':
      return strategy;
    case 'root':
    case 'main':
    case 'pin':
      return 'project-main';
  }
}

export interface ChannelRouteMatch {
  /** Chat type filter: 'group' | 'p2p' | 'private' | 'supergroup' | '*' */
  chatType: string;
  /** Specific chat/channel ID. Empty or omitted = wildcard. */
  chatId?: string;
  /** Specific sender ID. Empty or omitted = wildcard. */
  senderId?: string;
  /** Channel client name filter. Empty or omitted = wildcard. */
  clientName?: string;
}

export interface ChannelRouteTarget {
  /** Which agent receives the message. */
  agentId: string;
  /** How the session is selected/created. */
  sessionStrategy: SessionStrategy;
  /** Template for shared-task title. Supports {chatId}, {senderId}, {platform} placeholders. */
  sessionTitle?: string;
  /** Exact canonical Agent owner. Additive v2 mirror of `agentId`. */
  exactOwnerName?: string;
  /** Custom-Agent incarnation fence. Builtin targets omit this field. */
  ownerInstanceId?: string;
  /** Canonical Project identity (`default` or `workspace:<absolute-path>`). */
  projectKey?: string;
  /** Rootless routing intent. */
  routingMode?: ChannelRoutingMode;
  /** Optional explicit concrete Session target. */
  sessionId?: string;
  /** Monotonic target generation used by compare-and-set writers. */
  generation?: number;
}

export interface ChannelRouteRule {
  /** Unique identifier, kebab-case. */
  id: string;
  /** Platform this rule applies to. */
  platform: ChannelPlatform;
  /** Matching criteria for incoming messages. */
  match: ChannelRouteMatch;
  /** Where to route matched messages. */
  target: ChannelRouteTarget;
  /** Whether this rule is active. */
  enabled: boolean;
  /** Priority — lower number = higher priority. First match wins. */
  priority: number;
  /** For group chats: require @bot mention? null = use bridge default. */
  requireMention?: boolean;
  /** Unix-ms creation timestamp. */
  createdAt: number;
  /** Unix-ms last-update timestamp. */
  updatedAt: number;
}

export interface ChannelRouteDefaultTarget {
  agentId: string;
  sessionStrategy: SessionStrategy;
  exactOwnerName?: string;
  ownerInstanceId?: string;
  projectKey?: string;
  routingMode?: ChannelRoutingMode;
  sessionId?: string;
  generation?: number;
}

export interface ChannelRouteDefaults {
  feishu: ChannelRouteDefaultTarget;
  telegram: ChannelRouteDefaultTarget;
  wechat: ChannelRouteDefaultTarget;
}

export interface ChannelRouteConfig {
  schemaVersion: number;
  rules: ChannelRouteRule[];
  defaultRoute: ChannelRouteDefaults;
}

/** Context for an incoming channel message, used by the route resolver. */
export interface ChannelMessageContext {
  platform: ChannelPlatform;
  chatType: string;
  chatId: string;
  /** Original message ID, used for reply-in-thread. */
  messageId?: string;
  senderId: string;
  hasMention: boolean;
  /** Channel client name from config (e.g., "main-bot") */
  clientName?: string;
}

/** Result of route resolution. */
export interface ResolvedRoute {
  agentId: string;
  sessionId: string;
  /** The rule that matched, or null if the default route was used. */
  ruleId: string | null;
}

// ---------------------------------------------------------------------------
// Agent-level channel configuration
// ---------------------------------------------------------------------------

/** Session binding strategy for agent channel config. */
export interface AgentChannelSessionConfig {
  /** How incoming channel messages are mapped to sessions. */
  strategy: SessionStrategy;
  /** When strategy='pin', route all messages to this specific session. */
  pinnedSessionId?: string | null;
}

/** Message filter config for agent channel output. */
export interface AgentChannelMessageFilter {
  /** 'result' keeps only the last text segment; 'full' sends everything. */
  mode: 'result' | 'full';
  /** Whether to append a tool-call summary at the end of the reply. */
  includeToolSummary: boolean;
}

/** Per-platform channel binding config inside an agent. */
export interface AgentChannelPlatformConfig {
  /** Bot app ID (Feishu). */
  appId?: string;
  /** Bot app secret (Feishu). */
  appSecret?: string;
  /** Bot token (Telegram). */
  botToken?: string;
  /** For group chats: require @bot mention before processing incoming messages. */
  requireMention?: boolean;
  /** Session binding strategy. */
  session?: AgentChannelSessionConfig;
  /** Message filter. */
  messageFilter?: AgentChannelMessageFilter;
}

/** Top-level channel config in config.yaml. */
export interface AgentChannelConfig {
  feishu?: AgentChannelPlatformConfig;
  telegram?: AgentChannelPlatformConfig;
  wechat?: AgentChannelPlatformConfig;
}

// ---------------------------------------------------------------------------
// Channel Session Binding (runtime state)
// ---------------------------------------------------------------------------

/** Runtime binding between a channel conversation and an agent session. */
export interface ChannelSessionBinding {
  /** Composite key: clientName:chatId:senderId */
  agentId: string;
  sessionId: string;
  strategy: SessionStrategy;
  /** Whether this binding was manually pinned (overrides strategy). */
  pinned: boolean;
  /** Unix-ms last-update timestamp. */
  updatedAt: number;
  /** Exact canonical Agent owner. Additive v2 mirror of `agentId`. */
  exactOwnerName?: string;
  /** Custom-Agent incarnation fence. Builtin bindings omit this field. */
  ownerInstanceId?: string;
  /** Canonical Project identity. */
  projectKey?: string;
  /** Rootless routing intent. */
  routingMode?: ChannelRoutingMode;
  /** Monotonic binding generation. */
  generation?: number;
}
