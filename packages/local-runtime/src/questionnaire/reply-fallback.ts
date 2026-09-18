import {
  ConversationTurnRejectedError,
  type ConversationMessageInput,
  type RuntimeConversation,
} from '@mavis/conversation-contract';

import { isOwnedQuestionnaireRequest } from './owned-action-lifecycle.js';
import type { QuestionnaireRequestRecord } from './store.js';

/**
 * Only ordinary ask_user replies degrade when the Turn resumed without
 * consuming the questionnaire (post-steer race). Goal, plan and consent modes
 * keep their loud failure semantics and owner-driven recovery.
 */
export function canQueueReplyBehindActiveTurn(
  record: QuestionnaireRequestRecord,
  err: unknown,
): boolean {
  return (
    err instanceof ConversationTurnRejectedError &&
    err.reason === 'active-turn' &&
    record.request.mode === 'questionnaire' &&
    record.request.purpose !== 'goal'
  );
}

/**
 * The answer is already persisted, so it must not bounce: degrade to a durable
 * front-of-queue message. The message carries the questionnaire-response
 * origin, which lets it pass the unresolved-questionnaire admission gates that
 * park every other item; a duplicate rejection means an earlier attempt
 * already queued this reply, so it counts as delivered.
 */
export async function queueReplyBehindActiveTurn(
  conversation: Pick<RuntimeConversation, 'ingress'>,
  record: QuestionnaireRequestRecord,
  message: ConversationMessageInput,
): Promise<{ completed: boolean; admissionMode: 'duplicate' | 'queued' }> {
  try {
    await conversation.ingress.submit({
      sessionId: record.sessionId,
      source: 'questionnaire',
      allowQueue: true,
      queuePlacement: 'front',
      clientRequestId: `questionnaire-reply:${record.requestId}`,
      dedupeKey: `questionnaire-reply:${record.requestId}`,
      message,
    });
  } catch (err) {
    if (err instanceof ConversationTurnRejectedError && err.reason === 'duplicate') {
      return { completed: true, admissionMode: 'duplicate' };
    }
    throw err;
  }
  return { completed: true, admissionMode: 'queued' };
}

/**
 * An answered ordinary questionnaire whose reply never reached the Turn keeps
 * the unresolved-questionnaire admission gates raised. Dismiss is the manual
 * escape hatch that finalizes such a stranded row; goal and owned rows stay
 * excluded because their answered state is completed by their own recovery.
 */
export function isStrandedAnsweredReply(record: QuestionnaireRequestRecord): boolean {
  return (
    record.status === 'answered' &&
    !record.injectedAt &&
    record.request.purpose !== 'goal' &&
    !isOwnedQuestionnaireRequest(record.request)
  );
}
