import type { AppDb } from '../../../infra/db/client.js';
import type {
  CronDefinitionRecord,
  CronExecutionInput,
  CronDefinitionRepository,
  CronDeliveryResult,
  CronExecutionMetricResult,
  CronMetrics,
  CronMetricTask,
  CronRun,
  CronRunRepository,
  CronSessionCreationPort,
  CronSessionDeliveryPort,
  CronTriggerMetricOutcome,
  CronTriggerMetricSource,
} from '../contracts.js';
import type { CronDataLifecycle } from './lifecycle.js';

const SESSION_CREATE_FAILED = 'SESSION_CREATE_FAILED';
const SESSION_DELIVERY_FAILED = 'SESSION_DELIVERY_FAILED';
const CRON_DEFINITION_DELETED = 'CRON_DEFINITION_DELETED';
const PROCESS_RESTARTED = 'PROCESS_RESTARTED';
const SESSION_CREATE_ERROR = 'Cron session creation failed';
const SESSION_DELIVERY_ERROR = 'Cron session delivery failed';
const CRON_DEFINITION_DELETED_ERROR = 'Cron definition was deleted before execution';
const PROCESS_RESTARTED_ERROR = 'Cron run abandoned by a previous process';
const MAX_BOUNDARY_ERROR_LENGTH = 256;
const MIN_REQUEST_TEXT_FRAGMENT_LENGTH = 24;

const TARGET_SESSION_FAILURE_MESSAGES = {
  CRON_SESSION_TARGET_NOT_FOUND: 'Cron target session was not found',
  CRON_SESSION_TARGET_ARCHIVED: 'Cron target session is archived',
  CRON_SESSION_TARGET_AGENT_MISMATCH: 'Cron target session belongs to a different agent',
} as const;

export interface CronExecutionLogContext {
  readonly component: 'cron-executor';
  readonly event: 'session-attach-conflict' | 'terminal-conflict' | 'recovery-failed';
  readonly cronId: string;
  readonly runId: string;
  readonly currentStatus: CronRun['status'] | 'missing';
  readonly requestedStatus: CronRun['status'];
}

export interface CronExecutionLogger {
  warn(context: CronExecutionLogContext, message: string): void;
}

export interface CronExecutorDependencies {
  readonly db: AppDb;
  readonly definitions: CronDefinitionRepository;
  readonly runs: CronRunRepository;
  readonly lifecycle: Pick<CronDataLifecycle, 'createManualRun'>;
  readonly sessionCreation: CronSessionCreationPort;
  readonly delivery: CronSessionDeliveryPort;
  readonly nowMs: () => number;
  readonly logger: CronExecutionLogger;
  readonly metrics: CronMetrics;
}

export interface ManualCronRunRequest {
  readonly cronId: string;
  readonly requestId?: string;
  /** @deprecated direct-module test seam; public callers use requestId. */
  readonly runId?: string;
  readonly triggerMetric?: CronTriggerMetricContext;
}

export interface CronTriggerMetricContext {
  readonly source: CronTriggerMetricSource;
  readonly task: CronMetricTask;
}

type CronPreparationResult =
  | { readonly kind: 'ready'; readonly run: CronRun }
  | { readonly kind: 'error'; readonly error: unknown };

type SettleCronPreparation = (result: CronPreparationResult) => void;

interface ActiveCronExecution {
  readonly ready: Promise<CronPreparationResult>;
  readonly completion: Promise<CronRun>;
  readonly observedCompletion: Promise<void>;
}

interface QueuedCronExecution {
  readonly runId: string;
  readonly triggerMetric?: CronTriggerMetricContext;
}

export interface ScheduledCronTrigger {
  readonly schedulerId: string;
  readonly triggerId: string;
  readonly triggerMetric?: CronTriggerMetricContext;
}

export type ScheduledCronTriggerResult =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly errorCode: 'CRON_NOT_FOUND' | 'CRON_PERSIST_FAILED';
    };

type CronExecutionErrorCode =
  | 'CRON_DEFINITION_NOT_FOUND'
  | 'CRON_RUN_ID_CONFLICT'
  | 'CRON_RUN_FACT_MISSING';

class CronExecutionError extends Error {
  override readonly name = 'CronExecutionError';

  constructor(
    readonly code: CronExecutionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Single Cron execution loop shared by scheduled callbacks and manual triggers.
 *
 * Scheduler callbacks only persist a pending run and return promptly; the loop asynchronously
 * resolves sessions and delivers turns. All terminal transitions use compare-and-swap (CAS) in the
 * CronRun repository so duplicate triggers, process restarts, and concurrent queue draining
 * converge on one authoritative fact.
 */
export class CronExecutor {
  private readonly inFlight = new Map<string, ActiveCronExecution>();
  private readonly queue: QueuedCronExecution[] = [];
  private pumpTail: Promise<void> = Promise.resolve();
  private pumpScheduled = false;
  private closed = false;
  /**
   * Tail of the manual execution queue detached from the request path. Storing the chained Promise
   * in a field satisfies `no-floating-promises` without inline suppression. Final results are
   * always recorded in the persisted CronRun terminal state.
   */
  private manualPumpTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: CronExecutorDependencies) {}

  /**
   * Detached manual-trigger entry point called by the domain facade. Persists and asynchronously
   * executes manual runs without throwing to callers: per task §5.3, controllers immediately return
   * a pending run, while persisted terminal state remains authoritative. Errors are contained here
   * rather than exposed on the request path.
   */
  kickManual(request: ManualCronRunRequest): void {
    const existing = this.existingManualRun(request);
    if (existing) {
      this.enqueue(existing.runId, request.triggerMetric);
      return;
    }
    this.manualPumpTail = this.chainManual(request);
  }

  private async chainManual(request: ManualCronRunRequest): Promise<void> {
    await this.manualPumpTail;
    try {
      await this.runManual(request);
    } catch {
      // Intentionally contain errors here; CronRun terminal state records the execution result.
    }
  }

  /**
   * Scheduler callback entry point. Persist a pending scheduled run in a Cron transaction, or
   * converge on an existing record, then enqueue it without waiting for session work.
   */
  acceptScheduledTrigger(envelope: ScheduledCronTrigger): ScheduledCronTriggerResult {
    try {
      const run = this.deps.db.transaction(
        () => {
          const definition = this.deps.definitions.getBySchedulerId(envelope.schedulerId);
          if (!definition) return undefined;
          return this.deps.runs.insertPendingScheduled(
            definition.cronId,
            envelope.triggerId,
            this.deps.nowMs(),
          );
        },
        { behavior: 'immediate' },
      );
      if (!run) return { accepted: false, errorCode: 'CRON_NOT_FOUND' };
      this.enqueue(run.runId, envelope.triggerMetric);
      return { accepted: true };
    } catch {
      return { accepted: false, errorCode: 'CRON_PERSIST_FAILED' };
    }
  }

  /**
   * Product entry point for manual triggers: create a pending run and wait for session association,
   * then continue delivery in the background. The returned run has a navigable sessionId; the same
   * execution loop still persists its terminal state.
   */
  async prepareManual(request: ManualCronRunRequest): Promise<CronRun> {
    const pending = this.resolveManualRun(request);
    return pending.status === 'pending'
      ? this.prepareSingleflight(pending, request.triggerMetric)
      : pending;
  }

  /** Full manual-trigger entry point: wait until the run reaches terminal state. */
  async runManual(request: ManualCronRunRequest): Promise<CronRun> {
    const pending = this.resolveManualRun(request);
    return this.executeSingleflight(pending, request.triggerMetric);
  }

  /** Execute at most one queued run; return undefined if the queue is empty. */
  async drainOnce(): Promise<CronRun | undefined> {
    const queued = this.queue.shift();
    if (queued === undefined) return undefined;
    const current = this.deps.runs.get(queued.runId);
    if (!current) return undefined;
    if (current.status !== 'pending') {
      if (queued.triggerMetric) {
        this.deps.metrics.taskTriggered(
          queued.triggerMetric.task,
          queued.triggerMetric.source,
          'skipped',
        );
      }
      return current;
    }
    return this.executeSingleflight(current, queued.triggerMetric);
  }

  /** Process until the queue is empty and return all terminal runs in processing order. */
  async drainAll(): Promise<CronRun[]> {
    const outcomes: CronRun[] = [];
    for (;;) {
      const outcome = await this.drainOnce();
      if (!outcome) break;
      outcomes.push(outcome);
    }
    return outcomes;
  }

  /** Wait for the detached queue and all claimed executions to finish. */
  async waitForIdle(): Promise<void> {
    await this.pumpTail;
    await Promise.all([...this.inFlight.values()].map((execution) => execution.completion));
  }

  /** Stop accepting queued work and wait for currently claimed runs to persist terminal state. */
  async close(): Promise<void> {
    this.closed = true;
    this.queue.splice(0);
    await this.waitForIdle();
  }

  /**
   * Recover runs left by the previous process at startup:
   * - Requeue unclaimed pending runs.
   * - Mark claimed pending runs failed(PROCESS_RESTARTED), without redelivery.
   */
  async recoverPendingRuns(): Promise<CronRun[]> {
    const pending = this.listPendingRuns();
    const outcomes: CronRun[] = [];
    for (const run of pending) {
      if (run.executionClaimedAtMs === undefined) {
        this.enqueue(run.runId);
        continue;
      }
      const failedAtMs = this.deps.nowMs();
      const marked = this.deps.runs.markFailed({
        runId: run.runId,
        failedAtMs,
        errorCode: PROCESS_RESTARTED,
        error: PROCESS_RESTARTED_ERROR,
      });
      if (!marked) {
        this.warn(run, 'recovery-failed', 'failed');
      }
      const resolved = this.deps.runs.get(run.runId);
      if (resolved) outcomes.push(resolved);
    }
    const drained = await this.drainAll();
    return [...outcomes, ...drained];
  }

  private enqueue(runId: string, triggerMetric?: CronTriggerMetricContext): void {
    if (this.closed) return;
    if (!this.queue.some((queued) => queued.runId === runId)) {
      this.queue.push({ runId, ...(triggerMetric ? { triggerMetric } : {}) });
    }
    this.schedulePump();
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.closed) return;
    this.pumpScheduled = true;
    this.pumpTail = this.continuePump(this.pumpTail);
  }

  private async continuePump(previous: Promise<void>): Promise<void> {
    try {
      await previous;
    } catch {
      // Return prior errors only to their corresponding waiters; subsequent queued work can continue.
    }
    try {
      while (!this.closed) {
        const outcome = await this.drainOnce();
        if (!outcome) break;
      }
    } finally {
      this.pumpScheduled = false;
      if (!this.closed && this.queue.length > 0) this.schedulePump();
    }
  }

  private existingManualRun(request: ManualCronRunRequest): CronRun | undefined {
    const existing = this.findManualRun(request);
    if (!existing) return undefined;
    this.assertManualOwnership(request.cronId, existing);
    return existing;
  }

  private resolveManualRun(request: ManualCronRunRequest): CronRun {
    const existing = this.existingManualRun(request);
    if (existing) return existing;

    try {
      return this.createManualRun(request);
    } catch (error) {
      const raced = this.resolveRacedManualRun(request);
      if (raced) return raced;
      throw normalizeCreateManualError(error);
    }
  }

  private assertManualOwnership(cronId: string, run: CronRun): void {
    if (run.cronId !== cronId || run.triggerSource !== 'manual') {
      throw new CronExecutionError(
        'CRON_RUN_ID_CONFLICT',
        'Cron runId belongs to a different definition or trigger source',
      );
    }
  }

  private createManualRun(request: ManualCronRunRequest): CronRun {
    return this.deps.db.transaction(
      () => {
        if (request.requestId) {
          const existing = this.deps.runs.getByManualRequestId(request.requestId);
          if (existing) {
            this.assertManualOwnership(request.cronId, existing);
            return existing;
          }
          return this.deps.lifecycle.createManualRun(
            request.cronId,
            this.deps.nowMs(),
            request.requestId,
          );
        }
        if (request.runId) {
          const existing = this.findManualRun(request);
          if (existing) {
            this.assertManualOwnership(request.cronId, existing);
            return existing;
          }
          // Legacy direct callers supplied a stable runId. Store it as the
          // manual idempotency key while the repository keeps ownership of
          // the Run identifier.
          return this.deps.lifecycle.createManualRun(
            request.cronId,
            this.deps.nowMs(),
            request.runId,
          );
        }
        return this.deps.lifecycle.createManualRun(request.cronId, this.deps.nowMs());
      },
      { behavior: 'immediate' },
    );
  }

  private resolveRacedManualRun(request: ManualCronRunRequest): CronRun | undefined {
    const raced = this.findManualRun(request);
    if (!raced) return undefined;
    this.assertManualOwnership(request.cronId, raced);
    return raced;
  }

  private findManualRun(request: ManualCronRunRequest): CronRun | undefined {
    if (request.requestId) return this.deps.runs.getByManualRequestId(request.requestId);
    if (!request.runId) return undefined;
    return this.deps.runs.get(request.runId) ?? this.deps.runs.getByManualRequestId(request.runId);
  }

  private executeSingleflight(
    pending: CronRun,
    triggerMetric?: CronTriggerMetricContext,
  ): Promise<CronRun> {
    return this.getOrStartExecution(pending, triggerMetric).completion;
  }

  private async prepareSingleflight(
    pending: CronRun,
    triggerMetric?: CronTriggerMetricContext,
  ): Promise<CronRun> {
    const result = await this.getOrStartExecution(pending, triggerMetric).ready;
    if (result.kind === 'ready') return result.run;
    throw result.error;
  }

  private getOrStartExecution(
    pending: CronRun,
    triggerMetric?: CronTriggerMetricContext,
  ): ActiveCronExecution {
    const active = this.inFlight.get(pending.runId);
    if (active) return active;

    let settleReady: SettleCronPreparation = () => undefined;
    const ready = new Promise<CronPreparationResult>((resolve) => {
      settleReady = resolve;
    });
    const completion = this.executeDeferred(pending, settleReady, triggerMetric);
    const execution: ActiveCronExecution = {
      ready,
      completion,
      // The manual product entry point waits only for ready. Observe background execution rejection early;
      // runManual, the queue pump, and waitForIdle still read the full result through completion.
      observedCompletion: observeCompletion(completion),
    };
    this.inFlight.set(pending.runId, execution);
    return execution;
  }

  private async executeDeferred(
    pending: CronRun,
    settleReady: SettleCronPreparation,
    triggerMetric?: CronTriggerMetricContext,
  ): Promise<CronRun> {
    await Promise.resolve();
    try {
      return await this.executePending(pending, settleReady, triggerMetric);
    } catch (error) {
      settleReady({ kind: 'error', error });
      throw error;
    } finally {
      this.inFlight.delete(pending.runId);
    }
  }

  private async executePending(
    pending: CronRun,
    settleReady: SettleCronPreparation,
    triggerMetric?: CronTriggerMetricContext,
  ): Promise<CronRun> {
    if (pending.status !== 'pending') return settlePrepared(settleReady, pending);
    const claimed = this.deps.runs.claimExecution(pending.runId, this.deps.nowMs());
    if (!claimed) {
      if (triggerMetric) {
        this.deps.metrics.taskTriggered(triggerMetric.task, triggerMetric.source, 'skipped');
      }
      return settlePrepared(settleReady, this.requireRun(pending.runId));
    }
    const startedAtMs = Date.now();
    let agentName = 'unknown';
    let outcome: CronRun | undefined;

    try {
      const executionInput = currentExecutionInput(this.deps.definitions.get(pending.cronId));
      if (!executionInput) {
        outcome = settlePrepared(
          settleReady,
          this.finishFailed(claimed, CRON_DEFINITION_DELETED, CRON_DEFINITION_DELETED_ERROR, ''),
        );
        return outcome;
      }
      agentName = executionInput.agentName;

      let sessionId: string;
      try {
        sessionId = await this.createExecutionSession(claimed, executionInput);
      } catch (error) {
        const failure = targetSessionFailure(error);
        outcome = settlePrepared(
          settleReady,
          this.finishFailed(claimed, failure.code, failure.message, ''),
        );
        return outcome;
      }

      if (!this.deps.runs.attachSession(claimed.runId, sessionId)) {
        outcome = settlePrepared(
          settleReady,
          this.resolveConflict(claimed, 'session-attach-conflict', 'pending'),
        );
        return outcome;
      }

      settleReady({ kind: 'ready', run: this.requireRun(claimed.runId) });

      const delivery = await this.deliver(executionInput, claimed, sessionId);
      if (!delivery.delivered) {
        outcome = this.finishFailed(
          claimed,
          delivery.errorCode,
          delivery.error,
          executionInput.prompt,
        );
        return outcome;
      }

      if (!this.deps.runs.markDelivered(claimed.runId, this.deps.nowMs())) {
        outcome = this.resolveConflict(claimed, 'terminal-conflict', 'delivered');
        return outcome;
      }
      outcome = this.requireRun(claimed.runId);
      return outcome;
    } finally {
      this.reportExecutionMetrics(agentName, outcome, startedAtMs, triggerMetric);
    }
  }

  private async createExecutionSession(
    claimed: CronRun,
    executionInput: CronExecutionInput,
  ): Promise<string> {
    const created = await this.deps.sessionCreation.create({
      agentName: executionInput.agentName,
      cronId: claimed.cronId,
      cronName: executionInput.cronName,
      runId: claimed.runId,
      runCreatedAtMs: claimed.createdAtMs,
      sessionTarget: executionInput.sessionTarget,
      project: executionInput.project,
      model: executionInput.model,
    });
    const sessionId = requireSessionId(created.sessionId);
    const pendingFixedTarget =
      executionInput.sessionTarget.mode === 'sessionId' && !executionInput.sessionTarget.sessionId;
    if (!pendingFixedTarget) return sessionId;
    return this.bindPendingFixedSession(claimed.cronId, sessionId);
  }

  private async bindPendingFixedSession(cronId: string, createdSessionId: string): Promise<string> {
    let bound: CronDefinitionRecord;
    try {
      bound = this.deps.definitions.bindPendingTargetSession(
        cronId,
        createdSessionId,
        this.deps.nowMs(),
      );
    } catch (error) {
      await discardSessionBestEffort(this.deps.sessionCreation, createdSessionId);
      throw error;
    }
    if (bound.sessionTarget.mode !== 'sessionId' || !bound.sessionTarget.sessionId) {
      throw new Error('Cron fixed session binding did not produce a target session');
    }
    const boundSessionId = bound.sessionTarget.sessionId;
    if (boundSessionId !== createdSessionId) {
      await discardSessionBestEffort(this.deps.sessionCreation, createdSessionId);
    }
    return boundSessionId;
  }

  private reportExecutionMetrics(
    agentName: string,
    outcome: CronRun | undefined,
    startedAtMs: number,
    triggerMetric: CronTriggerMetricContext | undefined,
  ): void {
    const result = executionMetricResult(outcome);
    this.deps.metrics.taskExecuted(agentName, result, Date.now() - startedAtMs);
    if (result === 'failure') {
      this.deps.metrics.taskFailed(agentName, outcome?.errorCode ?? 'UNKNOWN');
    }
    if (!triggerMetric) return;
    this.deps.metrics.taskTriggered(
      triggerMetric.task,
      triggerMetric.source,
      triggerMetricOutcome(outcome),
    );
  }

  private async deliver(
    executionInput: CronExecutionInput,
    pending: CronRun,
    sessionId: string,
  ): Promise<CronDeliveryResult> {
    try {
      return await this.deps.delivery.deliver({
        cronId: pending.cronId,
        runId: pending.runId,
        sessionId,
        agentName: executionInput.agentName,
        cronName: executionInput.cronName,
        text: executionInput.prompt,
      });
    } catch {
      return {
        delivered: false,
        errorCode: SESSION_DELIVERY_FAILED,
        error: SESSION_DELIVERY_ERROR,
      };
    }
  }

  private finishFailed(
    pending: CronRun,
    errorCode: string,
    error: string | undefined,
    requestText: string,
  ): CronRun {
    const failedAtMs = this.deps.nowMs();
    const sanitizedCode = sanitizeErrorCode(errorCode, requestText) ?? SESSION_DELIVERY_FAILED;
    const sanitizedError = sanitizeBoundaryError(error, requestText);
    const marked = this.deps.runs.markFailed({
      runId: pending.runId,
      failedAtMs,
      errorCode: sanitizedCode,
      ...(sanitizedError ? { error: sanitizedError } : {}),
    });
    if (!marked) return this.resolveConflict(pending, 'terminal-conflict', 'failed');
    return this.requireRun(pending.runId);
  }

  private resolveConflict(
    pending: CronRun,
    event: CronExecutionLogContext['event'],
    requestedStatus: CronRun['status'],
  ): CronRun {
    const current = this.deps.runs.get(pending.runId);
    this.warnContext(pending, current?.status ?? 'missing', event, requestedStatus);
    if (current) return current;
    throw new CronExecutionError('CRON_RUN_FACT_MISSING', 'Cron run fact is missing');
  }

  private warn(
    run: CronRun,
    event: CronExecutionLogContext['event'],
    requestedStatus: CronRun['status'],
  ): void {
    this.warnContext(run, run.status, event, requestedStatus);
  }

  private warnContext(
    run: CronRun,
    currentStatus: CronRun['status'] | 'missing',
    event: CronExecutionLogContext['event'],
    requestedStatus: CronRun['status'],
  ): void {
    try {
      this.deps.logger.warn(
        {
          component: 'cron-executor',
          event,
          cronId: run.cronId,
          runId: run.runId,
          currentStatus,
          requestedStatus,
        },
        'Cron run conflict preserved the existing fact',
      );
    } catch {
      // Observability must never change the authoritative Cron run result.
    }
  }

  private requireRun(runId: string): CronRun {
    const current = this.deps.runs.get(runId);
    if (current) return current;
    throw new CronExecutionError('CRON_RUN_FACT_MISSING', 'Cron run fact is missing');
  }

  private listPendingRuns(): CronRun[] {
    return this.deps.runs.listPending();
  }
}

async function discardSessionBestEffort(
  sessionCreation: CronSessionCreationPort,
  sessionId: string,
): Promise<void> {
  try {
    await sessionCreation.discard?.(sessionId);
  } catch {
    // The durable fixed-session winner remains authoritative even if orphan cleanup fails.
  }
}

function normalizeCreateManualError(error: unknown): unknown {
  if (isCronNotFound(error)) {
    return new CronExecutionError(
      'CRON_DEFINITION_NOT_FOUND',
      'Cron definition was not found for manual execution',
    );
  }
  return error;
}

function currentExecutionInput(
  definition: CronDefinitionRecord | undefined,
): CronExecutionInput | undefined {
  if (!definition) return undefined;
  return {
    agentName: definition.agentName,
    cronName: definition.name,
    prompt: definition.prompt,
    sessionTarget: definition.sessionTarget,
    ...(definition.project === undefined ? {} : { project: definition.project }),
    ...(definition.model === undefined ? {} : { model: definition.model }),
  };
}

function settlePrepared(settleReady: SettleCronPreparation, run: CronRun): CronRun {
  settleReady({ kind: 'ready', run });
  return run;
}

async function observeCompletion(completion: Promise<CronRun>): Promise<void> {
  try {
    await completion;
  } catch {
    // The persisted CronRun terminal state remains authoritative for background failures.
  }
}

function isCronNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'CRON_NOT_FOUND'
  );
}

function targetSessionFailure(error: unknown): { code: string; message: string } {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code in TARGET_SESSION_FAILURE_MESSAGES) {
      const stableCode = code as keyof typeof TARGET_SESSION_FAILURE_MESSAGES;
      return { code: stableCode, message: TARGET_SESSION_FAILURE_MESSAGES[stableCode] };
    }
  }
  return { code: SESSION_CREATE_FAILED, message: SESSION_CREATE_ERROR };
}

function requireSessionId(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Cron session creation returned no sessionId');
  const sessionId = value.trim();
  if (sessionId.length === 0 || sessionId !== value) {
    throw new TypeError('Cron session creation returned an invalid sessionId');
  }
  return sessionId;
}

function executionMetricResult(run: CronRun | undefined): CronExecutionMetricResult {
  if (run?.status === 'delivered') return 'success';
  if (run?.status === 'pending') return 'skipped';
  return 'failure';
}

function triggerMetricOutcome(run: CronRun | undefined): CronTriggerMetricOutcome {
  if (run?.status === 'delivered') return 'executed';
  if (run?.status === 'pending') return 'skipped';
  return 'error';
}

function sanitizeErrorCode(value: unknown, requestText: string): string | undefined {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) return undefined;
  if (
    containsRequestText(value, requestText) ||
    containsRequestText(value.replaceAll('_', ' '), requestText)
  ) {
    return undefined;
  }
  return value;
}

function sanitizeBoundaryError(value: unknown, requestText: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const compact = compactBoundaryText(value);
  if (compact.length === 0) return undefined;
  if (containsSensitiveErrorData(compact) || containsRequestText(compact, requestText)) {
    return SESSION_DELIVERY_ERROR;
  }
  return compact.slice(0, MAX_BOUNDARY_ERROR_LENGTH);
}

function compactBoundaryText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsRequestText(error: string, requestText: string): boolean {
  const request = compactBoundaryText(requestText);
  if (request.length === 0) return false;

  const normalizedError = error.toLowerCase();
  const normalizedRequest = request.toLowerCase();
  if (normalizedError.includes(normalizedRequest)) return true;
  if (
    normalizedError.length < MIN_REQUEST_TEXT_FRAGMENT_LENGTH ||
    normalizedRequest.length < MIN_REQUEST_TEXT_FRAGMENT_LENGTH
  ) {
    return false;
  }
  for (
    let start = 0;
    start <= normalizedError.length - MIN_REQUEST_TEXT_FRAGMENT_LENGTH;
    start += 1
  ) {
    const fragment = normalizedError.slice(start, start + MIN_REQUEST_TEXT_FRAGMENT_LENGTH);
    if (normalizedRequest.includes(fragment)) return true;
  }
  return false;
}

function containsSensitiveErrorData(value: string): boolean {
  return (
    /\b(?:authorization|bearer|credential|password|prompt|secret|token|api[_-]?key)\b\s*[:=]/i.test(
      value,
    ) ||
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/i.test(value) ||
    /\bsk-[A-Za-z0-9_-]{8,}\b/.test(value) ||
    /\bfile:\/\/\S+/i.test(value) ||
    /(?:^|\s|\()(?:\/(?:Users|home|private|tmp|var|etc)\/|[A-Za-z]:\\)/.test(value) ||
    /\s+at\s+[^\s]+\s+\([^)]*:\d+:\d+\)/.test(value)
  );
}
