import type { Migration } from '../persistence/db.js';

export const QUESTIONNAIRE_MIGRATIONS: Migration[] = [
  {
    version: 21,
    sql: `
      CREATE TABLE IF NOT EXISTS questionnaire_requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_name TEXT,
        msg_id TEXT,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        answered_at INTEGER,
        reply_payload TEXT,
        injected_at INTEGER,
        dismissed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_questionnaire_requests_session_status_created
        ON questionnaire_requests(session_id, status, created_at, request_id);
      CREATE INDEX IF NOT EXISTS idx_questionnaire_requests_answered_injected
        ON questionnaire_requests(status, answered_at, injected_at);
    `,
  },
  {
    version: 22,
    sql: `
      ALTER TABLE questionnaire_requests ADD COLUMN origin_channel_context_json TEXT;
    `,
  },
];
