import { desc } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable query-level disclosure state; execution ownership stays in TurnSystem. */
export const queryCollapseViewStates = sqliteTable(
  'local_runtime_query_view_states',
  {
    sessionId: text('session_id').notNull(),
    queryKey: text('query_key').notNull(),
    currentTurnId: text('current_turn_id').notNull(),
    forceExpanded: integer('force_expanded').notNull().default(0),
    processingStartedAtMs: integer('processing_started_at_ms').notNull(),
    processingFinishedAtMs: integer('processing_finished_at_ms'),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.queryKey] }),
    index('idx_local_runtime_query_view_states_session').on(
      table.sessionId,
      table.updatedAtMs,
      table.queryKey,
    ),
    index('idx_local_runtime_query_view_states_current_turn').on(
      table.sessionId,
      table.currentTurnId,
      desc(table.updatedAtMs),
      desc(table.queryKey),
    ),
  ],
);
