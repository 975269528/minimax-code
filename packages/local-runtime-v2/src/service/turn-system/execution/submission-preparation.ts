import type { TurnSubmissionPreparation, TurnSubmissionPreparationResult } from '../contracts.js';

type ReadyPreparation = Extract<TurnSubmissionPreparationResult, { readonly status: 'ready' }>;
type TurnSubmissionCandidate = Parameters<TurnSubmissionPreparation['prepare']>[0];
type GoalTurnAdmissionCandidate = TurnSubmissionCandidate & {
  readonly hasPendingPlan: (sessionId: string) => Promise<boolean>;
  readonly hasPriorityMailboxWork: (sessionId: string) => Promise<boolean>;
};
type GoalTurnAdmissionPreparation = (
  input: GoalTurnAdmissionCandidate,
) => ReturnType<TurnSubmissionPreparation['prepare']>;

/** Compose product participants without weakening any participant's rollback contract. */
export function composeTurnSubmissionPreparations(
  ...candidates: readonly (TurnSubmissionPreparation | undefined)[]
): TurnSubmissionPreparation | undefined {
  const preparations = candidates.filter(
    (candidate): candidate is TurnSubmissionPreparation => candidate !== undefined,
  );
  if (preparations.length === 0) return undefined;
  return {
    async prepare(input) {
      const ready: ReadyPreparation[] = [];
      try {
        for (const preparation of preparations) {
          const result = await preparation.prepare(input);
          if (!result) continue;
          if (result.status === 'rejected') {
            await restoreAll(ready, 'rollback');
            return result;
          }
          ready.push(result);
        }
      } catch (error) {
        await restoreAll(ready, 'rollback', error);
        throw error;
      }
      if (ready.length === 0) return undefined;
      let attemptedCommits = 0;
      return {
        status: 'ready',
        commit: async () => {
          for (const preparation of ready) {
            attemptedCommits += 1;
            await preparation.commit();
          }
        },
        rollback: () => restoreAll(ready, 'rollback'),
        compensate: async () => {
          const errors: unknown[] = [];
          for (let index = ready.length - 1; index >= 0; index -= 1) {
            try {
              if (index < attemptedCommits) await ready[index]?.compensate();
              else await ready[index]?.rollback();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0) {
            throw new AggregateError(errors, 'Submission preparation compensation failed');
          }
        },
      };
    },
  };
}

/** Adapts the Goal admission participant to the shared Turn preparation contract. */
export function createGoalTurnSubmissionPreparation(input: {
  readonly prepare: GoalTurnAdmissionPreparation | undefined;
  readonly hasPendingPlan: GoalTurnAdmissionCandidate['hasPendingPlan'];
  readonly hasPriorityMailboxWork: GoalTurnAdmissionCandidate['hasPriorityMailboxWork'];
}): TurnSubmissionPreparation | undefined {
  const prepare = input.prepare;
  if (!prepare) return undefined;
  return {
    prepare: (candidate) =>
      prepare({
        ...candidate,
        hasPendingPlan: input.hasPendingPlan,
        hasPriorityMailboxWork: input.hasPriorityMailboxWork,
      }),
  };
}

async function restoreAll(
  ready: readonly ReadyPreparation[],
  method: 'rollback' | 'compensate',
  primaryError?: unknown,
): Promise<void> {
  const errors: unknown[] = [];
  for (let index = ready.length - 1; index >= 0; index -= 1) {
    try {
      await ready[index]?.[method]();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 0) return;
  throw new AggregateError(
    primaryError === undefined ? errors : [primaryError, ...errors],
    `Submission preparation ${method} failed`,
  );
}
