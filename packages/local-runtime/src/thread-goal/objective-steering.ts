import { createHash } from 'node:crypto';

import type { ThreadGoalState } from '@mavis/goal';

export class ObjectiveSteeringTargetChangedError extends Error {
  constructor() {
    super('Thread Goal objective steering target changed before delivery.');
    this.name = 'ObjectiveSteeringTargetChangedError';
  }
}

export function objectiveUpdateSteeringKey(
  goal: Pick<ThreadGoalState, 'goalId' | 'updatedAt' | 'objective'>,
): string {
  const digest = createHash('sha256').update(goal.objective).digest('hex').slice(0, 16);
  return `thread-goal-objective:${goal.goalId}:${goal.updatedAt}:${digest}`;
}
