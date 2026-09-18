import type { SessionSystemCanonicalHistoryProvider } from '../../session-system/index.js';
import { inspectContinuationHistory } from '../agent-host/history/continuation-history.js';
import type {
  ContinueTurnInput,
  ContinueTurnResult,
  InspectTurnContinuationResult,
} from '../contracts.js';
import type { TurnExecutionService } from './contracts.js';

export interface TurnContinuationService {
  inspect(sessionId: string): Promise<InspectTurnContinuationResult>;
  continueTurn(input: ContinueTurnInput): Promise<ContinueTurnResult>;
}

interface TurnContinuationServiceOptions {
  readonly history: Pick<SessionSystemCanonicalHistoryProvider, 'inspectActive'>;
  readonly execution: Pick<TurnExecutionService, 'activeTurnId' | 'submit'>;
}

export function createTurnContinuationService(
  options: TurnContinuationServiceOptions,
): TurnContinuationService {
  const inspect = async (sessionId: string): Promise<InspectTurnContinuationResult> => {
    if (options.execution.activeTurnId(sessionId)) return { state: 'running' };
    const history = await options.history.inspectActive(sessionId);
    return { state: inspectContinuationHistory(history.messages) };
  };

  return {
    inspect,
    continueTurn: async (input) => {
      const inspection = await inspect(input.sessionId);
      if (inspection.state === 'running') return { accepted: false, reason: 'active-turn' };
      if (inspection.state !== 'available') {
        return { accepted: false, reason: inspection.state };
      }
      return options.execution.submit({
        sessionId: input.sessionId,
        input: { text: '' },
        genuineUserQueryText: '',
        provenance: {
          source: 'turn-continuation',
          routingFingerprint: `turn-continuation:${input.sessionId}`,
        },
        clientIntent: 'turn-continuation',
        admissionPriority: { kind: 'turn-continuation' },
        executionMode: 'continuation',
        ...(input.onAccepted
          ? {
              preDelivery: {
                accept: ({ turnId }) => input.onAccepted?.({ turnId }),
              },
            }
          : {}),
      });
    },
  };
}
