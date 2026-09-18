import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import { messageRows } from './messages.js';
import { sessions } from './sessions.js';

export const sessionResources = sqliteTable(
  'session_resources',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    resourceIndex: integer('resource_index').notNull(),
    resourceType: text('resource_type').notNull(),
    sourceId: text('source_id').notNull(),
    resourceKey: text('resource_key').notNull(),
    resourceDataJson: text('resource_data_json').notNull(),
    resourceDataVersion: integer('resource_data_version').notNull().default(1),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.resourceIndex] }),
    check('session_resources_index_check', sql`${table.resourceIndex} > 0`),
    check(
      'session_resources_type_check',
      sql`${table.resourceType} IN ('web', 'mcp', 'app', 'file')`,
    ),
    check(
      'session_resources_source_id_check',
      sql`${table.sourceId} = ${table.resourceType} || ':' || CAST(${table.resourceIndex} AS TEXT)`,
    ),
    check('session_resources_data_json_check', sql`json_valid(${table.resourceDataJson})`),
    check('session_resources_data_version_check', sql`${table.resourceDataVersion} > 0`),
    check('session_resources_created_at_check', sql`${table.createdAtMs} >= 0`),
    check('session_resources_updated_at_check', sql`${table.updatedAtMs} >= 0`),
    uniqueIndex('idx_session_resources_source_id').on(table.sessionId, table.sourceId),
    uniqueIndex('idx_session_resources_identity').on(
      table.sessionId,
      table.resourceType,
      table.resourceKey,
    ),
  ],
);

export const sessionTurnResources = sqliteTable(
  'session_turn_resources',
  {
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    messageId: text('msg_id').notNull(),
    resourceIndex: integer('resource_index').notNull(),
    resourceOrdinal: integer('resource_ordinal').notNull(),
    toolCallId: text('tool_call_id'),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.messageId, table.resourceOrdinal] }),
    check('session_turn_resources_ordinal_check', sql`${table.resourceOrdinal} >= 0`),
    check('session_turn_resources_created_at_check', sql`${table.createdAtMs} >= 0`),
    foreignKey({
      columns: [table.sessionId, table.resourceIndex],
      foreignColumns: [sessionResources.sessionId, sessionResources.resourceIndex],
      name: 'session_turn_resources_resource_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.sessionId, table.messageId],
      foreignColumns: [messageRows.sessionId, messageRows.messageId],
      name: 'session_turn_resources_message_fk',
    }).onDelete('cascade'),
    index('idx_session_turn_resources_tool_call').on(
      table.sessionId,
      table.messageId,
      table.toolCallId,
    ),
    index('idx_session_turn_resources_turn').on(
      table.sessionId,
      table.turnId,
      table.resourceOrdinal,
    ),
    index('idx_session_turn_resources_resource').on(
      table.sessionId,
      table.resourceIndex,
      table.messageId,
      table.resourceOrdinal,
    ),
  ],
);
