import { LocalQuestionnaireService, type LocalQuestionnaireServiceDeps } from './service.js';

export interface LocalQuestionnaireRecoveryHost {
  questionnaireServiceDeps(): LocalQuestionnaireServiceDeps;
  emitBusEvent(type: string, payload: Record<string, unknown>): void;
}

export function startQuestionnaireRecovery(
  host: LocalQuestionnaireRecoveryHost,
  channelRestoreReady?: Promise<void>,
): void {
  void (channelRestoreReady ?? Promise.resolve())
    .then(() => new LocalQuestionnaireService(host.questionnaireServiceDeps()).recoverOnStartup())
    .then((stats) => {
      if (stats.expired > 0 || stats.reinjected > 0 || stats.reemitted > 0) {
        host.emitBusEvent('questionnaire.recovery', { ...stats });
      }
    })
    .catch((err: unknown) => {
      host.emitBusEvent('questionnaire.recovery_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
