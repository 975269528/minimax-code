import { digestSafetyInput, type InputSafetyDecision } from '../../../../content-safety/index.js';
import type { AgentExecutionSnapshot } from '../../preparation/contracts.js';
import type { LocalTurnExecutionInput } from '../contracts.js';

interface InputReviewResolution {
  readonly sessionId: string;
  readonly turnId: string;
  readonly userInput: string;
  readonly rejected: boolean;
}

export type InputReviewResolvedObserver = (input: InputReviewResolution) => void;

export interface InputReviewRunnerOptions {
  readonly reviewUserInput?: string;
  readonly inputSafetyDigest?: string;
  readonly inputSafetyDecision?: InputSafetyDecision;
  readonly onInputReviewResolved?: (rejected: boolean) => void;
}

/** Restricts input review to committed visible queries and isolates detached observers. */
export function inputReviewRunnerOptions<TAgent extends AgentExecutionSnapshot>(
  input: LocalTurnExecutionInput<TAgent>,
  observe?: InputReviewResolvedObserver,
): InputReviewRunnerOptions {
  if (input.request.requiresInputReview !== true) return {};
  const userInput = input.canonicalUserInput.text;
  return {
    reviewUserInput: userInput,
    inputSafetyDigest: digestSafetyInput(input.request.input),
    ...(input.request.inputSafetyDecision
      ? { inputSafetyDecision: input.request.inputSafetyDecision }
      : {}),
    ...(observe
      ? {
          onInputReviewResolved: (rejected) => {
            try {
              observe({
                sessionId: input.lease.sessionId,
                turnId: input.lease.turnId,
                userInput,
                rejected,
              });
            } catch {
              // Detached title/observation work cannot change the owning Turn verdict.
            }
          },
        }
      : {}),
  };
}
