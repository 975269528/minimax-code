import { isContinuationStatus, type ThreadGoalState } from '@mavis/goal';

import {
  shouldArmExplicitResetRearm,
  shouldArmUserPatchRearm,
  type UserPatchRearmFacts,
} from './patch-rearm.js';

interface GoalContinuationRearmDeps {
  readonly store: () => {
    getBySession(sessionId: string): Promise<ThreadGoalState | undefined>;
  };
  /** Live execution facts the user-PATCH arm condition reads. */
  readonly patchFacts: UserPatchRearmFacts;
  /** Rebuild a still-queued kickoff at the current epoch. */
  readonly refreshQueuedKickoff: (goal: ThreadGoalState) => Promise<ThreadGoalState | undefined>;
  /**
   * Hand the next `active` continuation to the Queue. Must not touch the marker:
   * the drain claims it up front and a newer epoch writer may re-arm meanwhile.
   */
  readonly submitActiveContinuation: (input: {
    readonly sessionId: string;
    readonly turnId: string;
  }) => Promise<unknown>;
}

interface ArmedRearm {
  readonly goalId: string;
  /** Monotonic id, so a later arm can never be mistaken for the one observed. */
  readonly generation: number;
}

/**
 * What a caller observed before it started scheduling. `undefined` means nothing
 * was armed at that moment, so the caller owes the marker nothing.
 */
export type RearmObservation = number | undefined;

/**
 * Owns the follow-up debt created by a decision epoch advance that happened
 * outside settlement.
 *
 * Two writers advance `updated_at_ms` from outside settlement: a user PATCH,
 * and the breaker reset that every explicit user Turn commits. Either write
 * invalidates the running Turn's binding — its settlement stops at the stale
 * stage, before continuation — cancels the follow-up already sitting in the
 * Queue, and misses the write-back CAS of any verifier verdict still in flight,
 * while neither can schedule a replacement itself (`maybeKick` bails on a busy
 * session, successful objective steering returns before it, and the breaker
 * reset is a bare store write that publishes no lifecycle event at all). A
 * stale-cancelled Queue item produces no settlement of its own either, so it
 * cannot be relied on to wake the Goal.
 *
 * So the write that advanced the epoch arms a marker here, and the next
 * settlement on that session drains it, rebuilding the follow-up from durable
 * state at the *current* epoch.
 *
 * That makes this list an invariant, not an inventory: **a writer that advances
 * the decision epoch must take over the Goal's next step — by scheduling it, or
 * by arming a marker here. A writer that takes over nothing must not advance
 * it.** `bumpThreadGoalBoundUsage` is the boundary case that proves it: a stale
 * charge records real spend but decides nothing, so it keeps the epoch instead
 * of joining this list (see `store-bound-settlement.ts`). A future writer that
 * cannot keep the epoch belongs here.
 */
export class GoalContinuationRearm {
  /** Sessions owed a follow-up, mapped to the Goal the epoch advance landed on. */
  private readonly pending = new Map<string, ArmedRearm>();
  private generations = 0;

  constructor(private readonly deps: GoalContinuationRearmDeps) {}

  isArmed(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  /**
   * Snapshot the debt a caller is about to satisfy, before it starts awaiting.
   * Pair with {@link clearScheduled} so an arm installed mid-flight survives.
   */
  observe(sessionId: string): RearmObservation {
    return this.pending.get(sessionId)?.generation;
  }

  /**
   * Drop the debt because this caller scheduled the follow-up itself — but only
   * the generation it observed before it began.
   *
   * Scheduling a follow-up is asynchronous: the Goal is read, a prompt is built,
   * and only then is the Turn started or the Queue item submitted. An explicit
   * user Turn can reset the breaker anywhere inside that window, arming a marker
   * for the *new* epoch. The message this caller is about to hand over still
   * carries the old epoch and will be cancelled by `finalRecheck`, so deleting
   * the new marker would strand the Goal exactly the way this module exists to
   * prevent. Keeping it costs at most one redundant admission.
   */
  clearScheduled(sessionId: string, observed: RearmObservation): void {
    const armed = this.pending.get(sessionId);
    if (!armed || armed.generation !== observed) return;
    this.pending.delete(sessionId);
  }

  /** Drop the debt outright, because the Goal itself is gone or terminal. */
  clear(sessionId: string): void {
    this.pending.delete(sessionId);
  }

  /**
   * Arm for a user PATCH that could not schedule a follow-up itself. Only busy
   * sessions are armed: an idle session is `maybeKick`'s to own, and it starts
   * the next Turn on this same event. An enqueued kickoff is eligible only after
   * its active Turn is bound; otherwise the Queue owns it.
   */
  armUserPatch(goal: ThreadGoalState): void {
    if (!shouldArmUserPatchRearm(goal, this.deps.patchFacts)) return;
    this.arm(goal);
  }

  /**
   * Arm for the breaker reset an explicit user Turn just committed.
   *
   * Called with the Goal the reset CAS actually produced, so the caller has
   * already proven the decision epoch moved. See
   * {@link shouldArmExplicitResetRearm} for why this cannot reuse the PATCH
   * arm's live-execution guards.
   */
  armExplicitReset(goal: ThreadGoalState): void {
    if (!shouldArmExplicitResetRearm(goal)) return;
    this.arm(goal);
  }

  private arm(goal: ThreadGoalState): void {
    this.generations += 1;
    this.pending.set(goal.sessionId, { goalId: goal.goalId, generation: this.generations });
  }

  /**
   * Drain the marker once the Turn whose epoch advance invalidated the Goal's
   * runner has settled. Called for every settlement outcome — including turns
   * that were never bound to the Goal — because the explicit user Turn that
   * reset the breaker is exactly such a turn. The stages that do schedule a
   * follow-up clear the marker first, so this only fires when nothing else left
   * the Goal a runner.
   *
   * The follow-up is rebuilt from durable state, so the store stays the
   * authority — the Queue only transports what the Goal row still says is
   * continuable. A retracted, paused, or completed Goal therefore re-arms
   * nothing, and a Goal that was deleted and recreated is rejected by the goal
   * id check.
   *
   * A Goal whose kickoff has not been consumed is rebuilt as a kickoff rather
   * than as an `active` continuation: the epoch advance made the queued kickoff
   * stale, and only the kickoff carries the one-shot attachment snapshot.
   *
   * Duplication semantics are deliberately at-least-once, not exactly-once. The
   * marker is claimed synchronously (read and delete with no `await` between),
   * so two concurrent drains cannot both own it, and a failed drain re-arms only
   * when no newer writer has claimed the slot. Across a crash the in-memory
   * marker is lost and startup recovery is the backstop. A duplicate follow-up
   * costs one extra admission, which `finalRecheck` resolves; a lost one strands
   * the Goal, so the trade is intentional.
   */
  async drain(input: { readonly sessionId: string; readonly turnId: string }): Promise<void> {
    const armed = this.pending.get(input.sessionId);
    if (!armed) return;
    this.pending.delete(input.sessionId);
    try {
      const goal = await this.deps.store().getBySession(input.sessionId);
      if (!goal || goal.goalId !== armed.goalId || !isContinuationStatus(goal.status)) return;
      if (goal.kickoffState !== 'consumed') {
        const refreshed = await this.deps.refreshQueuedKickoff(goal);
        // The rebuilt kickoff owns execution at the new epoch; nothing else to do.
        if (!refreshed || refreshed.kickoffState !== 'consumed') return;
        if (!isContinuationStatus(refreshed.status)) return;
      }
      await this.deps.submitActiveContinuation(input);
    } catch (error) {
      // The submission already reported the transport failure. Stay armed so the
      // coordinator's settlement retry, the next settlement on this session, or
      // startup recovery rebuilds the follow-up — unless a newer writer has
      // already claimed the slot for a newer epoch.
      if (!this.pending.has(input.sessionId)) this.pending.set(input.sessionId, armed);
      throw error;
    }
  }
}
