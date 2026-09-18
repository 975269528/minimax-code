import type { ChannelPlatform, InboundContext } from '@mavis/shared';
import {
  formatCronRunTitle,
  MEMORY_CLEANUP_CRON_NAME,
  parseCronSessionPurpose,
} from '@mavis/shared/cron-purpose';
import {
  logger,
  backgroundCtx,
  AppError,
  getMetricsReporter,
  nowMs,
  getCronStore,
  getSessionLifecycle,
  getAgentSpawner,
  getChannelDelivery,
  getMessageQueue,
  type CronHostUtils,
} from './host-utils.js';
import {
  CRON_MESSAGE_LANE,
  CronSessionType,
  Role,
  type AgentSpawnerPort,
  type ChannelDeliveryPort,
  type CronEventBusPort,
  type CronSessionBridgePort,
  type CronSessionRecord,
  type CronStorePort,
  type MessageQueuePort,
  type SessionLifecyclePort,
} from './host-ports.js';
import type { CronTaskState } from './types.js';
import type { CronDeliveryTarget, CronTriggerSource } from './registry.js';
import { normalizeSessionConfig, resolveReportToRoot } from './types.js';
import { isWithinActiveHours } from './active-hours.js';
import { BusyQueue, type BusyQueueDrainResult } from './busy-queue.js';
import {
  IM_AUTO_DELIVERY_PROMPT_NOTE,
  collectCronTurnText,
  deliverToAllBoundChannels,
  deliverToChannel,
  supportsImAutoDelivery,
} from './report-delivery.js';

/**
 * Default retention when `keepSessions` is omitted: `null` = keep all
 * sessions visible (no auto-archive). Users opt-in to auto-archive by
 * explicitly setting `keepSessions` to a positive integer.
 */
const DEFAULT_KEEP_SESSIONS: number | null = null;

export interface ExecuteResult {
  executed: boolean;
  reason?: string;
  sessionId?: string;
  queuedSend?: Promise<BusyQueueDrainResult>;
}

export class CronExecutor {
  private readonly busyQueue = new BusyQueue();

  /**
   * Per `(agentName, cronName)` lock to serialise read-modify-write of the
   * cron's session history JSON. All append + cleanup paths must go through
   * this lock; otherwise an `appendSessionRun` interleaved with a
   * `replaceSessionHistory` could lose new records or overwrite the latest
   * history.
   */
  private readonly historyLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly sessionBridge: CronSessionBridgePort,
    private readonly eventBus?: CronEventBusPort,
    private readonly cronHost: CronHostUtils = {},
  ) {
    // Drain BusyQueue on ANY terminal event — not just session.finish.
    // When the in-flight turn ends via error or abort, the cron prompt
    // that got latest-wins-enqueued during the active window must still
    // get a chance to dispatch; otherwise it sits in the queue forever
    // (next finish never comes if the session is now idle).
    const drainOnTerminal = (event: { payload?: unknown }) => {
      const sid = (event.payload as { sessionId?: string } | undefined)?.sessionId;
      if (sid) {
        void this.busyQueue.drain(sid);
      }
    };
    this.eventBus?.on('session.finish', (event) => {
      drainOnTerminal(event);
      // Cleanup is intentionally not scoped to the finished sessionId — the
      // persisted JSON is the source of truth, not in-memory state. Walk
      // every cron and let the algorithm decide what to archive.
      void this.cleanupAllCronSessions();
    });
    // session.error and session.abort both use a source allow-list rather
    // than reacting to every emitter, because the same event names are
    // emitted by non-turn-terminal sources. The daemon `CronExecutor`
    // dropped BusyQueue entirely in favour of `SessionInboundQueue`;
    // cloud-runtime keeps BusyQueue here (no SessionInboundQueue
    // equivalent yet) but mirrors the same source filters so a
    // session-title-service `session.error` cannot drain the cron queue
    // mid-turn, and a session-service `session.abort` cannot race a
    // queued cron prompt ahead of the user's immediate-message follow-up.
    this.eventBus?.on('session.error', (event) => {
      if (event.source !== 'session-bridge') return;
      drainOnTerminal(event);
    });
    this.eventBus?.on('session.abort', (event) => {
      if (event.source === 'session-service') return;
      drainOnTerminal(event);
    });
  }

  cancelQueuedCron(agentName: string, cronName: string): number {
    return this.busyQueue.removeCron(agentName, cronName);
  }

  private resolveCronStore(): CronStorePort {
    return this.cronHost.cronStore ?? getCronStore();
  }

  private resolveSessionLifecycle(): SessionLifecyclePort {
    return this.cronHost.sessionLifecycle ?? getSessionLifecycle();
  }

  private resolveAgentSpawner(): AgentSpawnerPort {
    return this.cronHost.agentSpawner ?? getAgentSpawner();
  }

  private resolveChannelDelivery(): ChannelDeliveryPort | undefined {
    return this.cronHost.channelDelivery ?? getChannelDelivery();
  }

  private resolveMessageQueue(): MessageQueuePort | undefined {
    return this.cronHost.messageQueue ?? getMessageQueue();
  }

  async execute(
    state: CronTaskState,
    options?: {
      force?: boolean;
      /** @deprecated Trigger dimensions are recorded by CronRegistry. */
      triggerSource?: CronTriggerSource;
      /** @deprecated Trigger dimensions are recorded by CronRegistry. */
      deliveryTarget?: CronDeliveryTarget;
    },
  ): Promise<ExecuteResult> {
    const ctx = backgroundCtx();
    const cronStartMs = Date.now();
    const force = options?.force ?? false;

    // Pre-checks (skipped when force=true for manual triggers)
    if (!force && !state.enabled) {
      logger.debug(
        ctx,
        `[cron] Skipping disabled task: agent=${state.agentName} cron=${state.cronName}`,
      );
      return { executed: false, reason: 'disabled' };
    }
    if (!force) {
      try {
        if (!isWithinActiveHours(state.config.activeHours, state.config.timezone)) {
          logger.debug(
            ctx,
            `[cron] Skipping — outside active hours: agent=${state.agentName} cron=${state.cronName}`,
          );
          return { executed: false, reason: 'outside_active_hours' };
        }
      } catch (err) {
        logger.error(
          ctx,
          `[cron] Invalid timezone in activeHours config: agent=${state.agentName} cron=${state.cronName} err=${(err as Error).message}`,
        );
        return { executed: false, reason: 'invalid_timezone' };
      }
    }
    if (state.status === 'running') {
      logger.debug(
        ctx,
        `[cron] Skipping — already running: agent=${state.agentName} cron=${state.cronName}`,
      );
      return { executed: false, reason: 'already_running' };
    }

    state.status = 'running';
    let sessionId: string | undefined;
    const sessionService = this.resolveSessionLifecycle();
    const agentService = this.resolveAgentSpawner();
    const cronStore = this.resolveCronStore();
    const messageQueue = this.resolveMessageQueue();

    try {
      // Resolve session — normalize legacy 'main' → 'root'
      const sessionCfg = normalizeSessionConfig(state.config.session);
      if (sessionCfg.mode === 'root') {
        const rootSession = await sessionService.getRootSession(state.agentName);
        if (!rootSession) {
          throw new AppError(
            `No root session found for agent '${state.agentName}'`,
            'SESSION_NOT_FOUND',
            404,
          );
        }
        sessionId = rootSession.sessionId;
      } else if (sessionCfg.mode === 'sessionId') {
        const sid = sessionCfg.sessionId;
        const session = await sessionService.getSession(sid);
        if (!session) {
          throw new AppError(
            `Session '${sid}' not found for agent '${state.agentName}'`,
            'SESSION_NOT_FOUND',
            404,
          );
        }
        sessionId = sid;
      } else {
        // mode === 'new'
        const newResult = await agentService.newSession(
          backgroundCtx(),
          state.agentName,
          undefined, // workspaceDir
          undefined, // parentSessionId
          undefined, // title
          undefined, // taskTreeId
          undefined, // teamModeOff
          { purpose: `cron:${state.agentName}:${state.cronName}` },
        );
        sessionId = newResult.sessionId;

        try {
          await sessionService.seedGeneratedTitle?.(sessionId, formatCronRunTitle(state.cronName), {
            onlyIfEmpty: true,
          });
        } catch (err) {
          logger.warn(
            {
              sessionId,
              cronName: state.cronName,
              err: err instanceof Error ? err.message : String(err),
            },
            'Failed to seed cron session title',
          );
        }
      }

      // Record history for all modes. Cleanup only for 'new' mode
      // (main/sessionId reuse existing sessions that should not be archived).
      await this.runUnderHistoryLock(state.agentName, state.cronName, async () => {
        await cronStore.appendSessionRun(state.agentName, state.cronName, {
          sessionId: sessionId!,
          createdAt: nowMs(),
        });
        if (sessionCfg.mode === 'new') {
          await this.cleanupCronSessionsLocked(state.agentName, state.cronName);
        }
      });

      // Build sendTask closure (needed for both enqueue and normal execution paths).
      // Delivery listeners are installed inside the closure so queued sends do
      // not start their response timeout before the prompt is dispatched.
      const sendTask = async () => {
        const autoDeliveryEnabled =
          resolveReportToRoot(state.config) ?? state.config.session.mode === 'new';
        const imAutoDelivery =
          autoDeliveryEnabled && !state.config.delivery && supportsImAutoDelivery(this.cronHost);

        // Set up response listener BEFORE sending so it's ready to capture the response
        if (state.config.delivery && this.resolveChannelDelivery()) {
          this.setupDeliveryListener(state, sessionId!);
        } else if (imAutoDelivery) {
          this.setupAutoDeliveryListener(state, sessionId!);
        }

        // When IM auto-delivery is active, instruct the agent not to send
        // to IM itself — deliverToAllBoundChannels handles it after the turn.
        const promptContent = imAutoDelivery
          ? `${state.config.prompt}\n\n${IM_AUTO_DELIVERY_PROMPT_NOTE}`
          : state.config.prompt;

        const inboundContext: InboundContext = {
          platform: 'system' as ChannelPlatform,
          chatType: 'p2p',
          isGroupChat: false,
          accountName: 'cron-executor',
          senderId: 'system',
          messageId: `cron:${state.cronName}:${Date.now()}`,
          hasMention: false,
          timestamp: Date.now(),
          sourceType: 'cron',
          cronName: state.cronName,
          cronSchedule: state.config.schedule,
        };
        await this.sessionBridge.sendMessage(backgroundCtx(), state.agentName, sessionId!, {
          content: promptContent,
          fromRole: Role.User,
          source: 'cron',
          inboundContext,
        });
      };

      // Busy check — enqueue instead of skipping.
      //
      // Three signals are combined so the OpenCode adapter's known
      // ~500ms inter-step idle window (where /session/status briefly
      // reports `not busy` between tool completion and the next LLM
      // inference) cannot bypass BusyQueue and inject the cron prompt
      // into the live turn. Mirrors `SessionInboundQueue`'s gate for
      // Web/IM messages (`shouldDeferDrainForBusySession`).
      const status = await sessionService.getSessionStatus(backgroundCtx(), sessionId);
      const hasActiveTurn = this.sessionBridge.hasActiveTurn?.(sessionId) === true;
      const hasActiveSource = this.sessionBridge.getActiveSource?.(sessionId) !== undefined;
      const sessionBusy = status.type === 'started' || hasActiveTurn || hasActiveSource;
      if (sessionBusy) {
        const queuedSend = this.busyQueue.enqueue(
          sessionId,
          state.agentName,
          state.cronName,
          sendTask,
        );
        logger.info(
          ctx,
          `[cron] Session busy — enqueued (latest-wins): agent=${state.agentName} cron=${state.cronName} sessionId=${sessionId} queueSize=${this.busyQueue.size()} stored=${status.type} hasActiveTurn=${hasActiveTurn} hasActiveSource=${hasActiveSource}`,
        );
        state.lastRun = nowMs();
        state.lastResult = 'skipped';
        return { executed: false, reason: 'enqueued', sessionId, queuedSend };
      }

      // Send message
      logger.info(
        ctx,
        `[cron] Executing task: agent=${state.agentName} cron=${state.cronName} sessionId=${sessionId}`,
      );
      this.eventBus?.emit('cron.triggered', 'cron-executor', {
        agentName: state.agentName,
        cronName: state.cronName,
        sessionId,
      });
      if (messageQueue) {
        const bucketKey = `cron:${state.agentName}:${state.cronName}`;
        await messageQueue.enqueue(CRON_MESSAGE_LANE, bucketKey, sendTask, {
          timeoutMs: 60_000,
        });
      } else {
        await sendTask();
      }

      state.lastRun = nowMs();
      state.lastResult = 'success';
      state.lastError = null;
      this.eventBus?.emit('cron.completed', 'cron-executor', {
        agentName: state.agentName,
        cronName: state.cronName,
      });
      return { executed: true, sessionId };
    } catch (err) {
      state.lastRun = nowMs();
      state.lastResult = 'error';
      state.lastError = (err as Error).message;
      this.eventBus?.emit('cron.failed', 'cron-executor', {
        agentName: state.agentName,
        cronName: state.cronName,
        error: (err as Error).message,
      });
      logger.error(
        ctx,
        `[cron] Execution failed: agent=${state.agentName} cron=${state.cronName} err=${(err as Error).message}`,
      );

      return { executed: false, reason: 'error', sessionId };
    } finally {
      state.status = 'idle';
      const cronResult =
        state.lastResult === 'skipped'
          ? 'skipped'
          : state.lastResult === 'success'
            ? 'success'
            : 'failure';
      // Keep the established family schema; orthogonal trigger context is
      // already reported by CronRegistry via cron_task_triggered_total.
      getMetricsReporter().incr('cron_task_executed_total', {
        result: cronResult,
        agent_name: state.agentName,
      });
      getMetricsReporter().latency('cron_task_execution_duration_ms', Date.now() - cronStartMs, {
        agent_name: state.agentName,
      });
    }
  }

  /**
   * Public retention entry point for a single cron task. Source of truth is the
   * persisted `<cronName>.sessions.json` — runtime in-memory state plays no part.
   *
   * Algorithm (operating on records ordered oldest-first):
   *   - skip when cron config missing or `session.mode !== 'new'`
   *   - drop record if session no longer exists (compacted out)
   *   - drop record if session is already compressed (compacted out)
   *   - keep record if session is currently `started` (not counted toward keepN, not archived)
   *   - keep newest `keepN` visible (non-started, non-compressed) records
   *   - archive + drop older visible records
   *   - Root sessions encountered in the JSON are skipped with a warning and retained
   *
   * Concurrency / errors:
   *   - Serialised against `appendSessionRun` and `cleanupAllCronSessions` via
   *     `runUnderHistoryLock`.
   *   - Cleanup errors (including replaceSessionHistory write failures) are
   *     non-fatal and logged with agent/cron context — the next trigger retries.
   */
  async cleanupCronSessions(agentName: string, cronName: string): Promise<void> {
    await this.runUnderHistoryLock(agentName, cronName, async () => {
      try {
        await this.cleanupCronSessionsLocked(agentName, cronName);
      } catch (err) {
        logger.warn(
          backgroundCtx(),
          `[cron] Archive cleanup failed (non-fatal), agent=${agentName} cron=${cronName} err=${(err as Error).message}`,
        );
      }
    });
  }

  /**
   * Walk every cron loaded by the store and run cleanup for each one in
   * `session.mode === 'new'`. Triggered at daemon startup and on every
   * `session.finish` (we cannot cheaply tell which cron a finishing session
   * belongs to, and the persisted JSON is the only authoritative input).
   */
  async cleanupAllCronSessions(): Promise<void> {
    const ctx = backgroundCtx();
    const cronStore = this.resolveCronStore();
    let configs: Awaited<ReturnType<CronStorePort['listAll']>>;
    try {
      configs = await cronStore.listAll();
    } catch (err) {
      logger.warn(
        ctx,
        `[cron] cleanupAllCronSessions: listAll failed (non-fatal), err=${(err as Error).message}`,
      );
      return;
    }
    for (const { agentName, cronName, config } of configs) {
      if (config.session.mode !== 'new') continue;
      await this.cleanupCronSessions(agentName, cronName);
    }
  }

  /**
   * Internal cleanup body — must be invoked while already holding the
   * per-cron history lock. Public callers should go through
   * `cleanupCronSessions` (which acquires the lock + swallows errors).
   */
  private async cleanupCronSessionsLocked(agentName: string, cronName: string): Promise<void> {
    const ctx = backgroundCtx();
    const cronStore = this.resolveCronStore();
    const sessionService = this.resolveSessionLifecycle();
    const config = await cronStore.get(agentName, cronName);
    if (!config) return;
    if (config.session.mode !== 'new') return;

    const records = await cronStore.getSessionHistory(agentName, cronName);
    if (records.length === 0) return;

    const { keepSessions } = config.session; // undefined | null | number
    const effectiveKeep = keepSessions === undefined ? DEFAULT_KEEP_SESSIONS : keepSessions;

    // Inspect each record once.
    type Inspection = {
      record: CronSessionRecord;
      kind: 'missing' | 'compressed' | 'started' | 'root' | 'visible';
    };
    const inspections: Inspection[] = [];
    for (const record of records) {
      const session = await sessionService.getSession(record.sessionId).catch(() => undefined);
      if (!session) {
        inspections.push({ record, kind: 'missing' });
        continue;
      }
      // Defensive: a Root session never belongs in cron history (cron always
      // creates branch sessions). If we see one, retain + warn instead of
      // attempting an archive that would throw MAIN_SESSION_PROTECTED.
      if (session.sessionType === CronSessionType.Root) {
        logger.warn(
          ctx,
          `[cron] Root session in cron history — skipping archive, agent=${agentName} cron=${cronName} sessionId=${record.sessionId}`,
        );
        inspections.push({ record, kind: 'root' });
        continue;
      }
      if (session.compressed) {
        inspections.push({ record, kind: 'compressed' });
        continue;
      }
      if (session.status?.type === 'started') {
        inspections.push({ record, kind: 'started' });
        continue;
      }
      inspections.push({ record, kind: 'visible' });
    }

    // Archive eligibility: oldest visible records beyond keepN.
    // null keepSessions → keep all visible (compact missing/compressed only).
    const visibleIndexes: number[] = [];
    for (let i = 0; i < inspections.length; i++) {
      if (inspections[i]!.kind === 'visible') visibleIndexes.push(i);
    }

    const archiveSet = new Set<number>();
    if (effectiveKeep !== null) {
      const keepCount = effectiveKeep;
      if (visibleIndexes.length > keepCount) {
        const archiveCount = visibleIndexes.length - keepCount;
        for (let i = 0; i < archiveCount; i++) {
          archiveSet.add(visibleIndexes[i]!);
        }
      }
    }

    // Build the new persisted list and perform archives.
    const next: CronSessionRecord[] = [];
    let archived = 0;
    let compacted = 0;
    for (let i = 0; i < inspections.length; i++) {
      const { record, kind } = inspections[i]!;
      if (kind === 'started' || kind === 'root') {
        next.push(record);
        continue;
      }
      if (kind === 'missing' || kind === 'compressed') {
        compacted++;
        continue;
      }
      if (archiveSet.has(i)) {
        try {
          await sessionService.setSessionArchived(record.sessionId, true);
          archived++;
        } catch (err) {
          // Archive failed — keep the record so we retry next time, do not
          // silently lose history.
          logger.warn(
            ctx,
            `[cron] Failed to archive session, agent=${agentName} cron=${cronName} sessionId=${record.sessionId} err=${(err as Error).message}`,
          );
          next.push(record);
        }
        continue;
      }
      next.push(record);
    }

    // Skip the write entirely when nothing actually changed.
    const changed = archived > 0 || compacted > 0 || next.length !== records.length;
    if (!changed) return;

    await cronStore.replaceSessionHistory(agentName, cronName, next);
    logger.info(
      ctx,
      `[cron] Cleanup applied, agent=${agentName} cron=${cronName} archived=${archived} compacted=${compacted} retained=${next.length} keep=${effectiveKeep ?? 'all'}`,
    );
  }

  /**
   * Delete all cron-created sessions before a cron task is deleted.
   * Only deletes sessions that:
   *   - exist
   *   - are NOT root sessions
   *   - have a `purpose` matching `cron:{agentName}:{cronName}`
   *
   * Best-effort: individual delete failures are logged and skipped so
   * deletion can proceed.
   */
  async cleanupSessionsOnDelete(agentName: string, cronName: string): Promise<void> {
    const ctx = backgroundCtx();
    const cronStore = this.resolveCronStore();
    const sessionService = this.resolveSessionLifecycle();
    const expectedPurpose = `cron:${agentName}:${cronName}`;

    const records = await cronStore.getSessionHistory(agentName, cronName);

    // Deduplicate sessionIds (root/sessionId mode may repeat the same ID)
    const seen = new Set<string>();
    let deleted = 0;
    let skipped = 0;

    // Phase 1: delete sessions tracked in the history file
    for (const record of records) {
      if (seen.has(record.sessionId)) continue;
      seen.add(record.sessionId);

      try {
        const session = await sessionService.getSession(record.sessionId);
        if (!session) {
          skipped++;
          continue;
        }
        if (session.sessionType === CronSessionType.Root) {
          skipped++;
          continue;
        }
        if (session.purpose !== expectedPurpose) {
          skipped++;
          continue;
        }
        await sessionService.deleteSession(record.sessionId);
        deleted++;
      } catch (err) {
        logger.warn(
          ctx,
          `[cron] Failed to delete session on cron delete, agent=${agentName} cron=${cronName} sessionId=${record.sessionId} err=${(err as Error).message}`,
        );
      }
    }

    // Phase 2: fallback — sweep session store by purpose prefix to catch
    // orphans not tracked in the history file (e.g. records truncated by
    // retention policy or created by earlier versions without history tracking).
    if (sessionService.listByPurposePrefix) {
      try {
        const orphans = await sessionService.listByPurposePrefix(expectedPurpose);
        for (const orphan of orphans) {
          if (seen.has(orphan.sessionId)) continue;
          if (orphan.sessionType === CronSessionType.Root) continue;
          // listByPurposePrefix matches by prefix, so `cron:agent:foo` would also
          // return `cron:agent:foobar`. Re-verify exact purpose before deletion
          // to avoid wiping sessions belonging to same-prefix cron tasks.
          if (orphan.purpose !== expectedPurpose) continue;
          try {
            await sessionService.deleteSession(orphan.sessionId);
            deleted++;
          } catch (err) {
            logger.warn(
              ctx,
              `[cron] Failed to delete orphan session on cron delete, agent=${agentName} cron=${cronName} sessionId=${orphan.sessionId} err=${(err as Error).message}`,
            );
          }
        }
      } catch (err) {
        logger.warn(
          ctx,
          `[cron] Purpose-based orphan sweep failed (non-fatal), agent=${agentName} cron=${cronName} err=${(err as Error).message}`,
        );
      }
    }

    if (deleted > 0) {
      logger.info(
        ctx,
        `[cron] Sessions deleted on task delete, agent=${agentName} cron=${cronName} deleted=${deleted} skipped=${skipped}`,
      );
    }
  }

  /**
   * Delete orphan cron sessions at startup — sessions whose purpose matches
   * `cron:<agentName>:<cronName>` but whose corresponding cron task no longer
   * exists.
   *
   * @param aliveTaskKeys Set of `agentName:cronName` keys for currently
   *   registered cron tasks.
   */
  async cleanupOrphanCronSessions(aliveTaskKeys: Set<string>): Promise<void> {
    const ctx = backgroundCtx();
    const sessionService = getSessionLifecycle();
    if (!sessionService.listByPurposePrefix) return;

    let sessions: Awaited<ReturnType<NonNullable<typeof sessionService.listByPurposePrefix>>>;
    try {
      sessions = await sessionService.listByPurposePrefix('cron:');
    } catch (err) {
      logger.warn(
        ctx,
        `[cron] Orphan session cleanup: listByPurposePrefix failed (non-fatal), err=${(err as Error).message}`,
      );
      return;
    }

    let deleted = 0;
    for (const session of sessions) {
      if (session.sessionType === CronSessionType.Root) continue;
      if (!session.purpose) continue;

      const parsed = parseCronSessionPurpose(session.purpose);
      if (!parsed) continue;

      // Reserved daemon-managed cron purposes — these are NOT registered in
      // CronRegistry (they are spawned by dedicated daemon services such as
      // MemoryCleanupSpawner) but legitimately use the cron:<agent>:<name>
      // purpose namespace. Skip them so startup orphan cleanup does not wipe
      // their session history.
      if (parsed.cronName === MEMORY_CLEANUP_CRON_NAME) continue;

      const taskKey = `${parsed.agentName}:${parsed.cronName}`;
      if (aliveTaskKeys.has(taskKey)) continue;

      try {
        await sessionService.deleteSession(session.sessionId);
        deleted++;
      } catch (err) {
        logger.warn(
          ctx,
          `[cron] Orphan session cleanup: failed to delete session=${session.sessionId} purpose=${session.purpose} err=${(err as Error).message}`,
        );
      }
    }

    if (deleted > 0) {
      logger.info(ctx, `[cron] Orphan cron sessions cleaned up: deleted=${deleted}`);
    }
  }

  private async runUnderHistoryLock(
    agentName: string,
    cronName: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const key = `${agentName}\u0000${cronName}`;
    const previous = this.historyLocks.get(key) ?? Promise.resolve();
    // Chain `fn` after the previous lock holder regardless of whether it
    // resolved or rejected — but log the previous failure for observability.
    // Each caller still receives its own error via `await tracked` below;
    // there is no error swallowing because the previous caller has already
    // observed (and logged) its own failure through its own `await`.
    const next = previous
      .catch((err) => {
        logger.debug(
          backgroundCtx(),
          `[cron] Previous lock holder failed (chained call proceeds): agent=${agentName} cron=${cronName} err=${(err as Error).message}`,
        );
      })
      .then(() => fn());
    // Track the in-flight tail; remove from the map only when this exact tail
    // resolves so a follow-up call still observes a consistent chain.
    const tracked = next.finally(() => {
      if (this.historyLocks.get(key) === tracked) {
        this.historyLocks.delete(key);
      }
    });
    this.historyLocks.set(key, tracked);
    await tracked;
  }

  /** Listen for the cron response and fan it out to the agent's bound IM chats. */
  private setupAutoDeliveryListener(state: CronTaskState, cronSessionId: string): void {
    collectCronTurnText(
      this.sessionBridge,
      {
        agentName: state.agentName,
        cronName: state.cronName,
        sessionId: cronSessionId,
        listenerLabel: 'IM auto-delivery',
      },
      (text) => {
        void deliverToAllBoundChannels(state.agentName, text, cronSessionId, this.cronHost);
      },
    );
  }

  /**
   * Listen for the cron response and deliver it to the configured channel
   * when the turn ends.
   */
  private setupDeliveryListener(state: CronTaskState, sessionId: string): void {
    const delivery = state.config.delivery!;
    collectCronTurnText(
      this.sessionBridge,
      {
        agentName: state.agentName,
        cronName: state.cronName,
        sessionId,
        listenerLabel: 'Delivery',
      },
      (text) => {
        void deliverToChannel(state, delivery, text, sessionId, this.cronHost);
      },
    );
  }
}
