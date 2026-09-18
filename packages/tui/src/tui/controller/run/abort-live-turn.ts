import type { TuiConversationPort, TuiDelegationPort } from '../../../runtime/port.js';
import { isTuiDelegatedSession } from '../../../runtime/delegation.js';
import type { TuiRunProjection } from '../../state/run-projection.js';
import type { TuiChatController } from '../chat-controller.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';

export function createTuiAbortLiveTurn(options: {
  controller: TuiChatController;
  runProjection: TuiRunProjection;
  stopDelegation: TuiDelegationPort['stopDelegation'];
  abortSession: TuiConversationPort['abortSession'];
  getActiveRun(sessionId: string): Promise<{ state: string; turnId?: string }>;
  latestRuntimeTurnId(): string | undefined;
  setTransientHint(message: string | undefined): void;
  updateChrome(): void;
  requestRender(): void;
  append(message: string, kind: 'warning' | 'error'): void;
}): () => Promise<boolean> {
  return async () => {
    const snapshot = options.controller.snapshot();
    const session = snapshot.session;
    const stopDelegatedAgents = async (): Promise<boolean> => {
      if (!session || isTuiDelegatedSession(session)) return false;
      let receipt;
      try {
        receipt = await options.stopDelegation(session.sessionId);
      } catch (error) {
        options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't stop delegated agents.",
            nextStep: 'Retry Esc.',
            preservation: 'They may still be running.',
          }),
          'error',
        );
        return false;
      }
      if (receipt.failedSessionIds.length > 0 || receipt.activeSessionIds.length > 0) {
        options.append(
          `Some delegated agents did not stop cleanly: ${[
            ...receipt.failedSessionIds,
            ...receipt.activeSessionIds,
          ].join(', ')}`,
          'warning',
        );
      }
      return receipt.rootStopped || receipt.stoppedSessionIds.length > 0;
    };
    if (snapshot.activeTurnId) {
      try {
        const stoppingDelegation = stopDelegatedAgents();
        const aborted = await options.controller.abort();
        const delegatedStopped = await stoppingDelegation;
        if (!aborted && !delegatedStopped) {
          options.append('Runtime did not confirm that the active response stopped.', 'warning');
        }
        return delegatedStopped || aborted;
      } finally {
        options.setTransientHint(undefined);
        options.updateChrome();
        options.requestRender();
      }
    }
    const runtimeTurnId = options.latestRuntimeTurnId();
    if (!runtimeTurnId || !snapshot.session?.sessionId) return false;
    const sessionId = snapshot.session.sessionId;
    options.setTransientHint('Stopping the current response. Your draft is preserved.');
    options.runProjection.markRuntimeTurnStopping(runtimeTurnId);
    options.updateChrome();
    options.requestRender();
    try {
      const stoppingDelegation = stopDelegatedAgents();
      const rootStopped = await options.abortSession({
        id: sessionId,
        turnId: runtimeTurnId,
        reason: 'user_stop',
      });
      const delegatedStopped = await stoppingDelegation;
      if (!rootStopped && !delegatedStopped) {
        options.append('Runtime did not confirm that the active response stopped.', 'warning');
      }
      const active = await options.getActiveRun(sessionId).catch(() => undefined);
      if (
        active &&
        (active.state === 'idle' ||
          active.state === 'terminal' ||
          (active.turnId && active.turnId !== runtimeTurnId))
      ) {
        options.runProjection.clearRuntimeTurn(runtimeTurnId);
        options.setTransientHint(undefined);
      }
      options.updateChrome();
      options.requestRender();
      return rootStopped || delegatedStopped;
    } catch (error) {
      options.runProjection.clearRuntimeTurnStopping(runtimeTurnId);
      options.setTransientHint(undefined);
      options.append(
        formatTuiActionFailure(error, {
          summary: "Couldn't stop the current response.",
          nextStep: 'Retry Esc.',
          preservation: 'It may still be running.',
        }),
        'error',
      );
      options.updateChrome();
      options.requestRender();
      return false;
    }
  };
}
