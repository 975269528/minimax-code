import {
  writeQueryCollapseView,
  type QueryCollapseState,
  type SessionFrame,
  type SessionStreamService,
} from '../../service/session-system/index.js';
import type {
  AgentHostTurnOutcome,
  ContinueTurnResult,
  TurnService,
} from '../../service/turn-system/index.js';

const continuationObservations = new WeakSet<Promise<void>>();

interface TurnContinuationDeliveryServiceOptions {
  readonly turns: Pick<TurnService, 'continueTurn'>;
  readonly stream: Pick<SessionStreamService, 'reserve' | 'write'>;
  readonly queryCollapse: {
    readonly resolve: (sessionId: string, turnId: string) => Promise<string>;
    readonly start: QueryCollapseState['start'];
  };
}

export type TurnContinuationDeliveryResult =
  | {
      readonly accepted: true;
      readonly turnId: string;
      readonly completion: Promise<AgentHostTurnOutcome>;
      readonly frames: AsyncIterableIterator<SessionFrame>;
    }
  | Exclude<ContinueTurnResult, { readonly accepted: true }>;

export interface TurnContinuationDelivery {
  open(sessionId: string): Promise<TurnContinuationDeliveryResult>;
}

export class TurnContinuationDeliveryService implements TurnContinuationDelivery {
  constructor(private readonly options: TurnContinuationDeliveryServiceOptions) {}

  async open(sessionId: string): Promise<TurnContinuationDeliveryResult> {
    const reservation = this.options.stream.reserve(sessionId);
    try {
      const result = await this.options.turns.continueTurn({
        sessionId,
        onAccepted: async ({ turnId }) => {
          reservation.bindTurn(turnId);
          await startContinuationQuery(this.options, sessionId, turnId);
        },
      });
      if (!result.accepted) {
        reservation.discardIfEmpty();
        return result;
      }
      continuationObservations.add(
        completeAfterSettlement(result.completion, reservation.complete),
      );
      return {
        accepted: true,
        turnId: result.turnId,
        completion: result.completion,
        frames: reservation.source,
      };
    } catch (error) {
      reservation.discardIfEmpty();
      throw error;
    }
  }
}

async function startContinuationQuery(
  options: TurnContinuationDeliveryServiceOptions,
  sessionId: string,
  turnId: string,
): Promise<void> {
  try {
    const queryKey = await options.queryCollapse.resolve(sessionId, turnId);
    const state = await options.queryCollapse.start({
      sessionId,
      queryKey,
      currentTurnId: turnId,
    });
    writeQueryCollapseView(options.stream, state);
  } catch {
    // Query collapse is an optional display sidecar and cannot reject continuation admission.
  }
}

async function completeAfterSettlement(
  completion: Promise<unknown>,
  complete: () => void,
): Promise<void> {
  try {
    await completion;
  } finally {
    complete();
  }
}
