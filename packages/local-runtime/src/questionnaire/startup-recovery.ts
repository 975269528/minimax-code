import { QUESTIONNAIRE_TTL_MS } from '@mavis/shared/questionnaire';

import type { LocalQuestionnaireServiceDeps, QuestionnaireRecoveryStats } from './contracts.js';
import { emitQuestionnaireAsk } from './ask-delivery.js';
import type { QuestionnaireRequestRecord } from './store.js';

interface StartupInjectReplyResult {
  completed: boolean;
  admissionMode?: 'started' | 'duplicate' | 'queued';
  status?: number;
  error?: string;
}

/**
 * Startup recovery for ordinary Questionnaire rows, split out of the service
 * so the class stays inside the local-runtime layout budget. Owned action
 * recovery is owner-managed after its dependencies are ready; this path keeps
 * ordinary reply injection and pending replay independent from owner failures.
 */
export async function recoverQuestionnairesOnStartup(input: {
  readonly deps: LocalQuestionnaireServiceDeps;
  readonly injectReply: (
    record: QuestionnaireRequestRecord,
    reply: NonNullable<QuestionnaireRequestRecord['replyPayload']>,
  ) => Promise<StartupInjectReplyResult>;
  readonly wakeQueueAfterDuplicateResume: (record: QuestionnaireRequestRecord) => Promise<void>;
  readonly ttlMs?: number;
}): Promise<QuestionnaireRecoveryStats> {
  const { deps } = input;
  const ttlMs = input.ttlMs ?? QUESTIONNAIRE_TTL_MS;
  const expired = await deps.store.expirePendingOlderThan(deps.nowMs() - ttlMs);
  let reinjected = 0;
  for (const record of await deps.store.findAnsweredPendingInject()) {
    if (!record.replyPayload || record.request.purpose === 'goal') continue;
    try {
      const result = await input.injectReply(record, record.replyPayload);
      if (result.completed) {
        await deps.store.markInjected(record.requestId, deps.nowMs());
        if (result.admissionMode === 'duplicate') {
          await input.wakeQueueAfterDuplicateResume(record);
        }
        reinjected += 1;
      } else {
        deps.emitBusEvent('questionnaire.recovery_inject_failed', {
          requestId: record.requestId,
          sessionId: record.sessionId,
          ...(result.status !== undefined ? { status: result.status } : {}),
          ...(result.error ? { error: result.error } : {}),
        });
      }
    } catch (err) {
      deps.emitBusEvent('questionnaire.recovery_inject_failed', {
        requestId: record.requestId,
        sessionId: record.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  let reemitted = 0;
  const pendingForRecovery = await deps.store.findAllPendingForRecovery();
  for (const record of [...pendingForRecovery].reverse()) {
    emitQuestionnaireAsk(deps, record);
    reemitted += 1;
  }
  return { expired, reinjected, reemitted };
}
