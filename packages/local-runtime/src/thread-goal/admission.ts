import {
  digestThreadGoalObjective,
  isContinuationStatus,
  type GoalTurnBinding,
  type ThreadGoalBudgetCheckResult,
  type ThreadGoalState,
  type ThreadGoalStore,
  type ThreadGoalWaitReason,
} from '@mavis/goal';

import type { GlobalEventPublisher } from '../events/global-events.js';
import type { LocalActiveTurnTimingReader } from '../turns/active-turn-timing.js';
import type { GoalDependencyGates } from './dependency-gates.js';
import { checkThreadGoalTurnBudget } from './admission-budget.js';
import { classifyThreadGoalQueueItem } from './admission-queue.js';
import type { ThreadGoalRuntimeEventSink } from './events.js';
import {
  finalRecheck,
  type ThreadGoalFinalRecheckReason,
  type ThreadGoalFinalRecheckResult,
  type ThreadGoalGateConfig,
} from './gate.js';
import {
  readThreadGoalContinuationOrigin,
  readThreadGoalKickoffOrigin,
  type ThreadGoalQueueItemIdentity,
} from './kickoff.js';
import type { BoundGoalTurnKind, GoalTurnContextRegistry } from './turn-context.js';
import type { ThreadGoalExecutionWaitOperations } from './store-execution.js';
import { publishThreadGoalEvent } from './wiring.js';

export interface ThreadGoalTurnAdmissionInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly provenance: {
    readonly source: string;
    readonly sourceContext?: Readonly<Record<string, unknown>>;
  };
  readonly userInputResume?: {
    readonly kind: 'questionnaire';
    readonly requestId: string;
    readonly owner?: { readonly kind: 'thread-goal'; readonly goalId: string };
  };
  readonly hasPendingPlan: (sessionId: string) => Promise<boolean>;
  readonly hasPriorityMailboxWork: (sessionId: string) => Promise<boolean>;
}

export type ThreadGoalTurnAdmissionPreparation =
  | undefined
  | {
      readonly status: 'rejected';
      readonly reason: `policy:${string}`;
      readonly queueDisposition: 'defer' | 'cancel';
    }
  | {
      readonly status: 'ready';
      commit(): Promise<void>;
      rollback(): Promise<void>;
      compensate(): Promise<void>;
    };

type GoalAdmissionStore = Pick<ThreadGoalStore, 'getById' | 'getBySession'> &
  ThreadGoalExecutionWaitOperations & {
    transitionActiveAtEpoch(
      goalId: string,
      expectedEpoch: number,
      input: {
        readonly status: 'paused' | 'budget_limited';
        readonly statusReason: NonNullable<ThreadGoalState['statusReason']>;
      },
    ): Promise<ThreadGoalState | undefined>;
  };

interface GoalAdmissionEvents {
  readonly nowMs: () => number;
  readonly publishGlobalEvent: GlobalEventPublisher;
  readonly emitRuntimeEvent: ThreadGoalRuntimeEventSink;
  readonly emitStateTransition: (from: ThreadGoalState['status'], goal: ThreadGoalState) => void;
}

interface GoalAdmissionFailures {
  readonly report: (sessionId: string, message: string) => void;
  readonly format: (error: unknown) => string;
}

export interface GoalAdmissionDeps {
  readonly store: () => GoalAdmissionStore;
  readonly turnContext: GoalTurnContextRegistry;
  readonly gates: GoalDependencyGates;
  readonly turnTimingReader: LocalActiveTurnTimingReader;
  readonly configGetter: () => ThreadGoalGateConfig;
  readonly events: GoalAdmissionEvents;
  readonly failures: GoalAdmissionFailures;
  readonly prepareExplicitUserBreakerReset: (input: {
    readonly sessionId: string;
    readonly turnId: string;
  }) => Promise<ThreadGoalTurnAdmissionPreparation>;
}

/** Owns queue classification, final admission, immutable turn binding, and live budget fences. */
export class GoalAdmission {
  constructor(private readonly deps: GoalAdmissionDeps) {}

  classifyQueuedItem(
    item: ThreadGoalQueueItemIdentity,
    hasPendingPlan?: (sessionId: string) => Promise<boolean>,
  ): Promise<'ready' | 'defer' | 'cancel'> {
    return classifyThreadGoalQueueItem(item, hasPendingPlan, {
      getGoalBySession: (sessionId) => this.deps.store().getBySession(sessionId),
      gates: this.deps.gates,
      failures: this.deps.failures,
      emitDecision: (sessionId, goalId, decision, reason) =>
        this.emitAdmissionDecision(sessionId, goalId, decision, 'queue_selection', reason),
      emitQueueItemDeferred: (sessionId, reason) =>
        this.deps.events.emitRuntimeEvent({
          type: 'goal.queue_item_deferred',
          at: this.deps.events.nowMs(),
          payload: { sessionId, reason },
        }),
      projectExecutionWait: (goal, reason) => this.projectExecutionWait(goal, reason),
    });
  }

  async prepareTurnAdmission(
    input: ThreadGoalTurnAdmissionInput,
  ): Promise<ThreadGoalTurnAdmissionPreparation> {
    if (input.provenance.source !== 'thread-goal') {
      if (
        input.provenance.source === 'questionnaire' &&
        input.userInputResume?.owner?.kind === 'thread-goal'
      ) {
        return this.prepareGoalQuestionnaireResume(input, input.userInputResume.owner.goalId);
      }
      return isExplicitUserTurnSource(input.provenance.source)
        ? this.deps.prepareExplicitUserBreakerReset({
            sessionId: input.sessionId,
            turnId: input.turnId,
          })
        : undefined;
    }

    const origin = input.provenance.sourceContext?.origin;
    const kickoff = readThreadGoalKickoffOrigin(origin);
    const continuation = readThreadGoalContinuationOrigin(origin);
    const expected = kickoff ?? continuation;
    if (!expected) return rejectedAdmission('cancel', 'stale(turn_binding)');

    let result: ThreadGoalFinalRecheckResult;
    try {
      if (continuation?.kind === 'budget-limit') {
        const binding = await this.captureBudgetSummaryBinding(input, continuation);
        if (!binding) {
          this.emitAdmissionDecision(
            input.sessionId,
            continuation.goalId,
            'cancelled',
            'final_recheck',
            'stale(turn_binding)',
          );
          return rejectedAdmission('cancel', 'stale(turn_binding)');
        }
        return this.readyTurnBindingPreparation(input, binding, 'budget-summary');
      }

      result = await finalRecheck(
        {
          getGoalBySession: (sessionId) => this.deps.store().getBySession(sessionId),
          hasPendingQuestionnaire: (sessionId, goalId) =>
            this.deps.gates.hasPendingQuestionnaire(sessionId, goalId),
          hasPendingPermission: (sessionId) => this.deps.gates.hasPendingPermission(sessionId),
          hasPendingPlan: input.hasPendingPlan,
          hasRequiredBackgroundWork: (sessionId) =>
            this.deps.gates.hasRequiredBackgroundWork(sessionId),
          hasAutomationOwnerConflict: (sessionId) =>
            this.deps.gates.hasAutomationOwnerConflict(sessionId),
          hasPriorityMailboxWork: input.hasPriorityMailboxWork,
        },
        {
          sessionId: input.sessionId,
          goalId: expected.goalId,
          expectedUpdatedAt: expected.goalUpdatedAt,
          expectedObjectiveDigest: expected.objectiveDigest,
          turnId: input.turnId,
        },
        this.deps.configGetter,
      );
    } catch (error) {
      this.deps.failures.report(
        input.sessionId,
        `thread_goal_final_recheck_failed:${this.deps.failures.format(error)}`,
      );
      // A gate that cannot be read is still a blocker, and one the user can
      // neither see nor act on unless we say so.
      await this.projectExecutionWait(
        {
          goalId: expected.goalId,
          sessionId: input.sessionId,
          updatedAt: expected.goalUpdatedAt,
        },
        'dependency_unavailable',
      );
      this.emitAdmissionDecision(
        input.sessionId,
        expected.goalId,
        'deferred',
        'final_recheck',
        'deferred(dependency_unavailable)',
      );
      return {
        status: 'rejected',
        reason: 'policy:goal-final-recheck:deferred(final_recheck_unavailable)',
        queueDisposition: 'defer',
      };
    }

    if (result.decision === 'ready') {
      return this.readyTurnBindingPreparation(input, result.binding, 'main');
    }
    if (result.decision === 'pause' && result.goal) {
      const transitioned = await this.deps
        .store()
        .transitionActiveAtEpoch(result.goal.goalId, result.goal.updatedAt, {
          status: 'budget_limited',
          statusReason: result.reason,
        });
      if (transitioned) {
        this.deps.events.emitStateTransition(result.goal.status, transitioned);
        publishThreadGoalEvent(this.deps.events.publishGlobalEvent, {
          type: 'updated',
          goal: transitioned,
        });
      }
    }
    this.emitAdmissionDecision(
      input.sessionId,
      expected.goalId,
      result.decision === 'defer' ? 'deferred' : 'cancelled',
      'final_recheck',
      result.reason,
    );
    if ('waitReason' in result && result.waitReason && result.goal) {
      await this.projectExecutionWait(result.goal, result.waitReason);
    } else if (result.decision === 'cancel' && result.goal) {
      await this.clearExecutionWait(input.sessionId, expected.goalId, expected.goalUpdatedAt);
    }
    return rejectedAdmission(result.decision === 'defer' ? 'defer' : 'cancel', result.reason);
  }

  /**
   * Live budget fence used immediately before a v2 tool call. Each exhausted
   * check consumes at most one configured grace step before returning `stop`.
   */
  async checkTurnBudget(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly observedTokens: number;
  }): Promise<ThreadGoalBudgetCheckResult> {
    return checkThreadGoalTurnBudget(input, this.deps);
  }

  private async captureBudgetSummaryBinding(
    input: ThreadGoalTurnAdmissionInput,
    origin: NonNullable<ReturnType<typeof readThreadGoalContinuationOrigin>>,
  ): Promise<GoalTurnBinding | undefined> {
    const goal = await this.deps.store().getBySession(input.sessionId);
    if (
      !goal ||
      goal.goalId !== origin.goalId ||
      goal.status !== 'budget_limited' ||
      goal.updatedAt !== origin.goalUpdatedAt ||
      digestThreadGoalObjective(goal.objective) !== origin.objectiveDigest
    ) {
      return undefined;
    }
    return {
      goalId: goal.goalId,
      admittedGoalUpdatedAt: goal.updatedAt,
      objectiveDigest: origin.objectiveDigest,
      turnId: input.turnId,
    };
  }

  private async prepareGoalQuestionnaireResume(
    input: ThreadGoalTurnAdmissionInput,
    expectedGoalId: string,
  ): Promise<ThreadGoalTurnAdmissionPreparation> {
    let goal: ThreadGoalState | undefined;
    try {
      goal = await this.deps.store().getBySession(input.sessionId);
    } catch (error) {
      this.deps.failures.report(
        input.sessionId,
        `thread_goal_questionnaire_resume_read_failed:${this.deps.failures.format(error)}`,
      );
      return rejectedAdmission('defer', 'deferred(goal_not_active)');
    }
    if (!goal || goal.goalId !== expectedGoalId) {
      this.emitAdmissionDecision(
        input.sessionId,
        expectedGoalId,
        'cancelled',
        'final_recheck',
        'stale(turn_binding)',
      );
      return rejectedAdmission('cancel', 'stale(turn_binding)');
    }
    if (!isContinuationStatus(goal.status)) {
      this.emitAdmissionDecision(
        input.sessionId,
        goal.goalId,
        'deferred',
        'final_recheck',
        'deferred(goal_not_active)',
      );
      return rejectedAdmission('defer', 'deferred(goal_not_active)');
    }
    return this.readyTurnBindingPreparation(
      input,
      {
        goalId: goal.goalId,
        admittedGoalUpdatedAt: goal.updatedAt,
        objectiveDigest: digestThreadGoalObjective(goal.objective),
        turnId: input.turnId,
      },
      'main',
    );
  }

  private readyTurnBindingPreparation(
    input: ThreadGoalTurnAdmissionInput,
    binding: GoalTurnBinding,
    kind: BoundGoalTurnKind,
  ): Exclude<ThreadGoalTurnAdmissionPreparation, undefined | { readonly status: 'rejected' }> {
    this.emitAdmissionDecision(input.sessionId, binding.goalId, 'ready', 'final_recheck');
    return {
      status: 'ready',
      commit: async () => {
        this.deps.turnContext.setBinding(input.turnId, {
          sessionId: input.sessionId,
          binding,
          kind,
          mainTurns: kind === 'main' ? 1 : 0,
          graceStepsUsed: 0,
        });
        // The Turn is now bound, so whatever the Goal was waiting on is no
        // longer true. Clearing here (rather than on the `ready` verdict) keeps
        // the wait visible for the whole window in which admission could still
        // reject.
        await this.clearExecutionWait(
          input.sessionId,
          binding.goalId,
          binding.admittedGoalUpdatedAt,
        );
        this.deps.events.emitRuntimeEvent({
          type: 'goal.turn_bound',
          at: this.deps.events.nowMs(),
          payload: {
            goalId: binding.goalId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            goalUpdatedAt: binding.admittedGoalUpdatedAt,
          },
        });
      },
      rollback: async () => this.deps.turnContext.deleteBinding(input.turnId),
      compensate: async () => this.deps.turnContext.deleteBinding(input.turnId),
    };
  }

  private emitAdmissionDecision(
    sessionId: string,
    goalId: string,
    decision: 'ready' | 'deferred' | 'cancelled',
    phase: 'queue_selection' | 'final_recheck',
    reason?: string,
  ): void {
    this.deps.events.emitRuntimeEvent({
      type: 'goal.admission_decided',
      at: this.deps.events.nowMs(),
      payload: { goalId, sessionId, phase, decision, ...(reason ? { reason } : {}) },
    });
  }

  /**
   * Publish "this Goal is parked on <reason>" without disturbing admission.
   *
   * The store no-ops when the reason is unchanged or the epoch has moved on, so
   * repeated drains neither reset the user-visible wait timer nor emit
   * redundant events.
   */
  private async projectExecutionWait(
    goal: Pick<ThreadGoalState, 'goalId' | 'sessionId' | 'updatedAt'>,
    reason: ThreadGoalWaitReason,
  ): Promise<void> {
    await this.publishExecutionWaitChange(goal.sessionId, () =>
      this.deps.store().setExecutionWaitAtEpoch({
        goalId: goal.goalId,
        expectedUpdatedAt: goal.updatedAt,
        reason,
      }),
    );
  }

  private async clearExecutionWait(
    sessionId: string,
    goalId: string,
    expectedUpdatedAt: number,
  ): Promise<void> {
    await this.publishExecutionWaitChange(sessionId, () =>
      this.deps.store().clearExecutionWaitAtEpoch({ goalId, expectedUpdatedAt }),
    );
  }

  private async publishExecutionWaitChange(
    sessionId: string,
    write: () => Promise<ThreadGoalState | undefined>,
  ): Promise<void> {
    try {
      const updated = await write();
      if (!updated) return;
      publishThreadGoalEvent(this.deps.events.publishGlobalEvent, {
        type: 'updated',
        goal: updated,
      });
    } catch (error) {
      // The wait projection is an explanation, not a gate. Losing it degrades
      // the UI to today's behaviour; letting it throw would break dispatch.
      this.deps.failures.report(
        sessionId,
        `thread_goal_execution_wait_projection_failed:${this.deps.failures.format(error)}`,
      );
    }
  }
}

function rejectedAdmission(
  queueDisposition: 'defer' | 'cancel',
  reason: ThreadGoalFinalRecheckReason,
): Extract<ThreadGoalTurnAdmissionPreparation, { readonly status: 'rejected' }> {
  return {
    status: 'rejected',
    reason: `policy:goal-final-recheck:${reason}`,
    queueDisposition,
  };
}

function isExplicitUserTurnSource(source: string): boolean {
  return (
    source === 'api' ||
    source === 'questionnaire' ||
    source === 'communication' ||
    source === 'code_review' ||
    source.startsWith('channel:')
  );
}
