/**
 * Cron subsystem host ports — structural interfaces consumed by
 * `CronExecutor` and `CronRegistry`.
 *
 * Daemon's concrete classes (`CronStore`, `SessionService`, `AgentManager`,
 * `MultiChannelClient`, `MessageQueue`) satisfy these interfaces by shape;
 * no `implements` declaration required. The ports below name only the
 * methods the agent-core cron orchestrator actually invokes — adding new
 * features should grow the port deliberately.
 *
 * Cross-cutting helpers (`logger`, `getMetricsReporter`, `backgroundCtx`,
 * `AppError`, `nowMs`, `formatLocalMonthDayTime`) are configured through
 * `configureCronHost`; this file only declares cron-specific ports.
 */

import type { ChannelPlatform } from '@mavis/shared';
import type { RespData } from '@mavis/agent-core/protocol/agent-message';
import type { RequestContext } from './host-utils.js';
import type { CronConfig, CronConfigUpdate } from './types.js';

// ─── Session bridge / event bus ports ────────────────────────────────────

export const Role = {
  User: 'user',
  Agent: 'agent',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export type MessageSource =
  | 'api'
  | 'channel:feishu'
  | 'channel:telegram'
  | 'cron'
  | 'cron-report'
  | 'communication'
  | 'team-engine'
  | 'system';

export interface MessageOrigin {
  platform: ChannelPlatform;
  clientName: string;
  chatId: string;
  senderId?: string;
  threadId?: string;
  messageId?: string;
}

export interface AgentMessage {
  rawData: string;
  end: boolean;
  respData?: RespData;
  error?: {
    message: string;
    errorCode?: number;
  };
  turnId?: string;
  source?: MessageSource;
  origin?: MessageOrigin;
}

// ─── Cron store port ─────────────────────────────────────────────────────

/**
 * A single run record for a cron task that uses session mode 'new'.
 * Stored in the companion `<cronName>.sessions.json` file by the daemon.
 */
export interface CronSessionRecord {
  /** Session ID created for this cron run. */
  sessionId: string;
  /** Unix-ms timestamp when the session was created. */
  createdAt: number;
}

export interface CronLoadResult {
  agentName: string;
  cronName: string;
  config: CronConfig;
  configPath: string;
  /**
   * Stable cron identifier (cron_id) persisted by the store. Optional so
   * existing structural implementations (daemon/cloud) that do not yet carry
   * a cron_id keep satisfying this contract unchanged.
   */
  cronId?: string;
}

/**
 * Structural port for the on-disk cron config store. Daemon's SQLite-backed
 * `CronStore` (filesystem-backed `.md` configs + JSON history) satisfies
 * this contract; cloud hosts can supply an alternative (e.g. remote API
 * proxy) without code changes inside agent-core.
 *
 * All methods are async to allow non-blocking implementations.
 */
export interface CronStorePort {
  /** Resolve config.yaml path for a cron job. */
  configPath(agentName: string, cronName: string): Promise<string>;

  /** Load a single cron config. Returns undefined if not found or invalid. */
  get(agentName: string, cronName: string): Promise<CronConfig | undefined>;

  /** List all cron configs for a specific agent. */
  listByAgent(agentName: string): Promise<CronLoadResult[]>;

  /** List all cron configs across all agents. Used at startup. */
  listAll(): Promise<CronLoadResult[]>;

  /**
   * OPTIONAL: load a single cron by its stable cron_id. Presence of this
   * method lets callers address crons by id (archon_biz cron contract
   * parity). Stores that do not persist a cron_id omit it; the engine keeps
   * keying on (agentName, cronName) regardless.
   */
  getByCronId?(cronId: string): Promise<CronLoadResult | undefined>;

  /**
   * OPTIONAL: resolve the (agentName, cronName) key for a cron_id without
   * loading the full config. Companion to {@link getByCronId}; omitted by
   * stores without cron_id persistence.
   */
  resolveKeyByCronId?(cronId: string): Promise<{ agentName: string; cronName: string } | undefined>;

  /** Create a new cron config; throws if one already exists or validation fails. */
  create(agentName: string, cronName: string, config: CronConfig): Promise<CronConfig>;

  /** Update specific fields in a cron config; null clears optional fields. */
  update(agentName: string, cronName: string, fields: CronConfigUpdate): Promise<CronConfig>;

  /** Delete a cron config file from disk. */
  delete(agentName: string, cronName: string): Promise<void>;

  // ── Session history ───────────────────────────────────────────────

  /** Append a session run record to the cron's session history (best-effort). */
  appendSessionRun(agentName: string, cronName: string, record: CronSessionRecord): Promise<void>;

  /** Read the ordered session history for a cron task (oldest first). */
  getSessionHistory(agentName: string, cronName: string): Promise<CronSessionRecord[]>;

  /** Replace the persisted cron session history with the supplied records. */
  replaceSessionHistory(
    agentName: string,
    cronName: string,
    records: CronSessionRecord[],
  ): Promise<void>;

  /** Delete the session history file for a cron task. */
  deleteSessionHistory(agentName: string, cronName: string): Promise<void>;
}

// ─── Session service / spawner ports ─────────────────────────────────────

/**
 * Numeric session-type discriminator used by cron retention.
 *
 * Numeric session-type discriminator used by cron retention.
 * Values match persisted runtime sessions: 0 = Branch, 1 = Root.
 */
export const enum CronSessionType {
  Branch = 0,
  Root = 1,
}

/** Subset of session status surface the cron executor inspects. */
export type CronSessionStatus =
  | { type: 'started' }
  | { type: 'finished' }
  | { type: 'error'; message?: string; errorCode?: number }
  | { type: 'aborted' }
  | { type: 'interrupted' };

/** Minimum session-info shape the cron executor reads. */
export interface CronSessionInfo {
  sessionId: string;
  agentName: string;
  /**
   * Numeric session type — Branch (0) or Root (1). Cron retention skips
   * Root sessions defensively (cron always spawns Branch sessions).
   */
  sessionType: number;
  /** True when the session has been compressed (archived / compacted out). */
  compressed?: boolean;
  /** Active runtime status; cron checks for 'started' to enqueue. */
  status?: { type: string };
  /** Machine-readable purpose tag, e.g. `cron:<agent>:<cron>`. */
  purpose?: string;
}

/**
 * Subset of `SessionService` consumed by cron — the methods CronExecutor
 * invokes when resolving root sessions, archiving completed runs, and
 * cleaning up after a cron task is deleted.
 */
export interface SessionLifecyclePort {
  getRootSession(agentName: string): Promise<CronSessionInfo | undefined>;
  getSession(sessionId: string): Promise<CronSessionInfo | undefined>;
  getSessionStatus(ctx: RequestContext, sessionId: string): Promise<CronSessionStatus>;
  setSessionArchived(sessionId: string, archived: boolean): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  /**
   * List sessions whose purpose starts with the given prefix.
   * Used by orphan cron session cleanup to find sessions that escaped
   * history-file based deletion.
   */
  listByPurposePrefix?(purposePrefix: string): Promise<CronSessionInfo[]>;
  /** Optional title-seeding helper used after creating a 'new' mode session. */
  seedGeneratedTitle?: (
    sessionId: string,
    title: string,
    options?: { onlyIfEmpty?: boolean },
  ) => Promise<void>;
}

/**
 * Subset of `AgentManager` consumed by cron when `session.mode === 'new'`.
 * Daemon's `AgentManager.newSession` satisfies this shape directly.
 */
export interface AgentSpawnerPort {
  newSession(
    ctx: RequestContext,
    agentName: string,
    workspaceDir?: string,
    parentSessionId?: string,
    title?: string,
    taskTreeId?: string | null,
    teamModeOff?: boolean,
    options?: { visibility?: 'visible' | 'hidden'; purpose?: string },
  ): Promise<{ sessionId: string }>;
}

// ─── Channel delivery port ───────────────────────────────────────────────

/** Minimum runner shape consumed by cron delivery. */
export interface CronChannelRunner {
  readonly isRunning: boolean;
  sendProactiveMessage(chatId: string, text: string, meta?: { sessionId?: string }): Promise<void>;
}

/**
 * A single IM chat binding for an agent, already parsed into its
 * components. Daemon's `ChannelBindingStore` keys
 * (`{clientName}:{chatId}:{senderId}`) and local-runtime's structured
 * `LocalChannelBinding` records both project onto this shape; the host
 * owns the parsing so the executor never sees key formats. Bindings may
 * repeat the same `(clientName, chatId)` pair for different senders —
 * the executor dedupes before sending.
 */
export interface CronChannelBinding {
  /** Channel client identifier accepted by {@link ChannelDeliveryPort.getRunner}. */
  clientName: string;
  chatId: string;
}

/**
 * Subset of `MultiChannelClient` consumed by cron when a delivery target
 * is configured. Daemon's MultiChannelClient.getRunner satisfies this
 * structurally.
 */
export interface ChannelDeliveryPort {
  getRunner(clientId: string): CronChannelRunner | undefined;
  /**
   * OPTIONAL: list the IM chat bindings of an agent. Presence of this
   * method enables IM auto-delivery, which fans the raw LLM result out to
   * every bound chat after the turn. Hosts
   * without per-agent binding storage omit it and auto-delivery is
   * skipped; existing implementations remain valid unchanged.
   */
  listBindingsByAgent?(agentName: string): Promise<CronChannelBinding[]>;
}

// ─── Message queue port ──────────────────────────────────────────────────

/**
 * Subset of `MessageQueue` consumed by cron — the executor enqueues each
 * cron-triggered send into the dedicated `cron` lane to bound concurrency.
 * Daemon's `MessageQueue.enqueue` satisfies the shape.
 */
export interface MessageQueuePort {
  enqueue<T>(
    lane: string,
    bucketKey: string,
    task: () => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<T>;
}

/**
 * Lane name used by cron-triggered sends. Mirrors
 * `daemon/src/channel-bridge/message-queue.ts:MessageLaneName.Cron`.
 */
export const CRON_MESSAGE_LANE = 'cron';

// ─── Inbound context (re-exported shape) ─────────────────────────────────

export type CronChannelPlatform = ChannelPlatform;

/** Outbound message payload accepted by {@link CronSessionBridgePort.sendMessage}. */
export interface CronSendMessageRequest {
  content: string;
  fromRole: Role;
  source?: MessageSource;
  origin?: MessageOrigin;
  inboundContext?: unknown;
  silent?: boolean;
}

/** Subscriber callback receiving streaming agent responses. */
export type CronAgentResponseHandler = (
  sessionId: string,
  message: AgentMessage,
) => void | Promise<void>;

/**
 * Subset of the host's session bridge consumed by the cron executor.
 *
 * `CronExecutor` only needs to send a triggered message into a session
 * and listen for the resulting response stream when channel delivery is
 * active. The host implements both methods on its real
 * SessionBridge; cloud-runtime can supply an HTTP / archon-server proxy.
 */
export interface CronSessionBridgePort {
  sendMessage(
    ctx: RequestContext,
    agentName: string,
    sessionId: string,
    msg: CronSendMessageRequest,
  ): Promise<void>;
  onResponse(handler: CronAgentResponseHandler): () => void;
  /**
   * In-memory turn tracker: true between `sendMessage` and the matching
   * terminal event (`session.finish` / `session.error` / `session.abort`).
   *
   * Cron busy detection MUST consult this flag in addition to
   * `sessionService.getSessionStatus()`. The OpenCode adapter's runtime
   * `/session/status` API has a known ~500ms inter-step idle window between
   * tool completion and the next LLM inference where it reports `not busy`
   * even though the turn is still active. Without this check, a cron that
   * fires during that window would bypass `BusyQueue` and inject its prompt
   * into the live turn, interrupting the agent loop. Mirrors the same guard
   * `SessionInboundQueue.shouldDeferDrainForBusySession` uses for Web/IM
   * messages.
   *
   * Optional so hosts without an in-memory bridge (cloud-runtime HTTP proxy)
   * can omit it; the executor falls back to the stored-status-only path.
   */
  hasActiveTurn?(sessionId: string): boolean;
  /**
   * In-memory source lock: returns the message source currently owning the
   * session, or `undefined` if idle. Set when a turn begins and released on
   * the terminal event. Same rationale as `hasActiveTurn` — covers the
   * OpenCode inter-step idle window.
   */
  getActiveSource?(sessionId: string): string | undefined;
}

/**
 * Subset of the host's event bus consumed by the cron executor / registry.
 *
 * Cron emits `cron.triggered` / `cron.completed` / `cron.failed` /
 * `cron.created` / `cron.updated` / `cron.deleted` and listens for
 * `session.finish` / `session.error` / `session.abort` to drain the busy
 * queue. `source` lets the abort handler distinguish framework-originated
 * aborts (drain immediately — terminal) from session-service-originated
 * aborts (skip drain — user/system preempted, next terminal will drive it).
 * The host implementation is fire-and-forget: synchronous handlers, no
 * error propagation.
 */
export interface CronEventBusPort {
  emit(type: string, source: string, payload?: Record<string, unknown>): void;
  on(
    type: string,
    handler: (event: { type: string; source?: string; payload?: unknown }) => void,
  ): () => void;
}
