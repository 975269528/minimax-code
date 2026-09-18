import { and, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import type { AppDb } from '../../../infra/db/client.js';
import { questionnaireRequests } from '../../../infra/db/schema/questionnaire.js';
import type { PlanQuestionnaireAdmissionReadModel } from './admission.js';

/** Typed, read-only Plan projection over the shared Questionnaire table. */
export function createPlanQuestionnaireAdmissionReadModel(): PlanQuestionnaireAdmissionReadModel {
  const safeMode = sql<string | null>`CASE
    WHEN json_valid(${questionnaireRequests.requestJson}) = 1
    THEN COALESCE(
      json_extract(${questionnaireRequests.requestJson}, '$.mode'),
      CASE
        WHEN json_extract(${questionnaireRequests.requestJson}, '$.purpose')
          IN ('plan_enter_confirmation', 'plan_exit_review')
        THEN 'plan'
        ELSE 'questionnaire'
      END
    )
    ELSE NULL
  END`;
  return {
    hasAnyPendingInTransaction: (db, input) =>
      hasRow(
        db,
        and(
          eq(questionnaireRequests.sessionId, input.sessionId),
          eq(questionnaireRequests.status, 'pending'),
          gte(questionnaireRequests.createdAt, input.createdAtCutoff),
        ),
      ),
    hasIncompletePlanLifecycleInTransaction: (db, input) =>
      hasRow(
        db,
        and(
          eq(questionnaireRequests.sessionId, input.sessionId),
          eq(safeMode, 'plan'),
          input.excludeRequestId
            ? ne(questionnaireRequests.requestId, input.excludeRequestId)
            : undefined,
          isNull(questionnaireRequests.injectedAt),
          or(
            and(
              eq(questionnaireRequests.status, 'pending'),
              gte(questionnaireRequests.createdAt, input.createdAtCutoff),
            ),
            inArray(questionnaireRequests.status, ['answered', 'dismissed']),
          ),
        ),
      ),
  };
}

function hasRow(db: AppDb, predicate: ReturnType<typeof and>): boolean {
  return Boolean(
    db
      .select({ present: sql<number>`1` })
      .from(questionnaireRequests)
      .where(predicate)
      .limit(1)
      .get(),
  );
}
