import type { ThreadGoalState, ThreadGoalStore } from '@mavis/goal';

import type { LocalThreadGoalIntegrationDeps } from './host-deps.js';
import { buildThreadGoalKickoffMessage, threadGoalKickoffClientRequestId } from './kickoff.js';
import type { PreparedGoalPrompt } from './prompt.js';

export type InitialKickoffStore = ThreadGoalStore & {
  transitionKickoffState(
    goalId: string,
    expected: ThreadGoalState['kickoffState'],
    next: ThreadGoalState['kickoffState'],
  ): Promise<ThreadGoalState | undefined>;
};

type InitialKickoffExternal = Pick<
  LocalThreadGoalIntegrationDeps,
  | 'enqueueInitialContinuationTurn'
  | 'hasPendingInitialContinuation'
  | 'cancelInitialContinuation'
  | 'requestQueueDispatch'
  | 'reportFailure'
  | 'formatError'
>;

interface GoalInitialKickoffCoordinatorDeps {
  readonly store: () => InitialKickoffStore;
  readonly preparePrompt: (goal: ThreadGoalState) => Promise<PreparedGoalPrompt>;
  readonly external: InitialKickoffExternal;
}

/** Owns initial Goal kickoff materialization, replacement, recovery, and cancellation. */
export class GoalInitialKickoffCoordinator {
  /** Serialize rewrites so rapid PATCHes cannot restore an older Goal epoch. */
  private readonly refreshTails = new Map<string, Promise<void>>();
  /*
   * Goals whose queued kickoff was cancelled for a rewrite but not yet
   * re-delivered.
   *
   * `reconcile` otherwise reads `enqueued` with nothing in the Queue as "the
   * kickoff was delivered and consumed". That inference is right for a normal
   * delivery, but a rewrite whose re-enqueue failed leaves exactly the same
   * shape while the kickoff — and the one-shot attachment snapshot it carries —
   * has never run. Remembering the cancel keeps the delivery responsibility
   * with this coordinator until an enqueue actually succeeds.
   */
  private readonly awaitingRedelivery = new Set<string>();

  constructor(private readonly deps: GoalInitialKickoffCoordinatorDeps) {}

  async reconcile(
    goal: ThreadGoalState,
    dispatch: boolean,
    refreshQueued = false,
  ): Promise<ThreadGoalState['kickoffState']> {
    const clientRequestId = threadGoalKickoffClientRequestId(goal.goalId);
    let queued = await this.deps.external.hasPendingInitialContinuation(
      goal.sessionId,
      clientRequestId,
    );
    if (goal.status === 'complete' || goal.kickoffState === 'consumed') {
      if (queued)
        await this.deps.external.cancelInitialContinuation(goal.sessionId, clientRequestId);
      if (goal.kickoffState !== 'consumed') await this.consume(goal);
      return 'consumed';
    }
    if (goal.kickoffState === 'enqueued' && !queued && !this.awaitingRedelivery.has(goal.goalId)) {
      await this.consume(goal);
      return 'consumed';
    }
    if (refreshQueued && queued && goal.status === 'active') {
      await this.deps.external.cancelInitialContinuation(goal.sessionId, clientRequestId);
      // From here the kickoff owes a re-delivery, and only a successful enqueue
      // below discharges it.
      this.awaitingRedelivery.add(goal.goalId);
      queued = await this.deps.external.hasPendingInitialContinuation(
        goal.sessionId,
        clientRequestId,
      );
    }
    if (!queued) {
      const prompt = await this.deps.preparePrompt(goal);
      await this.deps.external.enqueueInitialContinuationTurn(
        goal,
        buildThreadGoalKickoffMessage(
          goal,
          prompt.content,
          goal.kickoffAttachments.map((attachment) => ({ ...attachment })),
        ),
        clientRequestId,
        prompt.internalPromptRead,
      );
    }
    this.awaitingRedelivery.delete(goal.goalId);
    if (goal.kickoffState === 'pending') {
      await this.deps.store().transitionKickoffState(goal.goalId, 'pending', 'enqueued');
    }
    if (dispatch) this.deps.external.requestQueueDispatch(goal.sessionId);
    return 'enqueued';
  }

  /** Rebuild a queued kickoff from the newest durable Goal after a decision-epoch advance. */
  async refreshQueuedKickoff(observed: ThreadGoalState): Promise<ThreadGoalState | undefined> {
    const previous = this.refreshTails.get(observed.sessionId) ?? Promise.resolve();
    const refresh = previous.then(async () => {
      const current = await this.deps.store().getBySession(observed.sessionId);
      if (
        !current ||
        current.goalId !== observed.goalId ||
        current.status !== 'active' ||
        current.kickoffState === 'consumed'
      ) {
        return undefined;
      }
      await this.reconcile(current, true, true);
      const refreshed = await this.deps.store().getBySession(observed.sessionId);
      return refreshed?.goalId === observed.goalId ? refreshed : undefined;
    });
    const tail = refresh.then(
      () => undefined,
      () => undefined,
    );
    this.refreshTails.set(observed.sessionId, tail);
    try {
      return await refresh;
    } catch (error) {
      this.deps.external.reportFailure(
        observed.sessionId,
        `thread_goal_kickoff_refresh_failed:${this.deps.external.formatError(error)}`,
      );
      /*
       * A stale or not-applicable refresh already returned `undefined` above.
       * Reaching here means the rewrite itself failed, so the caller still owes
       * this Goal a runner: swallowing it here is what let the re-arm drain
       * drop the marker and stop the Goal for good.
       */
      throw error;
    } finally {
      if (this.refreshTails.get(observed.sessionId) === tail) {
        this.refreshTails.delete(observed.sessionId);
      }
    }
  }

  async rollbackFailedCreation(goal: ThreadGoalState): Promise<void> {
    try {
      await this.cancel(goal);
    } catch (error) {
      this.deps.external.reportFailure(
        goal.sessionId,
        `thread_goal_kickoff_rollback_cancel_failed:${this.deps.external.formatError(error)}`,
      );
    }
    await this.deps.store().delete(goal.goalId);
  }

  cancel(goal: ThreadGoalState): Promise<void> {
    return this.cancelByGoal(goal.sessionId, goal.goalId);
  }

  cancelByGoal(sessionId: string, goalId: string): Promise<void> {
    return this.deps.external.cancelInitialContinuation(
      sessionId,
      threadGoalKickoffClientRequestId(goalId),
    );
  }

  async consumeDelivered(goal: ThreadGoalState): Promise<void> {
    if (goal.kickoffState !== 'enqueued') return;
    const clientRequestId = threadGoalKickoffClientRequestId(goal.goalId);
    if (await this.deps.external.hasPendingInitialContinuation(goal.sessionId, clientRequestId)) {
      return;
    }
    await this.consume(goal);
  }

  async consume(goal: ThreadGoalState): Promise<void> {
    if (goal.kickoffState === 'consumed') return;
    await this.deps.store().transitionKickoffState(goal.goalId, goal.kickoffState, 'consumed');
  }
}
