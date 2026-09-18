import type { TuiRunCoordinator } from '../../../application/run-coordinator.js';
import type { TuiChatSnapshot, TuiSettledTurn } from '../chat-controller-types.js';
import type { TuiActiveTurn } from '../chat-controller-support.js';
import { monitorTuiRuntimeRetirement } from '../runtime/runtime-retirement-monitor.js';

interface AbortTuiChatTurnOptions {
  readonly activeTurn?: TuiActiveTurn;
  readonly coordinator: TuiRunCoordinator;
  readonly resultDeliveryEnabled: boolean;
  readonly retirementWarningTimeoutMs: number;
  readonly invalidateSessionCreation: () => void;
  readonly markCancelled: (turnId: string) => void;
  readonly settledTurn: (turnId: string, status: 'cancelled') => TuiSettledTurn | undefined;
  readonly isCurrent: (turn: TuiActiveTurn) => boolean;
  readonly clearCurrent: (turn: TuiActiveTurn) => void;
  readonly apply: (patch: Partial<TuiChatSnapshot>) => void;
  readonly currentRetiringTurnId: () => string | undefined;
  readonly resolveIdleWaiters: () => void;
}

export async function abortTuiChatTurn(options: AbortTuiChatTurnOptions): Promise<boolean> {
  const activeTurn = options.activeTurn;
  if (!activeTurn) return false;
  if (activeTurn.abortPromise) return activeTurn.abortPromise;

  activeTurn.cancelling = true;
  activeTurn.sessionDeliveryAbort.abort();
  options.invalidateSessionCreation();
  options.markCancelled(activeTurn.id);
  options.apply({ cancelling: true, error: undefined });
  activeTurn.abortPromise = options.coordinator.abort().then((aborted) => {
    const retiringTurnId = options.coordinator.retiringTurnId();
    const retirement = options.coordinator.retirement();
    const resultDeliveryPending = Boolean(
      options.resultDeliveryEnabled && retiringTurnId && retirement,
    );
    if (options.isCurrent(activeTurn)) {
      options.clearCurrent(activeTurn);
      options.apply({
        status: 'idle',
        activeTurnId: undefined,
        cancelling: false,
        retiringTurnId,
        error: undefined,
        lastSettledTurn: resultDeliveryPending
          ? undefined
          : options.settledTurn(activeTurn.id, 'cancelled'),
      });
    }
    if (retiringTurnId && retirement) {
      monitorTuiRuntimeRetirement({
        turnId: retiringTurnId,
        retirement,
        timeoutMs: options.retirementWarningTimeoutMs,
        currentTurnId: options.currentRetiringTurnId,
        apply: options.apply,
        onSettled: () => {
          if (resultDeliveryPending) {
            options.apply({
              lastSettledTurn: options.settledTurn(activeTurn.id, 'cancelled'),
            });
          }
          options.resolveIdleWaiters();
        },
      });
    }
    if (!retiringTurnId) options.resolveIdleWaiters();
    return aborted;
  });
  return activeTurn.abortPromise;
}
