import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { sessions } from './sessions.js';

export const canvasDocuments = sqliteTable('local_runtime_canvas_documents', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.sessionId, { onDelete: 'cascade' }),
  canvasId: text('canvas_id').notNull().unique(),
  documentJson: text('document_json').notNull(),
  changeSeq: integer('change_seq').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

export const canvasOperations = sqliteTable(
  'local_runtime_canvas_operations',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    operationId: text('operation_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    appliedChangeSeq: integer('applied_change_seq').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.operationId] }),
    check(
      'local_runtime_canvas_operations_applied_change_seq',
      sql`${table.appliedChangeSeq} >= 1`,
    ),
  ],
);

export const canvasAssetReferences = sqliteTable(
  'local_runtime_canvas_asset_references',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    assetId: text('asset_id').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.nodeId] }),
    index('idx_canvas_asset_references_asset').on(table.sessionId, table.assetId),
  ],
);
