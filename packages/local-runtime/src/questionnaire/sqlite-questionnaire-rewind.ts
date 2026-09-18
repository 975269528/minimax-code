import { type DatabaseLike, runInImmediateTransaction } from '../persistence/db.js';
import {
  QUESTIONNAIRE_ROW_SELECT,
  type QuestionnaireRequestRow,
  toCompatibleQuestionnaireRequestRecord,
} from './sqlite-row-codec.js';
import type { QuestionnaireRequestRecord } from './store.js';

const UNRESOLVED_PREDICATE = `
  status = 'pending'
  OR (status = 'answered' AND injected_at IS NULL)
`;

export function findUnresolvedQuestionnairesForRewind(
  db: DatabaseLike,
  sessionId: string,
): QuestionnaireRequestRecord[] {
  const rows = db
    .prepare(
      `SELECT ${QUESTIONNAIRE_ROW_SELECT}
       FROM questionnaire_requests
       WHERE session_id = ? AND (${UNRESOLVED_PREDICATE})
       ORDER BY created_at ASC, request_id ASC`,
    )
    .all(sessionId) as QuestionnaireRequestRow[];
  return rows.map(toCompatibleQuestionnaireRequestRecord);
}

export function deleteUnresolvedQuestionnairesForRewind(
  db: DatabaseLike,
  input: { readonly sessionId: string; readonly requestIds: readonly string[] },
): QuestionnaireRequestRecord[] {
  return runInImmediateTransaction(db, () => {
    const read = db.prepare(
      `SELECT ${QUESTIONNAIRE_ROW_SELECT}
       FROM questionnaire_requests
       WHERE request_id = ? AND session_id = ? AND (${UNRESOLVED_PREDICATE})`,
    );
    const remove = db.prepare(
      `DELETE FROM questionnaire_requests
       WHERE request_id = ? AND session_id = ? AND (${UNRESOLVED_PREDICATE})`,
    );
    return input.requestIds.flatMap((requestId) => {
      const row = read.get(requestId, input.sessionId) as QuestionnaireRequestRow | undefined;
      if (!row) return [];
      const deleted = remove.run(requestId, input.sessionId) as { changes?: number };
      return Number(deleted.changes ?? 0) > 0 ? [toCompatibleQuestionnaireRequestRecord(row)] : [];
    });
  });
}
