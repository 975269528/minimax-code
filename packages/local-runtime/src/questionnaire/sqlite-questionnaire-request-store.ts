import type { AskQuestionnaireReplyPayload } from '@mavis/shared/questionnaire';

import {
  type DataDirInput,
  type DatabaseLike,
  runInImmediateTransaction,
  withLocalRuntimeDb,
} from '../persistence/db.js';
import {
  isOwnedActionRequestJson,
  parseQuestionnaireOriginChannelContext,
} from './sqlite-row-codec.js';
import { SqliteQuestionnaireRequestQueries } from './sqlite-questionnaire-request-queries.js';
import type {
  BeginPendingWithPolicyResult,
  QuestionnaireRequestRecord,
  QuestionnaireRequestStore,
  ReplacePendingForActiveGoalResult,
} from './store.js';
import {
  deleteUnresolvedQuestionnairesForRewind,
  findUnresolvedQuestionnairesForRewind,
} from './sqlite-questionnaire-rewind.js';

export class SqliteQuestionnaireRequestStore implements QuestionnaireRequestStore {
  private readonly queries: SqliteQuestionnaireRequestQueries;

  constructor(private readonly dataDir: DataDirInput) {
    this.queries = new SqliteQuestionnaireRequestQueries(dataDir);
  }

  async upsert(record: QuestionnaireRequestRecord): Promise<void> {
    this.withDb((db) => this.writeRecord(db, record));
  }

  async beginPendingWithPolicy(input: {
    record: QuestionnaireRequestRecord;
    policy: 'replaceable' | 'exclusive';
    createdAtCutoff: number;
  }): Promise<BeginPendingWithPolicyResult> {
    return this.withDb((db) =>
      runInImmediateTransaction(db, () => {
        const pending = db
          .prepare(
            `
            SELECT request_id, request_json
            FROM questionnaire_requests
            WHERE session_id = ?
              AND status = 'pending'
              AND created_at >= ?
            ORDER BY created_at ASC, request_id ASC
          `,
          )
          .all(input.record.sessionId, input.createdAtCutoff) as Array<{
          request_id?: string;
          request_json?: string;
        }>;
        if (
          input.policy === 'exclusive'
            ? pending.length > 0
            : pending.some((row) => isOwnedActionRequestJson(row.request_json))
        ) {
          return { status: 'pending-conflict' };
        }
        const supersededRequestIds: string[] = [];
        if (input.policy === 'replaceable') {
          const supersede = db.prepare(
            `
            UPDATE questionnaire_requests
            SET status = 'superseded'
            WHERE request_id = ? AND status = 'pending'
          `,
          );
          for (const row of pending) {
            if (!row.request_id) continue;
            const result = supersede.run(row.request_id) as { changes?: number };
            if (Number(result.changes ?? 0) > 0) supersededRequestIds.push(row.request_id);
          }
        }
        this.writeRecord(db, input.record);
        return { status: 'created', supersededRequestIds };
      }),
    );
  }

  private writeRecord(db: DatabaseLike, record: QuestionnaireRequestRecord): void {
    const originChannelContext = record.originChannelContext
      ? parseQuestionnaireOriginChannelContext(JSON.stringify(record.originChannelContext))
      : undefined;
    db.prepare(
      `
        INSERT INTO questionnaire_requests (
          request_id, session_id, agent_name, msg_id, request_json, status,
          created_at, answered_at, reply_payload, injected_at, dismissed_at,
          origin_channel_context_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET
          session_id    = excluded.session_id,
          agent_name    = excluded.agent_name,
          msg_id        = excluded.msg_id,
          origin_channel_context_json = excluded.origin_channel_context_json,
          request_json  = excluded.request_json,
          status        = excluded.status,
          created_at    = excluded.created_at,
          answered_at   = excluded.answered_at,
          reply_payload = excluded.reply_payload,
          injected_at   = excluded.injected_at,
          dismissed_at  = excluded.dismissed_at
      `,
    ).run(
      record.requestId,
      record.sessionId,
      record.agentName ?? null,
      record.msgId ?? null,
      JSON.stringify(record.request),
      record.status,
      record.createdAt,
      record.answeredAt ?? null,
      record.replyPayload ? JSON.stringify(record.replyPayload) : null,
      record.injectedAt ?? null,
      record.dismissedAt ?? null,
      originChannelContext ? JSON.stringify(originChannelContext) : null,
    );
  }

  async replacePendingForActiveGoal(
    record: QuestionnaireRequestRecord,
    goalId: string,
  ): Promise<ReplacePendingForActiveGoalResult> {
    return this.withDb((db) =>
      runInImmediateTransaction(db, () => {
        const activeGoal = db
          .prepare(
            `
            SELECT 1
            FROM local_runtime_thread_goals
            WHERE session_id = ?
              AND goal_id = ?
              AND status = 'active'
            LIMIT 1
          `,
          )
          .get(record.sessionId, goalId);
        if (!activeGoal) return { inserted: false, supersededRequestIds: [] };

        this.writeRecord(db, record);
        const rows = db
          .prepare(
            `
            SELECT request_id
            FROM questionnaire_requests
            WHERE session_id = ?
              AND status = 'pending'
              AND request_id != ?
          `,
          )
          .all(record.sessionId, record.requestId) as Array<{ request_id?: string }>;
        db.prepare(
          `
          UPDATE questionnaire_requests
          SET status = 'superseded'
          WHERE session_id = ?
            AND status = 'pending'
            AND request_id != ?
        `,
        ).run(record.sessionId, record.requestId);
        return {
          inserted: true,
          supersededRequestIds: rows.flatMap((row) => (row.request_id ? [row.request_id] : [])),
        };
      }),
    );
  }

  async get(requestId: string): Promise<QuestionnaireRequestRecord | null> {
    return this.queries.get(requestId);
  }

  async delete(requestId: string): Promise<boolean> {
    return this.withDb((db) => {
      const result = db
        .prepare('DELETE FROM questionnaire_requests WHERE request_id = ?')
        .run(requestId) as { changes?: number };
      return Number(result.changes ?? 0) > 0;
    });
  }

  async getAll(): Promise<QuestionnaireRequestRecord[]> {
    return this.queries.getAll();
  }

  async deleteBySession(sessionId: string): Promise<number> {
    return this.withDb((db) => {
      const result = db
        .prepare('DELETE FROM questionnaire_requests WHERE session_id = ?')
        .run(sessionId) as { changes?: number };
      return Number(result.changes ?? 0);
    });
  }

  async markAnswered(
    requestId: string,
    answeredAt: number,
    replyPayload?: AskQuestionnaireReplyPayload,
  ): Promise<boolean> {
    if (!replyPayload) {
      return this.withDb((db) => {
        const result = db
          .prepare(
            `
            UPDATE questionnaire_requests
            SET status = 'answered',
                answered_at = ?
            WHERE request_id = ?
          `,
          )
          .run(answeredAt, requestId) as { changes?: number };
        return Number(result.changes ?? 0) > 0;
      });
    }
    return this.settleReply(requestId, answeredAt, replyPayload, {
      requirePending: false,
    });
  }

  async settleReply(
    requestId: string,
    answeredAt: number,
    replyPayload: AskQuestionnaireReplyPayload,
    options: { readonly requirePending: boolean },
  ): Promise<boolean> {
    return this.withDb((db) => {
      // Persist the reply payload in the same state transition. If the
      // process dies before synthetic message injection, startup recovery can
      // rebuild the exact `<questionnaire-response>` message from this row.
      const result = db
        .prepare(
          `
          UPDATE questionnaire_requests
          SET status = 'answered',
              answered_at = ?,
              reply_payload = ?
          WHERE request_id = ?
            ${options.requirePending ? "AND status = 'pending'" : ''}
        `,
        )
        .run(answeredAt, JSON.stringify(replyPayload), requestId) as {
        changes?: number;
      };
      return Number(result.changes ?? 0) > 0;
    });
  }

  async markAnsweredForActiveGoal(
    requestId: string,
    sessionId: string,
    goalId: string,
    answeredAt: number,
    replyPayload?: AskQuestionnaireReplyPayload,
  ): Promise<boolean> {
    return this.withDb((db) => {
      const result = db
        .prepare(
          `
          UPDATE questionnaire_requests
          SET status = 'answered',
              answered_at = ?,
              reply_payload = COALESCE(?, reply_payload)
          WHERE request_id = ?
            AND session_id = ?
            AND status = 'pending'
            AND request_id = (
              SELECT latest.request_id
              FROM questionnaire_requests latest
              WHERE latest.session_id = ?
                AND latest.status = 'pending'
              ORDER BY latest.created_at DESC, latest.rowid DESC
              LIMIT 1
            )
            AND EXISTS (
              SELECT 1
              FROM local_runtime_thread_goals goal
              WHERE goal.session_id = ?
                AND goal.goal_id = ?
                AND goal.status = 'active'
            )
        `,
        )
        .run(
          answeredAt,
          replyPayload ? JSON.stringify(replyPayload) : null,
          requestId,
          sessionId,
          sessionId,
          sessionId,
          goalId,
        ) as { changes?: number };
      return Number(result.changes ?? 0) > 0;
    });
  }

  async markInjected(requestId: string, injectedAt: number): Promise<boolean> {
    return this.withDb((db) => {
      const result = db
        .prepare('UPDATE questionnaire_requests SET injected_at = ? WHERE request_id = ?')
        .run(injectedAt, requestId) as { changes?: number };
      return Number(result.changes ?? 0) > 0;
    });
  }

  async markDismissed(requestId: string, dismissedAt: number): Promise<boolean> {
    return this.withDb((db) => {
      const result = db
        .prepare(
          `
          UPDATE questionnaire_requests
          SET status = 'dismissed',
              dismissed_at = ?
          WHERE request_id = ?
            AND (
              status = 'pending'
              OR (status = 'answered' AND injected_at IS NULL)
            )
        `,
        )
        .run(dismissedAt, requestId) as { changes?: number };
      return Number(result.changes ?? 0) > 0;
    });
  }

  async expirePendingRequest(requestId: string, cutoff: number): Promise<boolean> {
    return this.withDb((db) => {
      const result = db
        .prepare(
          `
          UPDATE questionnaire_requests
          SET status = 'expired'
          WHERE request_id = ?
            AND status = 'pending'
            AND created_at < ?
        `,
        )
        .run(requestId, cutoff) as { changes?: number };
      return Number(result.changes ?? 0) > 0;
    });
  }

  async markSuperseded(requestId: string): Promise<boolean> {
    return this.withDb((db) => {
      const result = db
        .prepare(
          `
          UPDATE questionnaire_requests
          SET status = 'superseded'
          WHERE request_id = ?
            AND (
              status = 'pending'
              OR (status = 'answered' AND injected_at IS NULL)
            )
        `,
        )
        .run(requestId) as { changes?: number };
      return Number(result.changes ?? 0) > 0;
    });
  }

  async supersedePendingBySession(sessionId: string, keepRequestId: string): Promise<string[]> {
    return this.withDb((db) =>
      runInImmediateTransaction(db, () => {
        const rows = db
          .prepare(
            `
            SELECT request_id
            FROM questionnaire_requests
            WHERE session_id = ?
              AND status = 'pending'
              AND request_id != ?
          `,
          )
          .all(sessionId, keepRequestId) as Array<{ request_id?: string }>;
        if (rows.length === 0) return [];
        db.prepare(
          `
          UPDATE questionnaire_requests
          SET status = 'superseded'
          WHERE session_id = ?
            AND status = 'pending'
            AND request_id != ?
        `,
        ).run(sessionId, keepRequestId);
        return rows.flatMap((row) => (row.request_id ? [row.request_id] : []));
      }),
    );
  }

  async expirePendingOlderThan(cutoff: number): Promise<number> {
    return this.withDb((db) => {
      const result = db
        .prepare(
          `
          UPDATE questionnaire_requests
          SET status = 'expired'
          WHERE status = 'pending'
            AND created_at < ?
            AND CASE
              WHEN json_valid(request_json)
                THEN COALESCE(json_extract(request_json, '$.purpose'), '') != 'goal'
              ELSE 1
            END
        `,
        )
        .run(cutoff) as { changes?: number };
      return Number(result.changes ?? 0);
    });
  }

  async findAllPendingForRecovery(): Promise<QuestionnaireRequestRecord[]> {
    return this.queries.findAllPendingForRecovery();
  }

  async findAnsweredPendingInject(): Promise<QuestionnaireRequestRecord[]> {
    return this.queries.findAnsweredPendingInject();
  }

  async findOwnedActionsPendingCompletion(): Promise<QuestionnaireRequestRecord[]> {
    return this.queries.findOwnedActionsPendingCompletion();
  }

  async findLatestPendingBySession(
    sessionId: string,
    createdAtCutoff = Number.MIN_SAFE_INTEGER,
  ): Promise<QuestionnaireRequestRecord | null> {
    return this.queries.findLatestPendingBySession(sessionId, createdAtCutoff);
  }

  async findLatestBySession(sessionId: string): Promise<QuestionnaireRequestRecord | null> {
    return this.queries.findLatestBySession(sessionId);
  }

  async findLatestPlanReviewBySession(
    sessionId: string,
    createdAtCutoff = Number.MIN_SAFE_INTEGER,
  ): Promise<QuestionnaireRequestRecord | null> {
    return this.queries.findLatestPlanReviewBySession(sessionId, createdAtCutoff);
  }

  async findUnresolvedForRewind(sessionId: string): Promise<QuestionnaireRequestRecord[]> {
    return this.withDb((db) => findUnresolvedQuestionnairesForRewind(db, sessionId));
  }

  async deleteUnresolvedForRewind(input: {
    sessionId: string;
    requestIds: readonly string[];
  }): Promise<QuestionnaireRequestRecord[]> {
    if (input.requestIds.length === 0) return [];
    return this.withDb((db) => deleteUnresolvedQuestionnairesForRewind(db, input));
  }

  async hasUnresolvedBySession(sessionId: string): Promise<boolean> {
    return this.queries.hasUnresolvedBySession(sessionId);
  }

  private withDb<T>(fn: (db: DatabaseLike) => T): T {
    return withLocalRuntimeDb(this.dataDir, fn);
  }
}
