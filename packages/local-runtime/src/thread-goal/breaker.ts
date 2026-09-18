import {
  fingerprintThreadGoalReply,
  type ThreadGoalBreakerCause,
  type ThreadGoalState,
  type ThreadGoalStore,
  type ThreadGoalToolActivity,
} from '@mavis/goal';

import type { GlobalEventPublisher } from '../events/global-events.js';
import type { ThreadGoalTurnAdmissionPreparation } from './admission.js';
import type { ThreadGoalRuntimeEventSink } from './events.js';
import { threadGoalRepeatedReplyLimit, type ThreadGoalGateConfig } from './gate.js';
import { publishThreadGoalEvent } from './wiring.js';

export type NoProgressBreakerDecision =
  | { readonly action: 'continue'; readonly goal: ThreadGoalState }
  | { readonly action: 'stop'; readonly reason?: string };

type GoalBreakerStore = Pick<ThreadGoalStore, 'getBySession' | 'updateBreaker'> & {
  resetBreakerAtEpoch(goalId: string, expectedEpoch: number): Promise<ThreadGoalState | undefined>;
};

interface GoalBreakerDeps {
  readonly store: () => GoalBreakerStore;
  readonly configGetter: () => ThreadGoalGateConfig;
  readonly nowMs: () => number;
  readonly publishGlobalEvent: GlobalEventPublisher;
  readonly emitRuntimeEvent: ThreadGoalRuntimeEventSink;
  readonly emitStateTransition: (from: ThreadGoalState['status'], goal: ThreadGoalState) => void;
  readonly reportFailure: (sessionId: string, message: string) => void;
  readonly formatError: (error: unknown) => string;
  /** Take responsibility for the follow-up an explicit reset just invalidated. */
  readonly armContinuationRearm: (goal: ThreadGoalState) => void;
  /** Rebuild that follow-up when the Turn that armed it will never settle. */
  readonly drainContinuationRearm: (input: {
    readonly sessionId: string;
    readonly turnId: string;
  }) => Promise<void>;
}

/** Owns repeated-reply breaker mutation and explicit-user reset semantics. */
export class GoalBreaker {
  constructor(private readonly deps: GoalBreakerDeps) {}

  /**
   * Persist "this Turn used tools" for a Turn that leaves the settlement
   * pipeline before the breaker stage.
   *
   * A dependency wait (questionnaire, permission, required background, owner
   * conflict) keeps the Goal active and returns at stage 5, so its real tool
   * calls would otherwise never interrupt the no-tool streak and a later Turn
   * could be counted as the third consecutive tool-less one. Only a trustworthy
   * `used` observation with a live streak writes anything, and the write can
   * only clear the counter — it can never nudge or pause.
   */
  async clearNoToolStreak(
    goal: ThreadGoalState,
    toolActivity: ThreadGoalToolActivity,
  ): Promise<ThreadGoalState> {
    if (toolActivity !== 'used' || goal.noToolStreak === 0) return goal;
    if (goal.status !== 'active') return goal;
    const result = await this.deps.store().updateBreaker(goal.goalId, {
      expectedEpoch: goal.updatedAt,
      fingerprint: null,
      toolActivity,
      limit: threadGoalRepeatedReplyLimit(this.deps.configGetter),
    });
    if (result.action === 'stale') return goal;
    this.emitDecision(result.goal, result.action, toolActivity, result.cause);
    return result.goal;
  }

  async apply(
    goal: ThreadGoalState,
    finalAssistantText: string | undefined,
    completionClaimed = false,
    toolActivity: ThreadGoalToolActivity = 'unknown',
  ): Promise<NoProgressBreakerDecision> {
    const fingerprint = fingerprintThreadGoalReply(finalAssistantText) || null;
    // An empty reply only skips the fingerprint branch. It may not hide a
    // trustworthy no-tool observation, so the store call still happens whenever
    // the tool condition has something to record or clear.
    if (!fingerprint && toolActivity === 'unknown' && goal.noToolStreak === 0) {
      this.emitDecision(goal, 'skipped', toolActivity);
      return { action: 'continue', goal };
    }

    let result: Awaited<ReturnType<ThreadGoalStore['updateBreaker']>>;
    try {
      result = await this.deps.store().updateBreaker(goal.goalId, {
        expectedEpoch: goal.updatedAt,
        fingerprint,
        toolActivity,
        limit: threadGoalRepeatedReplyLimit(this.deps.configGetter),
        ...(completionClaimed
          ? { pauseReason: 'paused(no_progress_after_completion_claim)' as const }
          : {}),
      });
    } catch (error) {
      this.deps.reportFailure(
        goal.sessionId,
        `thread_goal_breaker_failed:${this.deps.formatError(error)}`,
      );
      throw error;
    }

    if (result.action === 'stale') {
      this.emitDecision(result.goal ?? goal, 'skipped', toolActivity);
      return { action: 'stop' };
    }

    this.emitDecision(result.goal, result.action, toolActivity, result.cause);
    if (result.action !== 'pause') return { action: 'continue', goal: result.goal };

    this.deps.emitStateTransition(goal.status, result.goal);
    publishThreadGoalEvent(this.deps.publishGlobalEvent, { type: 'updated', goal: result.goal });
    return { action: 'stop', reason: result.goal.statusReason ?? 'breaker_stopped' };
  }

  /**
   * Prepare the breaker reset every explicit user Turn commits.
   *
   * The reset advances the Goal decision epoch, which invalidates the running
   * bound Turn, the follow-up already queued, and any verifier verdict still in
   * flight — none of which can schedule a replacement afterwards. So a reset
   * that lands owes the Goal a follow-up, and this preparation owns arming it:
   *
   * - `commit` arms the marker. The Turn it belongs to is guaranteed to settle,
   *   and `settleInjectedTurn` drains the marker for every Turn including
   *   unbound ones, so the normal path needs nothing else.
   * - `compensate` drains it directly. It runs exactly when the commit landed
   *   but the Turn never started, which is the one case where no settlement
   *   will ever come.
   * - `rollback` stays a no-op: it only runs when `commit` never did.
   */
  async prepareExplicitUserReset(input: {
    readonly sessionId: string;
    readonly turnId: string;
  }): Promise<ThreadGoalTurnAdmissionPreparation> {
    const { sessionId } = input;
    let goal: ThreadGoalState | undefined;
    try {
      goal = await this.deps.store().getBySession(sessionId);
    } catch (error) {
      this.deps.reportFailure(
        sessionId,
        `thread_goal_user_breaker_read_failed:${this.deps.formatError(error)}`,
      );
      return undefined;
    }
    if (!goal || goal.status !== 'active') return undefined;
    return {
      status: 'ready',
      commit: async () => {
        try {
          const reset = await this.deps.store().resetBreakerAtEpoch(goal.goalId, goal.updatedAt);
          if (!reset) return;
          publishThreadGoalEvent(this.deps.publishGlobalEvent, {
            type: 'updated',
            goal: reset,
          });
          // Arming must not fail the user's Turn: the user's work outranks Goal
          // continuation, and a lost marker still has startup recovery behind it.
          this.deps.armContinuationRearm(reset);
        } catch (error) {
          this.deps.reportFailure(
            sessionId,
            `thread_goal_user_breaker_reset_failed:${this.deps.formatError(error)}`,
          );
        }
      },
      rollback: async () => undefined,
      compensate: async () => {
        try {
          await this.deps.drainContinuationRearm(input);
        } catch (error) {
          // The drain keeps the marker armed on failure, so the next settlement
          // on this session or startup recovery still rebuilds the follow-up.
          // Escalating here would only turn an already-failing Turn start into
          // an AggregateError.
          this.deps.reportFailure(
            sessionId,
            `thread_goal_user_breaker_rearm_drain_failed:${this.deps.formatError(error)}`,
          );
        }
      },
    };
  }

  private emitDecision(
    goal: ThreadGoalState,
    action: 'none' | 'nudge' | 'pause' | 'skipped',
    toolActivity: ThreadGoalToolActivity,
    cause?: ThreadGoalBreakerCause,
  ): void {
    this.deps.emitRuntimeEvent({
      type: 'goal.breaker_decided',
      at: this.deps.nowMs(),
      payload: {
        goalId: goal.goalId,
        sessionId: goal.sessionId,
        action,
        occurrences: goal.replyFingerprint ? goal.noProgressStreak + 1 : 0,
        streak: goal.noProgressStreak,
        toolActivity,
        noToolStreak: goal.noToolStreak,
        ...(cause ? { cause } : {}),
      },
    });
  }
}
