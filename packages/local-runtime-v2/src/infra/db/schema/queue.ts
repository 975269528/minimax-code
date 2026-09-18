import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const legacyQueues = sqliteTable('local_runtime_queues', {
  sessionId: text('session_id').primaryKey(),
  itemsJson: text('items_json').notNull(),
});

export const queueItems = sqliteTable(
  'local_runtime_queue_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    itemId: text('item_id').notNull(),
    status: text('status'),
    createdAtMs: integer('created_at_ms').notNull(),
    dataJson: text('data_json').notNull(),
    source: text('source'),
    clientRequestId: text('client_request_id'),
    dedupeKey: text('dedupe_key'),
    expiresAtMs: integer('expires_at_ms'),
    claimId: text('claim_id'),
    claimLeaseExpiresAtMs: integer('claim_lease_expires_at_ms'),
    routingFingerprint: text('routing_fingerprint'),
  },
  (table) => [
    uniqueIndex('local_runtime_queue_items_session_item').on(table.sessionId, table.itemId),
    index('idx_local_runtime_queue_items_session_id').on(table.sessionId, table.id),
    index('idx_local_runtime_queue_items_session_status_id').on(
      table.sessionId,
      table.status,
      table.id,
    ),
    index('idx_local_runtime_queue_items_session_client_request')
      .on(table.sessionId, table.clientRequestId)
      .where(sql`${table.clientRequestId} IS NOT NULL`),
    index('idx_local_runtime_queue_items_session_dedupe')
      .on(table.sessionId, table.dedupeKey)
      .where(sql`${table.dedupeKey} IS NOT NULL`),
    index('idx_local_runtime_queue_items_session_claim_id')
      .on(table.sessionId, table.claimId, table.id)
      .where(sql`${table.claimId} IS NOT NULL`),
    index('idx_local_runtime_queue_items_session_routing_id')
      .on(table.sessionId, table.status, table.routingFingerprint, table.id)
      .where(sql`${table.routingFingerprint} IS NOT NULL`),
    index('idx_local_runtime_queue_items_session_status_expiry_id').on(
      table.sessionId,
      table.status,
      table.id,
      table.expiresAtMs,
    ),
  ],
);

/** Durable Session-level execution gate. Queue items remain the pending-work source of truth. */
export const queuePauses = sqliteTable(
  'local_runtime_queue_pauses',
  {
    sessionId: text('session_id').primaryKey(),
    cause: text('cause').notNull(),
    triggerTurnId: text('trigger_turn_id').notNull(),
    pausedAtMs: integer('paused_at_ms').notNull(),
  },
  (table) => [
    check(
      'local_runtime_queue_pauses_cause_check',
      sql`${table.cause} IN ('user-stop', 'turn-final-failure')`,
    ),
  ],
);

export const queueRowMigrations = sqliteTable('local_runtime_queue_row_migrations', {
  sessionId: text('session_id').primaryKey(),
  queueRowsBackfilledAtMs: integer('queue_rows_backfilled_at_ms').notNull(),
});

export const queueMigrationQuarantine = sqliteTable(
  'local_runtime_queue_migration_quarantine',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    sourceKind: text('source_kind').notNull(),
    sourceKey: text('source_key').notNull(),
    rawJson: text('raw_json').notNull(),
    error: text('error').notNull(),
  },
  (table) => [
    uniqueIndex('local_runtime_queue_migration_quarantine_source').on(
      table.sessionId,
      table.sourceKind,
      table.sourceKey,
    ),
  ],
);
