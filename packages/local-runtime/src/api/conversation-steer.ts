import type { ConversationSteerResult } from '@mavis/conversation-contract';

import type { LocalRuntimeApiHostOptions } from './host-helpers.js';

export interface SteerCompletionObserver {
  readonly sessionId: string;
  readonly matrixLogger?: LocalRuntimeApiHostOptions['matrixLogger'];
  /** Short producer label used in the runtime warning. */
  readonly producer: string;
}

/**
 * An `activated` steer starts a Turn and therefore owns its completion. A
 * producer that only needs the admission ACK still has to consume that
 * completion, otherwise a rejected Turn surfaces as an unhandled rejection in
 * the runtime process.
 */
export function observeSteerCompletion(
  result: ConversationSteerResult,
  observer: SteerCompletionObserver,
): ConversationSteerResult {
  if (result.mode !== 'activated') return result;
  void result.completion.catch((error: unknown) => {
    observer.matrixLogger?.warn(
      { sessionId: observer.sessionId, turnId: result.turnId },
      `${observer.producer} activated Turn failed after admission: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  return result;
}
