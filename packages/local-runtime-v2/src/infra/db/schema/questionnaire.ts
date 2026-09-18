import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Read-only mapping of the v1-owned Questionnaire table. The v1 migration
 * remains the sole DDL owner while v2 compatibility adapters use typed Drizzle
 * expressions against the shared database.
 */
export const questionnaireRequests = sqliteTable('questionnaire_requests', {
  requestId: text('request_id').primaryKey(),
  sessionId: text('session_id').notNull(),
  requestJson: text('request_json').notNull(),
  status: text('status').notNull(),
  createdAt: integer('created_at').notNull(),
  injectedAt: integer('injected_at'),
});
