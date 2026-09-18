import {
  type ThreadGoalBoundStoreOperations,
  type ThreadGoalBudgetLimits,
  type ThreadGoalDecisionResult,
  type ThreadGoalSettleBoundTurnInput,
  type ThreadGoalState,
  type ThreadGoalStore,
  type TranscriptWindowReader,
  type VerifierPort,
} from '@mavis/goal';

import type { GlobalEventPublisher } from '../events/global-events.js';
import type { LocalActiveTurnTimingReader } from '../turns/active-turn-timing.js';
import type { GoalBreaker } from './breaker.js';
import type { GoalContinuation } from './continuation.js';
import type { GoalDependencyGates } from './dependency-gates.js';
import type { ThreadGoalRuntimeEventSink } from './events.js';
import { type ThreadGoalGateConfig } from './gate.js';
import {
  effectiveGoalBudgetLimits,
  firstGoalSettlementDependency,
  type ThreadGoalSettlementDependency,
} from './settlement-gates.js';
import type { ThreadGoalExecutionWaitOperations } from './store-execution.js';
import {
  goalFailureTransition,
  settlementTransitionDecision,
  type ThreadGoalSettlementDecision,
} from './settlement-transitions.js';
import type { GoalTimeAccounting } from './time-accounting.js';
import type {
  BoundGoalTurn,
  BoundTurnAccounting,
  GoalTurnContextRegistry,
} from './turn-context.js';
import { sanitizeUsageCounter, threadGoalTurnToolActivity } from './turn-work-signals.js';
import {
  normalizeVerificationResult,
  ThreadGoalVerificationSettlement,
  type ThreadGoalSettlementInput,
  type ThreadGoalVerificationSettlementContext,
} from './verification-settlement.js';
import { publishThreadGoalEvent } from './wiring.js';
import {
  emitThreadGoalWorkerProposalDecision,
  threadGoalWorkerProposalInput,
} from './worker-proposal.js';

export type { ThreadGoalSettlementInput } from './verification-settlement.js';
export type { ThreadGoalSettlementDecision } from './settlement-transitions.js';

interface ThreadGoalSettlementContext extends ThreadGoalVerificationSettlementContext {
  readonly accounting: BoundTurnAccounting;
}

type TurnAccountingAttempt =
  | { readonly kind: 'not_a_goal_turn' }
  | {
      readonly kind: 'accounting_failed';
      readonly error: unknown;
      readonly boundTurn: BoundGoalTurn;
    }
  | { readonly kind: 'ok'; readonly accounting: BoundTurnAccounting };

type GoalSettlementStore = ThreadGoalStore &
  ThreadGoalBoundStoreOperations &
  ThreadGoalExecutionWaitOperations;

interface GoalSettlementRuntime {
  readonly isEnabled: () => boolean;
  readonly nowMs: () => number;
  readonly configGetter: () => ThreadGoalGateConfig;
  readonly publishGlobalEvent: GlobalEventPublisher;
  readonly emitRuntimeEvent: ThreadGoalRuntimeEventSink;
  readonly emitStateTransition: (from: ThreadGoalState['status'], goal: ThreadGoalState) => void;
  readonly reportFailure: (sessionId: string, message: string) => void;
  readonly formatError: (error: unknown) => string;
}

interface GoalSettlementDeps {
  readonly store: () => GoalSettlementStore;
  readonly turnTimingReader: LocalActiveTurnTimingReader;
  readonly turnContext: GoalTurnContextRegistry;
  readonly timeAccounting: GoalTimeAccounting;
  readonly gates: GoalDependencyGates;
  readonly breaker: GoalBreaker;
  readonly continuation: GoalContinuation;
  readonly runtime: GoalSettlementRuntime;
}

/** Owns bound usage accounting and the ten-stage terminal Goal decision pipeline. */
export class GoalSettlement {
  private readonly verification: ThreadGoalVerificationSettlement;

  constructor(private readonly deps: GoalSettlementDeps) {
    this.verification = new ThreadGoalVerificationSettlement({
      store: deps.store(),
      nowMs: deps.runtime.nowMs,
      configGetter: deps.runtime.configGetter,
      publishGlobalEvent: deps.runtime.publishGlobalEvent,
      reportFailure: deps.runtime.reportFailure,
      formatError: deps.runtime.formatError,
      emitRuntimeEvent: deps.runtime.emitRuntimeEvent,
      emitStateTransition: deps.runtime.emitStateTransition,
      enqueueBudgetLimitSummary: (input, goal) =>
        deps.continuation.enqueueBudgetLimitSummary(input, goal),
    });
  }

  bindVerifier(verifier: VerifierPort, transcriptWindowReader: TranscriptWindowReader): void {
    this.verification.bind(verifier, transcriptWindowReader);
  }

  abortVerification(sessionId: string, reason: string): void {
    this.verification.abortSession(sessionId, reason);
  }

  async recordTurnAccounting(
    sessionId: string,
    turnId: string,
    tokens: number,
  ): Promise<BoundTurnAccounting | undefined> {
    const attempt = await this.attemptTurnAccounting(sessionId, turnId, tokens);
    return attempt.kind === 'ok' ? attempt.accounting : undefined;
  }

  private async attemptTurnAccounting(
    sessionId: string,
    turnId: string,
    tokens: number,
  ): Promise<TurnAccountingAttempt> {
    if (!this.deps.runtime.isEnabled()) return { kind: 'not_a_goal_turn' };
    const cached = this.deps.turnContext.getAccounting(turnId);
    if (cached) return { kind: 'ok', accounting: cached };
    const boundTurn = this.deps.turnContext.getBinding(turnId);
    if (!boundTurn) return { kind: 'not_a_goal_turn' };
    const timing = this.deps.turnTimingReader.getByTurn(sessionId, turnId);
    let accountingCompleted = false;
    try {
      const goal = await this.deps.store().getById(boundTurn.binding.goalId);
      if (goal?.kickoffState === 'enqueued') {
        await this.deps.continuation.consumeDeliveredInitial(goal);
      }
      const activeSeconds = timing
        ? goal
          ? this.deps.timeAccounting.elapsedSeconds(timing, goal)
          : this.deps.turnTimingReader.elapsedSeconds(timing)
        : 0;
      const result = await this.deps.store().bumpBoundUsage(
        boundTurn.binding,
        {
          tokens: sanitizeUsageCounter(tokens),
          activeSeconds,
          mainTurns: boundTurn.mainTurns,
        },
        effectiveGoalBudgetLimits(goal, this.deps.runtime.configGetter),
      );
      const accounting = { boundTurn, activeSeconds, result } satisfies BoundTurnAccounting;
      accountingCompleted = true;
      this.deps.turnContext.setAccounting(turnId, accounting);
      if (result.goal) {
        publishThreadGoalEvent(this.deps.runtime.publishGlobalEvent, {
          type: 'updated',
          goal: result.goal,
        });
      }
      if (result.transitioned && result.goal) {
        this.deps.runtime.emitRuntimeEvent({
          type: 'goal.budget_decided',
          at: this.deps.runtime.nowMs(),
          payload: {
            goalId: result.goal.goalId,
            sessionId: result.goal.sessionId,
            decision: 'limited',
            dimension: result.transitioned,
            tokensUsed: result.goal.tokensUsed,
            turnsUsed: result.goal.turnsUsed,
            activeSeconds: result.goal.timeUsedSeconds,
          },
        });
        this.deps.runtime.emitStateTransition('active', result.goal);
      }
      return { kind: 'ok', accounting };
    } catch (error) {
      this.deps.runtime.reportFailure(
        sessionId,
        `thread_goal_accounting_failed:${this.deps.runtime.formatError(error)}`,
      );
      return { kind: 'accounting_failed', error, boundTurn };
    } finally {
      if (accountingCompleted && timing) this.deps.timeAccounting.finish(timing);
    }
  }

  async settleInjectedTurn(
    input: ThreadGoalSettlementInput,
  ): Promise<ThreadGoalSettlementDecision> {
    const decision = await this.runDecisionPipeline(input);
    // An out-of-band decision epoch advance — a user PATCH, or the breaker
    // reset this very Turn committed when it is an explicit user Turn — left
    // the Goal without a runner: the pipeline above stopped at the stale stage
    // and the Queue item bound to the old epoch was cancelled. Rebuild the
    // follow-up from durable state; the stages that already enqueued one
    // drained the marker, so this can never double-submit.
    await this.deps.continuation.drainContinuationRearm(input);
    return decision;
  }

  private async runDecisionPipeline(
    input: ThreadGoalSettlementInput,
  ): Promise<ThreadGoalSettlementDecision> {
    const accounted = await this.stage1Account(input);
    if ('stage' in accounted) return accounted;
    const classified = this.stage2ClassifyStale(input, accounted.accounting);
    if ('stage' in classified) return classified;
    const terminal = await this.stage3ClassifyTerminal(classified.context);
    if (terminal) return terminal;
    const budget = await this.stage4FinalizeBudget(classified.context);
    if (budget) return budget;
    const dependency = await this.stage5CheckDependencies(classified.context);
    if (dependency) return dependency;
    await this.verification.applyPolicy(classified.context);
    const verification = await this.verification.accountAndRecord(classified.context);
    const charged = await this.verification.chargeVerifierUsage(classified.context);
    if (verification) return verification;
    if (charged) return charged;
    const breaker = await this.stage8ApplyBreaker(classified.context);
    if (breaker) return breaker;
    const finalDecision = await this.stage9CommitDecision(classified.context);
    if (finalDecision) return finalDecision;
    return this.stage10SubmitContinuation(classified.context);
  }

  private async stage1Account(
    input: ThreadGoalSettlementInput,
  ): Promise<{ readonly accounting: BoundTurnAccounting } | ThreadGoalSettlementDecision> {
    const attempt = await this.attemptTurnAccounting(input.sessionId, input.turnId, input.tokens);
    if (attempt.kind === 'not_a_goal_turn') {
      return { stage: 1, action: 'ignored', reason: 'not_a_goal_turn' };
    }
    if (attempt.kind === 'accounting_failed') {
      return this.pauseAfterAccountingFailure(attempt.boundTurn);
    }
    const { accounting } = attempt;
    this.deps.runtime.emitRuntimeEvent({
      type: 'goal.turn_settled',
      at: this.deps.runtime.nowMs(),
      payload: {
        goalId: accounting.boundTurn.binding.goalId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        status: input.status,
        ...(input.status === 'failed' ? { failureClass: input.failureClass ?? 'unknown' } : {}),
        tokens: sanitizeUsageCounter(input.tokens),
        ...(input.usageIncomplete ? { usageIncomplete: true } : {}),
        activeSeconds: accounting.activeSeconds,
      },
    });
    return { accounting };
  }

  private async pauseAfterAccountingFailure(
    boundTurn: BoundGoalTurn,
  ): Promise<ThreadGoalSettlementDecision> {
    const reason = 'paused(accounting_unavailable)' as const;
    const settled = await this.deps.store().settleBoundTurn({
      goalId: boundTurn.binding.goalId,
      expectedEpoch: boundTurn.binding.admittedGoalUpdatedAt,
      objectiveDigest: boundTurn.binding.objectiveDigest,
      next: { status: 'paused', statusReason: reason },
    });
    if (settled.status === 'stale') {
      return {
        stage: 1,
        action: 'stale',
        reason: settled.staleReason,
        ...(settled.goal ? { goalId: settled.goal.goalId } : {}),
      };
    }
    this.deps.runtime.emitStateTransition('active', settled.goal);
    publishThreadGoalEvent(this.deps.runtime.publishGlobalEvent, {
      type: 'updated',
      goal: settled.goal,
    });
    return {
      stage: 1,
      action: 'settled',
      reason,
      goalId: settled.goal.goalId,
      decisionEpoch: settled.decisionEpoch,
    };
  }

  private stage2ClassifyStale(
    input: ThreadGoalSettlementInput,
    accounting: BoundTurnAccounting,
  ): { readonly context: ThreadGoalSettlementContext } | ThreadGoalSettlementDecision {
    const goal = accounting.result.goal;
    if (accounting.result.staleReason || !goal || accounting.result.decisionEpoch === undefined) {
      return {
        stage: 2,
        action: 'stale',
        reason: accounting.result.staleReason ?? 'missing_goal',
        goalId: accounting.boundTurn.binding.goalId,
        ...(accounting.result.decisionEpoch !== undefined
          ? { decisionEpoch: accounting.result.decisionEpoch }
          : {}),
      };
    }
    const signal = this.deps.turnContext.getSignal(input.turnId);
    return { context: { input, accounting, goal, ...(signal ? { signal } : {}) } };
  }

  private async stage3ClassifyTerminal(
    context: ThreadGoalSettlementContext,
  ): Promise<ThreadGoalSettlementDecision | undefined> {
    if (context.input.retracted) {
      const next = { status: 'paused', statusReason: 'paused(retracted)' } as const;
      return settlementTransitionDecision(
        3,
        next.statusReason,
        await this.settleBoundStatus(context.accounting, next),
      );
    }
    if (context.input.status === 'failed') {
      const next = goalFailureTransition(context.input.failureClass ?? 'unknown');
      return settlementTransitionDecision(
        3,
        next.statusReason,
        await this.settleBoundStatus(context.accounting, next),
      );
    }
    if (context.input.status === 'aborted') {
      return {
        stage: 3,
        action: 'stopped',
        reason: 'turn_aborted',
        goalId: context.goal.goalId,
        decisionEpoch: context.goal.updatedAt,
      };
    }
    return undefined;
  }

  private async stage4FinalizeBudget(
    context: ThreadGoalSettlementContext,
  ): Promise<ThreadGoalSettlementDecision | undefined> {
    if (context.goal.status !== 'budget_limited') return undefined;
    if (context.accounting.boundTurn.kind !== 'budget-summary') {
      await this.deps.continuation.enqueueBudgetLimitSummary(context.input, context.goal);
    }
    return {
      stage: 4,
      action: 'budget_limited',
      reason: context.goal.statusReason ?? 'budget_limited',
      goalId: context.goal.goalId,
      decisionEpoch: context.goal.updatedAt,
    };
  }

  private async stage5CheckDependencies(
    context: ThreadGoalSettlementContext,
  ): Promise<ThreadGoalSettlementDecision | undefined> {
    const dependency = await firstGoalSettlementDependency(context.goal, this.deps.gates);
    if (!dependency) return undefined;
    // This Turn leaves the pipeline before the breaker stage, but its real tool
    // calls still have to interrupt the no-tool streak. Persist that first so
    // the deferred continuation is enqueued against the resulting epoch.
    context.goal = await this.deps.breaker.clearNoToolStreak(
      context.goal,
      threadGoalTurnToolActivity(context),
    );
    await this.deps.continuation.enqueueActive(context.input);
    return {
      stage: 5,
      action: 'deferred',
      reason: `deferred(${dependency})`,
      goalId: context.goal.goalId,
      decisionEpoch: context.goal.updatedAt,
    };
  }

  private async stage8ApplyBreaker(
    context: ThreadGoalSettlementContext,
  ): Promise<ThreadGoalSettlementDecision | undefined> {
    if (context.verificationAlreadyRecorded) return undefined;
    if (context.verificationOutcome?.type === 'result') {
      const verdict = normalizeVerificationResult(context.verificationOutcome.result).verdict
        .verdict;
      if (verdict !== 'not_met') return undefined;
    }
    if (context.proposedTransition && context.proposedTransition.status !== 'complete') {
      return undefined;
    }
    if (context.goal.status !== 'active') return undefined;
    // The breaker writes and advances the Goal epoch, so a settlement retry
    // must replay the first decision instead of scoring this Turn again.
    const breaker =
      this.deps.turnContext.getBreakerDecision(context.input.turnId) ??
      (await this.deps.breaker.apply(
        context.goal,
        context.input.finalAssistantText,
        context.proposedTransition?.status === 'complete',
        threadGoalTurnToolActivity(context),
      ));
    this.deps.turnContext.setBreakerDecision(
      context.input.turnId,
      context.input.sessionId,
      breaker,
    );
    if (breaker.action === 'stop') {
      return {
        stage: 8,
        action: 'stopped',
        reason: breaker.reason ?? 'breaker_stopped',
        goalId: context.goal.goalId,
      };
    }
    context.goal = breaker.goal;
    return undefined;
  }

  private async stage9CommitDecision(
    context: ThreadGoalSettlementContext,
  ): Promise<ThreadGoalSettlementDecision | undefined> {
    if (!context.proposedTransition) return undefined;
    const settled = await this.settleBoundStatus(
      context.accounting,
      context.proposedTransition,
      context.goal,
      threadGoalWorkerProposalInput(context.signal, context.input.turnId),
    );
    emitThreadGoalWorkerProposalDecision({
      signal: context.signal,
      sessionId: context.input.sessionId,
      turnId: context.input.turnId,
      result: settled,
      at: this.deps.runtime.nowMs(),
      emit: this.deps.runtime.emitRuntimeEvent,
    });
    if (context.verificationOutcome?.type === 'failure') {
      this.verification.emitDecision(context, settled.status === 'stale' ? 'stale' : 'unavailable');
    }
    return settlementTransitionDecision(9, context.proposedTransition.statusReason, settled);
  }

  private async stage10SubmitContinuation(
    context: ThreadGoalSettlementContext,
  ): Promise<ThreadGoalSettlementDecision> {
    await this.deps.continuation.enqueueActive(context.input);
    return {
      stage: 10,
      action: 'continued',
      reason: 'goal_active',
      goalId: context.goal.goalId,
      decisionEpoch: context.goal.updatedAt,
    };
  }

  private async settleBoundStatus(
    accounting: BoundTurnAccounting,
    next: ThreadGoalSettleBoundTurnInput['next'],
    decisionGoal = accounting.result.goal,
    workerProposal?: ThreadGoalSettleBoundTurnInput['workerProposal'],
  ): Promise<ThreadGoalDecisionResult> {
    if (!decisionGoal) return { status: 'stale', staleReason: 'missing_goal' };
    const settled = await this.deps.store().settleBoundTurn({
      goalId: accounting.boundTurn.binding.goalId,
      expectedEpoch: decisionGoal.updatedAt,
      objectiveDigest: accounting.boundTurn.binding.objectiveDigest,
      next,
      ...(workerProposal ? { workerProposal } : {}),
    });
    if (settled.status === 'settled') {
      this.deps.runtime.emitStateTransition(decisionGoal.status, settled.goal);
      publishThreadGoalEvent(this.deps.runtime.publishGlobalEvent, {
        type: 'updated',
        goal: settled.goal,
      });
    }
    return settled;
  }
}
