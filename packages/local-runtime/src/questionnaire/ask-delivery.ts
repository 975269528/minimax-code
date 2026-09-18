import type { QuestionnaireRequestRecord } from './store.js';
import type { LocalQuestionnaireServiceDeps } from './contracts.js';

/**
 * Ask fan-out split out of the service class to keep it inside the
 * local-runtime layout budget: publish the global `questionnaire.ask` event
 * and run the best-effort channel delivery hook.
 */
export function emitQuestionnaireAsk(
  deps: Pick<
    LocalQuestionnaireServiceDeps,
    'publishGlobalEvent' | 'onQuestionnaireAsk' | 'emitBusEvent'
  >,
  record: QuestionnaireRequestRecord,
): void {
  deps.publishGlobalEvent?.({
    type: 'questionnaire.ask',
    payload: {
      requestId: record.requestId,
      sessionId: record.sessionId,
      agentName: record.agentName,
      request: record.request,
    },
  });
  void Promise.resolve(deps.onQuestionnaireAsk?.(record)).catch((err) => {
    deps.emitBusEvent('questionnaire.delivery_failed', {
      requestId: record.requestId,
      sessionId: record.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
