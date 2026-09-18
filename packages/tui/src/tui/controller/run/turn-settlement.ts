import type { TuiSettledTurn } from '../chat-controller-types.js';
import type { TuiTurnOutputRate } from '../projection/turn-output-rate.js';
import type { TuiTurnProjection } from '../projection/turn-projection.js';

export function createTuiSettledTurn(
  sessionId: string | undefined,
  turnId: string,
  status: TuiSettledTurn['status'],
): TuiSettledTurn | undefined {
  return sessionId ? { sessionId, turnId, status } : undefined;
}

export function settleTuiRuntimeTurnProjection(
  turnProjection: TuiTurnProjection,
  outputRate: TuiTurnOutputRate,
  turnId: string,
  status: TuiSettledTurn['status'],
  durationMs?: number,
): void {
  outputRate.finalize();
  turnProjection.markTurn(
    turnId,
    status,
    durationMs,
    outputRate.current(),
    outputRate.currentEstimated(),
  );
  turnProjection.clearTurn(turnId);
}
