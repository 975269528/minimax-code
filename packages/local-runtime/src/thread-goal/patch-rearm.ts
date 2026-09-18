import { isContinuationStatus, type ThreadGoalState } from '@mavis/goal';

import type { LocalActiveTurnTimingReader } from '../turns/active-turn-timing.js';
import type { GoalDependencyGates } from './dependency-gates.js';
import type { GoalTurnContextRegistry } from './turn-context.js';

export interface UserPatchRearmFacts {
  readonly gates: Pick<GoalDependencyGates, 'isSessionBusy'>;
  readonly turnTimingReader: LocalActiveTurnTimingReader;
  readonly turnContext: GoalTurnContextRegistry;
}

/** Keep Queue ownership until the enqueued kickoff has entered its bound Turn. */
export function shouldArmUserPatchRearm(
  goal: ThreadGoalState,
  facts: UserPatchRearmFacts,
): boolean {
  if (!isContinuationStatus(goal.status) || !facts.gates.isSessionBusy(goal.sessionId))
    return false;
  if (goal.kickoffState === 'consumed') return true;
  if (goal.kickoffState !== 'enqueued') return false;
  const activeTurn = facts.turnTimingReader.getBySession(goal.sessionId);
  if (!activeTurn) return false;
  return facts.turnContext.getBinding(activeTurn.turnId)?.binding.goalId === goal.goalId;
}

/**
 * Arm condition for the explicit-user-turn breaker reset.
 *
 * Deliberately *not* {@link shouldArmUserPatchRearm}. That predicate reads the
 * session's live execution facts (`isSessionBusy`, the bound Turn behind an
 * `enqueued` kickoff) because a user PATCH arrives asynchronously and has to
 * decide whether the Queue or `maybeKick` already owns the follow-up. The
 * breaker reset commits from inside the admission of the explicit user Turn
 * itself, where those facts are not yet true and not reliable: the Turn that is
 * about to run has not started, so the session can still read idle, and the
 * kickoff item is being dequeued right now.
 *
 * The condition that *is* reliable there is the CAS outcome. A successful
 * `resetBreakerAtEpoch` advances the decision epoch, which by construction
 * invalidates every runner the Goal had — the running bound Turn's binding, the
 * queued follow-up, and any verifier verdict still in flight. So a reset that
 * actually landed on a continuable Goal always leaves that Goal without a
 * runner, and always owes it a replacement.
 */
export function shouldArmExplicitResetRearm(goal: ThreadGoalState): boolean {
  return isContinuationStatus(goal.status);
}
