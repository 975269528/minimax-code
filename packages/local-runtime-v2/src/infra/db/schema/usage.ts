import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const tokenUsage = sqliteTable(
  'local_runtime_token_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    agentName: text('agent_name').notNull(),
    frameworkType: text('framework_type').notNull(),
    turnId: text('turn_id'),
    model: text('model'),
    timestamp: integer('ts').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    reasoningTokens: integer('reasoning_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    cacheWriteTokens: integer('cache_write_tokens').notNull(),
    costUsd: real('cost_usd'),
    raw: text('raw'),
  },
  (table) => [
    index('idx_local_runtime_token_usage_session_ts').on(
      table.sessionId,
      table.timestamp,
      table.id,
    ),
    index('idx_local_runtime_token_usage_agent_ts').on(table.agentName, table.timestamp, table.id),
    index('idx_local_runtime_token_usage_ts').on(table.timestamp, table.id),
    index('idx_local_runtime_token_usage_model_ts').on(table.model, table.timestamp, table.id),
    index('idx_local_runtime_token_usage_day_ts').on(
      sql`CAST(${table.timestamp} / 86400000 AS INTEGER)`,
      table.timestamp,
      table.id,
    ),
  ],
);
