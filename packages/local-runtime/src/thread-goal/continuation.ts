import { isContinuationStatus, type ThreadGoalState } from '@mavis/goal';

import type { GlobalEventPublisher } from '../events/global-events.js';
import type { LocalActiveTurnTimingReader } from '../turns/active-turn-timing.js';
import type { GoalDependencyGates } from './dependency-gates.js';
import type { ThreadGoalChangedEvent } from './events.js';
import {
  buildThreadGoalContinuationMessage,
  threadGoalBudgetLimitClientRequestId,
  threadGoalRearmClientRequestId,
} from './kickoff.js';
import { GoalInitialKickoffCoordinator, type InitialKickoffStore } from './initial-kickoff.js';
import {
  createThreadGoalContinuationOrchestrator,
  type ThreadGoalContinuationOrchestrator,
} from './orchestrator.js';
import {
  ObjectiveSteeringTargetChangedError,
  objectiveUpdateSteeringKey,
} from './objective-steering.js';
import { GoalContinuationRearm } from './continuation-rearm.js';
import { GoalPromptCoordinator } from './prompt-coordinator.js';
import type { GoalTimeAccounting } from './time-accounting.js';
import type { GoalTurnContextRegistry } from './turn-context.js';
import { publishThreadGoalEvent } from './wiring.js';
import { prepareGoalPrompt, type GoalPromptKind, type PreparedGoalPrompt } from './prompt.js';
import type { LocalThreadGoalIntegrationDeps } from './host-deps.js';

interface GoalContinuationRuntime {
  readonly isEnabled: () => boolean;
  readonly nowMs: () => number;
  readonly publishGlobalEvent: GlobalEventPublisher;
  readonly emitRuntimeEvent: NonNullable<LocalThreadGoalIntegrationDeps['emitRuntimeEvent']>;
  readonly abortVerification: (sessionId: string, reason: string) => void;
}

type GoalContinuationExternal = Pick<
  LocalThreadGoalIntegrationDeps,
  | 'startContinuationTurn'
  | 'steerContinuationTurn'
  | 'enqueuePostTurnContinuation'
  | 'enqueueInitialContinuationTurn'
  | 'hasPendingInitialContinuation'
  | 'cancelInitialContinuation'
  | 'requestQueueDispatch'
  | 'retireGoalQuestionnaire'
  | 'reportFailure'
  | 'formatError'
> & {
  readonly pauseActiveGoalForRetraction: (
    sessionId: string,
  ) => Promise<ThreadGoalState | undefined>;
};

interface GoalContinuationDeps {
  readonly store: () => InitialKickoffStore;
  readonly timeAccounting: GoalTimeAccounting;
  readonly turnContext: GoalTurnContextRegistry;
  readonly gates: GoalDependencyGates;
  readonly turnTimingReader: LocalActiveTurnTimingReader;
  readonly promptSnapshots: LocalThreadGoalIntegrationDeps['promptSnapshots'];
  readonly internalTurnPromptReads: LocalThreadGoalIntegrationDeps['internalTurnPromptReads'];
  readonly runtime: GoalContinuationRuntime;
  readonly external: GoalContinuationExternal;
}

/** Owns Goal continuation scheduling, kickoff materialization, and objective steering. */
export class GoalContinuation {
  readonly orchestrator: ThreadGoalContinuationOrchestrator;
  private readonly submittedBudgetLimitSummaries = new Set<string>();
  private readonly rearm: GoalContinuationRearm;
  private readonly initialKickoff: GoalInitialKickoffCoordinator;
  private readonly promptCoordinator: GoalPromptCoordinator;

  constructor(private readonly deps: GoalContinuationDeps) {
    this.promptCoordinator = new GoalPromptCoordinator({
      nowMs: deps.runtime.nowMs,
      emitRuntimeEvent: deps.runtime.emitRuntimeEvent,
    });
    this.initialKickoff = new GoalInitialKickoffCoordinator({
      store: deps.store,
      preparePrompt: (goal) => this.preparePrompt(goal, 'kickoff'),
      external: deps.external,
    });
    this.rearm = new GoalContinuationRearm({
      store: deps.store,
      patchFacts: deps,
      refreshQueuedKickoff: (goal) => this.initialKickoff.refreshQueuedKickoff(goal),
      submitActiveContinuation: (input) =>
        this.submitActiveContinuation(input, { rebuiltAfterEpochAdvance: true }),
    });
    this.orchestrator = createThreadGoalContinuationOrchestrator(
      deps.store(),
      (goal) => this.handleChanged({ type: 'updated', goal }),
      (goal) => this.selectPromptText(goal),
      (sessionId) => deps.external.pauseActiveGoalForRetraction(sessionId),
    );
  }

  handleChanged(event: ThreadGoalChangedEvent): void {
    if (!this.deps.runtime.isEnabled()) return;
    const eventTiming =
      event.type !== 'deleted'
        ? this.deps.turnTimingReader.getBySession(event.goal.sessionId)
        : undefined;
    if (event.type !== 'deleted' && event.goal.status !== 'paused' && eventTiming) {
      this.deps.timeAccounting.resume(eventTiming, event.goal);
    }
    const pausedTiming =
      event.type !== 'deleted' &&
      event.goal.status === 'paused' &&
      eventTiming &&
      !this.deps.turnContext.hasAccounting(eventTiming.turnId)
        ? eventTiming
        : undefined;
    const projectedEvent: ThreadGoalChangedEvent =
      event.type !== 'deleted' && pausedTiming
        ? { ...event, goal: this.deps.timeAccounting.project(event.goal, pausedTiming) }
        : event;
    if (projectedEvent.type === 'deleted') {
      this.promptCoordinator.clear(projectedEvent.goalId);
    }
    if (
      projectedEvent.type === 'updated' &&
      projectedEvent.userPatch === true &&
      projectedEvent.resumedFromReason === 'paused(retracted)' &&
      projectedEvent.goal.status === 'active'
    ) {
      this.promptCoordinator.armRecovery(projectedEvent.goal.goalId);
    }
    if (projectedEvent.type === 'updated' && projectedEvent.userPatch === true) {
      this.rearm.armUserPatch(projectedEvent.goal);
    }
    if (projectedEvent.type === 'updated' && projectedEvent.objectiveChanged === true) {
      void this.injectObjectiveUpdatedSteering(
        projectedEvent.goal,
        projectedEvent.userPatch === true,
      );
      return;
    }

    publishThreadGoalEvent(this.deps.runtime.publishGlobalEvent, projectedEvent);
    if (projectedEvent.type === 'deleted' || projectedEvent.goal.status === 'complete') {
      const sessionId =
        projectedEvent.type === 'deleted'
          ? projectedEvent.sessionId
          : projectedEvent.goal.sessionId;
      const goalId =
        projectedEvent.type === 'deleted' ? projectedEvent.goalId : projectedEvent.goal.goalId;
      this.rearm.clear(sessionId);
      this.promptCoordinator.clear(goalId);
      if (projectedEvent.type === 'deleted') {
        this.deps.timeAccounting.clearSession(sessionId);
        this.deps.runtime.abortVerification(sessionId, 'goal_deleted');
      }
      void this.retireGoalQuestionnaire(sessionId, goalId);
      if (projectedEvent.type !== 'deleted' || projectedEvent.kickoffCancelled !== true) {
        void this.initialKickoff.cancelByGoal(sessionId, goalId);
      }
      if (projectedEvent.type !== 'deleted') void this.initialKickoff.consume(projectedEvent.goal);
      return;
    }
    if (projectedEvent.goal.status !== 'active') {
      this.promptCoordinator.clearRecovery(projectedEvent.goal.goalId);
    }
    void this.maybeKick(projectedEvent);
  }

  async injectObjectiveUpdatedSteering(goal: ThreadGoalState, userPatch = false): Promise<void> {
    if (!this.deps.runtime.isEnabled()) return;
    const observedTurnId = this.deps.turnTimingReader.getBySession(goal.sessionId)?.turnId;
    this.promptCoordinator.armObjectiveUpdate(goal.goalId);
    this.deps.runtime.publishGlobalEvent({
      type: 'thread_goal.objective_updated_steering',
      payload: { sessionId: goal.sessionId, goalId: goal.goalId },
    });
    publishThreadGoalEvent(this.deps.runtime.publishGlobalEvent, { type: 'updated', goal });
    const canProbeActiveTurn =
      goal.status === 'active' &&
      goal.kickoffState === 'consumed' &&
      !(await this.deps.gates.hasPendingQuestionnaire(goal.sessionId, goal.goalId)) &&
      !(await this.deps.gates.hasPendingPermission(goal.sessionId)) &&
      !(await this.deps.gates.hasRequiredBackgroundWork(goal.sessionId));
    if (canProbeActiveTurn && this.deps.external.steerContinuationTurn) {
      try {
        const prompt = await this.preparePrompt(goal, 'objective-updated');
        const steered = await this.deps.external.steerContinuationTurn({
          sessionId: goal.sessionId,
          message: buildThreadGoalContinuationMessage(goal, prompt.content, 'active'),
          idempotencyKey: objectiveUpdateSteeringKey(goal),
          ...(prompt.internalPromptRead ? { internalPromptRead: prompt.internalPromptRead } : {}),
          onAccepted: async ({ mode, turnId }) => {
            if (
              mode !== 'steered' ||
              (observedTurnId !== undefined && turnId !== observedTurnId) ||
              (await this.deps.gates.hasPendingQuestionnaire(goal.sessionId, goal.goalId)) ||
              (await this.deps.gates.hasPendingPermission(goal.sessionId)) ||
              (await this.deps.gates.hasRequiredBackgroundWork(goal.sessionId))
            ) {
              throw new ObjectiveSteeringTargetChangedError();
            }
          },
        });
        if (
          steered.mode === 'activated' ||
          (observedTurnId !== undefined && steered.turnId !== observedTurnId)
        ) {
          throw new ObjectiveSteeringTargetChangedError();
        }
        this.promptCoordinator.clearObjectiveUpdate(goal.goalId);
        // The steered prompt rides a Turn whose binding this same PATCH has
        // already invalidated, so that Turn's settlement will stop at the
        // stale stage and never enqueue the next one. Re-arm here.
        this.rearm.armUserPatch(goal);
        return;
      } catch (error) {
        if (!(error instanceof ObjectiveSteeringTargetChangedError)) {
          this.deps.external.reportFailure(
            goal.sessionId,
            `thread_goal_objective_steering_failed:${this.deps.external.formatError(error)}`,
          );
        }
      }
    }
    void this.maybeKick({
      type: 'updated',
      goal,
      ...(userPatch ? { userPatch: true } : {}),
    });
  }

  async reconcileInitial(
    goal: ThreadGoalState,
    dispatch: boolean,
  ): Promise<ThreadGoalState['kickoffState']> {
    return this.initialKickoff.reconcile(goal, dispatch);
  }

  rollbackFailedCreation(goal: ThreadGoalState): Promise<void> {
    return this.initialKickoff.rollbackFailedCreation(goal);
  }

  cancelInitial(goal: ThreadGoalState): Promise<void> {
    return this.initialKickoff.cancel(goal);
  }

  requestQueueDispatch(sessionId: string): void {
    this.deps.external.requestQueueDispatch(sessionId);
  }

  consumeDeliveredInitial(goal: ThreadGoalState): Promise<void> {
    return this.initialKickoff.consumeDelivered(goal);
  }

  async enqueueBudgetLimitSummary(
    input: { readonly sessionId: string; readonly turnId: string },
    goal: ThreadGoalState,
  ): Promise<boolean> {
    const enqueue = this.deps.external.enqueuePostTurnContinuation;
    if (!enqueue) return false;
    const clientRequestId = threadGoalBudgetLimitClientRequestId(goal);
    if (this.submittedBudgetLimitSummaries.has(clientRequestId)) return true;
    try {
      const prompt = await this.preparePrompt(goal, 'budget-limit');
      await enqueue({
        sessionId: input.sessionId,
        turnId: input.turnId,
        message: buildThreadGoalContinuationMessage(goal, prompt.content, 'budget-limit'),
        clientRequestId,
        ...(prompt.internalPromptRead ? { internalPromptRead: prompt.internalPromptRead } : {}),
      });
      this.submittedBudgetLimitSummaries.add(clientRequestId);
      return true;
    } catch (error) {
      this.deps.external.reportFailure(
        input.sessionId,
        `thread_goal_budget_limit_enqueue_failed:${this.deps.external.formatError(error)}`,
      );
      throw error;
    }
  }

  async enqueueActive(input: {
    readonly sessionId: string;
    readonly turnId: string;
  }): Promise<void> {
    // Snapshot before the submission starts: an explicit user Turn can reset the
    // breaker while the Goal read and prompt build are in flight, and the item
    // this call is about to hand over would then already be stale.
    const observed = this.rearm.observe(input.sessionId);
    const submitted = await this.submitActiveContinuation(input);
    if (submitted === 'unavailable') return;
    // This settlement scheduled the follow-up itself (or found nothing left to
    // schedule); a queued re-arm of that same generation would only duplicate it.
    this.rearm.clearScheduled(input.sessionId, observed);
  }

  /** Take responsibility for the follow-up an explicit user Turn's reset invalidated. */
  armExplicitResetRearm(goal: ThreadGoalState): void {
    this.rearm.armExplicitReset(goal);
  }

  /** Rebuild the follow-up an out-of-band epoch advance left the Goal without. */
  drainContinuationRearm(input: {
    readonly sessionId: string;
    readonly turnId: string;
  }): Promise<void> {
    return this.rearm.drain(input);
  }

  /**
   * Rebuild the next `active` continuation from durable state and hand it to
   * the Queue. Deliberately does not touch the re-arm marker: the drain path
   * claims the marker before it starts and must not delete an arm that a newer
   * epoch writer installed while this submission was in flight.
   */
  private async submitActiveContinuation(
    input: {
      readonly sessionId: string;
      readonly turnId: string;
    },
    options: { readonly rebuiltAfterEpochAdvance?: boolean } = {},
  ): Promise<'submitted' | 'not-continuable' | 'unavailable'> {
    const enqueue = this.deps.external.enqueuePostTurnContinuation;
    if (!enqueue) return 'unavailable';
    try {
      const goal = await this.deps.store().getBySession(input.sessionId);
      if (!goal || !isContinuationStatus(goal.status)) return 'not-continuable';
      const prompt = await this.selectPrompt(goal);
      await enqueue({
        sessionId: input.sessionId,
        turnId: input.turnId,
        message: buildThreadGoalContinuationMessage(goal, prompt.content, 'active'),
        /*
         * A rebuild carries the settling Turn's id, whose default follow-up key
         * belongs to the epoch that was just invalidated. Key it by the epoch it
         * is actually being rebuilt at, so the Queue cannot fold it onto the
         * stale row while retries of this same rebuild stay idempotent.
         */
        ...(options.rebuiltAfterEpochAdvance
          ? { clientRequestId: threadGoalRearmClientRequestId(goal) }
          : {}),
        ...(prompt.internalPromptRead ? { internalPromptRead: prompt.internalPromptRead } : {}),
      });
      this.recordPromptSubmitted(goal, prompt.kind);
      return 'submitted';
    } catch (error) {
      this.deps.external.reportFailure(
        input.sessionId,
        `thread_goal_continuation_enqueue_failed:${this.deps.external.formatError(error)}`,
      );
      throw error;
    }
  }

  async shouldRecoverActive(goal: ThreadGoalState): Promise<boolean> {
    if (!this.deps.runtime.isEnabled() || !isContinuationStatus(goal.status)) return false;
    if (await this.deps.gates.hasPendingQuestionnaire(goal.sessionId, goal.goalId)) return false;
    if (await this.deps.gates.hasPendingPermission(goal.sessionId)) return false;
    if (await this.deps.gates.hasRequiredBackgroundWork(goal.sessionId)) return false;
    return true;
  }

  private async maybeKick(event: ThreadGoalChangedEvent): Promise<void> {
    if (!this.deps.runtime.isEnabled() || event.type === 'deleted') return;
    if (event.goal.status !== 'active') return;
    let goal = event.goal;
    // Snapshot before any await: this kick only owns the debt that already
    // existed when it started, never one an epoch advance installs mid-flight.
    const observedRearm = this.rearm.observe(goal.sessionId);
    const shouldRefreshQueuedKickoff =
      goal.kickoffState !== 'consumed' &&
      event.type === 'updated' &&
      event.userPatch === true &&
      !this.rearm.isArmed(goal.sessionId);
    if (shouldRefreshQueuedKickoff) {
      /*
       * `maybeKick` is fire-and-forget, so a failed rewrite must not surface as
       * an unhandled rejection. The coordinator already reported it and still
       * holds the re-delivery responsibility, so the next reconcile re-enqueues
       * the original kickoff rather than inferring it was consumed.
       */
      let refreshed: ThreadGoalState | undefined;
      try {
        refreshed = await this.initialKickoff.refreshQueuedKickoff(goal);
      } catch {
        return;
      }
      if (!refreshed || refreshed.status !== 'active') return;
      goal = refreshed;
      if (goal.kickoffState !== 'consumed') return;
    }
    if (this.deps.gates.isSessionBusy(goal.sessionId)) return;
    if (goal.kickoffState !== 'consumed') {
      if ((await this.initialKickoff.reconcile(goal, true)) !== 'consumed') {
        return;
      }
    }
    if (await this.deps.gates.hasPendingQuestionnaire(goal.sessionId, goal.goalId)) return;
    if (await this.deps.gates.hasPendingPermission(goal.sessionId)) return;
    if (await this.deps.gates.hasRequiredBackgroundWork(goal.sessionId)) return;
    try {
      const prompt = await this.selectPrompt(goal);
      const started = await this.deps.external.startContinuationTurn(
        goal.sessionId,
        buildThreadGoalContinuationMessage(goal, prompt.content, 'active'),
        event.type === 'created' ? goal.objective : undefined,
        prompt.internalPromptRead,
      );
      if (started !== 'already-active') {
        // This kick is the follow-up for the debt observed above; a newer arm
        // belongs to a newer epoch and must survive.
        this.rearm.clearScheduled(goal.sessionId, observedRearm);
        this.recordPromptSubmitted(goal, prompt.kind);
      }
    } catch (error) {
      this.deps.external.reportFailure(
        goal.sessionId,
        `thread_goal_continuation_start_failed:${this.deps.external.formatError(error)}`,
      );
    }
  }

  async selectPrompt(
    goal: ThreadGoalState,
  ): Promise<PreparedGoalPrompt & { readonly kind: GoalPromptKind }> {
    const override = this.promptCoordinator.selectOverride(goal);
    if (override) {
      return { ...(await this.preparePrompt(goal, override)), kind: override };
    }
    const kind = goal.noProgressStreak > 0 || goal.noToolStreak > 0 ? 'nudge' : 'continuation';
    return { ...(await this.preparePrompt(goal, kind)), kind };
  }

  recordPromptSubmitted(goal: ThreadGoalState, kind: GoalPromptKind): void {
    this.promptCoordinator.recordSubmitted(goal, kind);
  }

  preparePrompt(goal: ThreadGoalState, kind: GoalPromptKind): Promise<PreparedGoalPrompt> {
    const promptSnapshots = this.deps.promptSnapshots?.();
    const internalTurnPromptReads = this.deps.internalTurnPromptReads?.();
    return prepareGoalPrompt(goal, kind, {
      ...(promptSnapshots ? { promptSnapshots } : {}),
      ...(internalTurnPromptReads ? { internalTurnPromptReads } : {}),
    });
  }

  private async selectPromptText(goal: ThreadGoalState): Promise<string> {
    const prepared = await this.selectPrompt(goal);
    this.recordPromptSubmitted(goal, prepared.kind);
    if (prepared.internalPromptRead) {
      this.deps.internalTurnPromptReads?.()?.discard(prepared.internalPromptRead.requestedTurnId);
    }
    return prepared.content;
  }

  private async retireGoalQuestionnaire(sessionId: string, goalId: string): Promise<void> {
    try {
      await this.deps.external.retireGoalQuestionnaire(sessionId, goalId);
    } catch (error) {
      this.deps.external.reportFailure(
        sessionId,
        `thread_goal_questionnaire_retire_failed:${this.deps.external.formatError(error)}`,
      );
    }
  }
}
