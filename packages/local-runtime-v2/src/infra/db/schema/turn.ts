import { desc, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const sessionLocks = sqliteTable('local_runtime_session_locks', {
  sessionId: text('session_id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  ownerKind: text('owner_kind').notNull(),
  acquiredAtMs: integer('acquired_at_ms').notNull(),
  expiresAtMs: integer('expires_at_ms').notNull(),
});

export const turnIngress = sqliteTable(
  'local_runtime_turn_ingress',
  {
    turnId: text('turn_id').primaryKey(),
    sessionId: text('session_id').notNull(),
    /** Legacy column name; the domain value is only normal Turn vs compaction. */
    busyReason: text('source').notNull(),
    clientRequestId: text('client_request_id'),
    claimId: text('claim_id'),
    claimSource: text('claim_source'),
    queueItemIdsJson: text('queue_item_ids_json'),
    inputJson: text('input_json').notNull(),
    status: text('status').notNull(),
    acceptedAtMs: integer('accepted_at_ms').notNull(),
    acceptedSequence: integer('accepted_sequence'),
    completedAtMs: integer('completed_at_ms'),
    queueAcknowledgedAtMs: integer('queue_acknowledged_at_ms'),
    inputDigest: text('input_digest'),
    inputMetadataJson: text('input_metadata_json').notNull().default('{}'),
  },
  (table) => [
    check(
      'local_runtime_turn_ingress_status_check',
      sql`${table.status} IN ('accepted', 'completed', 'failed', 'aborted')`,
    ),
    uniqueIndex('idx_local_runtime_turn_ingress_claim_id')
      .on(table.claimId)
      .where(sql`${table.claimId} IS NOT NULL`),
    uniqueIndex('idx_local_runtime_turn_ingress_client_request')
      .on(table.sessionId, table.clientRequestId)
      .where(sql`${table.clientRequestId} IS NOT NULL`),
    uniqueIndex('idx_local_runtime_turn_ingress_sequence')
      .on(table.acceptedSequence)
      .where(sql`${table.acceptedSequence} IS NOT NULL`),
    index('idx_local_runtime_turn_ingress_session_accepted_sequence')
      .on(table.sessionId, desc(table.acceptedSequence))
      .where(sql`${table.status} = 'accepted'`),
  ],
);

export const turnIngressSequences = sqliteTable(
  'local_runtime_turn_ingress_sequences',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    turnId: text('turn_id').notNull(),
  },
  (table) => [uniqueIndex('local_runtime_turn_ingress_sequences_turn_id').on(table.turnId)],
);

export const turnIngressClientRequests = sqliteTable(
  'local_runtime_turn_ingress_client_requests',
  {
    sessionId: text('session_id').notNull(),
    clientRequestId: text('client_request_id').notNull(),
    turnId: text('turn_id')
      .notNull()
      .references(() => turnIngress.turnId, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.clientRequestId] }),
    index('idx_local_runtime_turn_ingress_clients_turn').on(table.turnId, table.ordinal),
  ],
);
