import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

import { sessions } from './sessions.js';

export const fileApiUploads = sqliteTable(
  'local_runtime_file_api_uploads',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    cacheKey: text('cache_key').notNull(),
    contentHash: text('content_hash').notNull(),
    endpointHash: text('endpoint_hash').notNull(),
    callerIdentityHash: text('caller_identity_hash').notNull(),
    ttlSec: real('ttl_sec').notNull(),
    fileId: text('file_id').notNull(),
    expiresAtMs: integer('expires_at_ms').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.cacheKey] }),
    check('local_runtime_file_api_uploads_ttl_check', sql`${table.ttlSec} >= 0`),
    check('local_runtime_file_api_uploads_file_id_check', sql`length(${table.fileId}) > 0`),
    index('idx_local_runtime_file_api_uploads_session_expiry').on(
      table.sessionId,
      table.expiresAtMs,
    ),
  ],
);
