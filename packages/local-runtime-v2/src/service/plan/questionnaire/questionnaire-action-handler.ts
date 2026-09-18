import type {
  QuestionnaireOwnedActionHandler,
  QuestionnaireRequestRecord,
} from '@mavis/local-runtime';
import { createInternalTurnId } from '@mavis/shared/turn-identity';

import type { PlanApplication } from '../contracts.js';

export function createPlanQuestionnaireActionHandler(options: {
  readonly application: PlanApplication;
  readonly dispatchQueue: (sessionId: string) => Promise<void>;
  readonly onDispatchFailure: (sessionId: string) => void;
}): QuestionnaireOwnedActionHandler {
  return {
    handles: (record) => record.request.mode === 'plan',
    route: ({ record, action }) => {
      if (record.request.mode !== 'plan') {
        return Promise.reject(
          new Error(`Plan Questionnaire handler cannot process ${String(record.request.mode)}`),
        );
      }
      return record.request.modePayload?.planReview !== undefined
        ? routePlanReview(options.application, record, action)
        : routePlanEntry(options.application, record, action);
    },
    afterConsumed: async ({ record, dispatch }) => {
      if (dispatch && record.request.mode === 'plan') {
        try {
          await options.dispatchQueue(record.sessionId);
        } catch (error) {
          options.onDispatchFailure(record.sessionId);
          throw error;
        }
      }
    },
  };
}

type RoutedAction = Parameters<QuestionnaireOwnedActionHandler['route']>[0]['action'];
type RouteResult = Awaited<ReturnType<QuestionnaireOwnedActionHandler['route']>>;

async function routePlanEntry(
  application: PlanApplication,
  record: QuestionnaireRequestRecord,
  action: RoutedAction,
): Promise<RouteResult> {
  if (action.kind === 'reply' && selectedOptionId(action.reply) === 'confirm') {
    try {
      await application.confirmEntry({
        sessionId: record.sessionId,
        requestId: record.requestId,
      });
    } catch (error) {
      if (!hasCode(error, 'PLAN_ENTRY_DISABLED')) throw error;
      await application.keepDefault(record.sessionId);
      return { kind: 'handled' };
    }
  } else {
    await application.keepDefault(record.sessionId);
  }
  return action.kind === 'reply'
    ? {
        kind: 'continue-generic',
        continuationIdentity: createInternalTurnId('plan-enter', record.requestId),
      }
    : { kind: 'handled' };
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code;
}

async function routePlanReview(
  application: PlanApplication,
  record: QuestionnaireRequestRecord,
  action: RoutedAction,
): Promise<RouteResult> {
  if (action.kind === 'reply' && hasSkippedAnswer(action.reply)) {
    return { kind: 'handled' };
  }
  if (action.kind === 'reply' && selectedOptionId(action.reply) === 'approve') {
    const planReview = requirePersistedPlanReview(record);
    await application.approve({
      requestId: record.requestId,
      sessionId: record.sessionId,
      markdown: planReview.markdown,
      planPath: planReview.path,
    });
    return { kind: 'handled' };
  }
  if (action.kind === 'dismiss') {
    await application.keepDefault(record.sessionId);
    return { kind: 'handled' };
  }
  return {
    kind: 'continue-generic',
    continuationIdentity: createInternalTurnId('plan-review-feedback', record.requestId),
  };
}

function hasSkippedAnswer(reply: {
  readonly answers: readonly {
    readonly skipped?: boolean;
  }[];
}): boolean {
  return reply.answers.some((answer) => answer.skipped === true);
}

function selectedOptionId(reply: {
  readonly answers: readonly {
    readonly selectedOptionIds: readonly string[];
  }[];
}): string | undefined {
  return reply.answers[0]?.selectedOptionIds[0];
}

function requirePersistedPlanReview(record: QuestionnaireRequestRecord): {
  readonly markdown: string;
  readonly path: string;
} {
  const planReview = record.request.modePayload?.planReview;
  if (!planReview?.markdown.trim()) {
    throw new Error(`Persisted Plan review Markdown is missing for ${record.requestId}`);
  }
  if (typeof planReview.path !== 'string' || !planReview.path.trim()) {
    throw new Error(`Persisted Plan review path is missing for ${record.requestId}`);
  }
  return planReview;
}
