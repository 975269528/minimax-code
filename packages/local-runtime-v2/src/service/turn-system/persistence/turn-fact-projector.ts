import type { AgentEventContext, CommittedHistoryChange } from '../agent-host/contracts.js';
import type { RequiredAgentEventProjector } from '../agent-host/events/required-agent-event-delivery.js';
import type { TurnRepository } from './contracts.js';

class TurnFactAssociationError extends Error {
  override readonly name = 'TurnFactAssociationError';

  constructor(readonly turnId: string) {
    super(`Agent event does not match the durable Turn receipt: ${turnId}.`);
  }
}

/**
 * Confirms every AgentHost callback against the durable admission fact. The
 * Turn repository remains the source of truth for the accepted sequence; this
 * projector intentionally writes no second event ledger.
 */
export function createTurnFactProjector(
  repository: Pick<TurnRepository, 'findReceipt'>,
): RequiredAgentEventProjector {
  const assertAssociated = async (context: AgentEventContext): Promise<void> => {
    const receipt = await repository.findReceipt(context.turnId);
    if (
      !receipt ||
      receipt.sessionId !== context.sessionId ||
      receipt.acceptedSequence !== context.turnSequence
    ) {
      throw new TurnFactAssociationError(context.turnId);
    }
  };
  return {
    projectRuntimeEvent: ({ context }) => assertAssociated(context),
    projectHistoryCommitted: (input: {
      readonly context: AgentEventContext;
      readonly change: CommittedHistoryChange;
    }) => assertAssociated(input.context),
  };
}
