import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const fileHistoryMigrations = sqliteTable('local_runtime_pi_history_file_migrations', {
  sessionId: text('session_id').primaryKey(),
  migratedAtMs: integer('migrated_at_ms').notNull(),
  source: text('source').notNull(),
  messageCount: integer('message_count').notNull(),
  targetRevision: text('target_revision').notNull(),
});

export const legacyMigrations = sqliteTable(
  'local_runtime_legacy_migrations',
  {
    legacySessionId: text('legacy_session_id').primaryKey(),
    localSessionId: text('local_session_id').notNull(),
    legacyDaemonSessionId: text('legacy_daemon_session_id'),
    legacyFrameworkSessionId: text('legacy_framework_session_id'),
    sourceRuntime: text('source_runtime').notNull(),
    status: text('status').notNull(),
    migratedAtMs: integer('migrated_at_ms').notNull(),
    sourceUpdatedAtMs: integer('source_updated_at_ms'),
    sourceFingerprint: text('source_fingerprint'),
    sourceSchemaFingerprint: text('source_schema_fingerprint'),
    sourceChecksum: text('source_checksum'),
    displayChecksum: text('display_checksum'),
    piHistoryStrategy: text('pi_history_strategy'),
    piHistoryConverterVersion: integer('pi_history_converter_version'),
    sourceManifestJson: text('source_manifest_json'),
    sourceMessageCount: integer('source_message_count'),
    importedMessageCount: integer('imported_message_count'),
    reportJson: text('report_json'),
    ledgerImportedAtMs: integer('ledger_imported_at_ms'),
    projectionReadyAtMs: integer('projection_ready_at_ms'),
    displayReadyAtMs: integer('display_ready_at_ms'),
    piHistoryReadyAtMs: integer('pi_history_ready_at_ms'),
    warningsJson: text('warnings_json'),
    errorJson: text('error_json'),
  },
  (table) => [
    uniqueIndex('idx_local_runtime_legacy_migrations_local_session').on(table.localSessionId),
    index('idx_local_runtime_legacy_migrations_framework_session').on(
      table.legacyFrameworkSessionId,
    ),
  ],
);

/**
 * The legacy owner ledger only diagnoses published versions; it must not determine the new global
 * migration order.
 */
export const legacyOwnerMigrations = sqliteTable(
  'local_runtime_owner_migrations',
  {
    owner: text('owner').notNull(),
    version: integer('version').notNull(),
    migrationKey: text('migration_key').notNull(),
    completedAtMs: integer('completed_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.owner, table.version] }),
    uniqueIndex('local_runtime_owner_migrations_owner_key').on(table.owner, table.migrationKey),
  ],
);

/** Optional legacy Pi rows; m0005 only validates these conditional migration inputs. */
export const legacyPiHistoryRows = sqliteTable(
  'local_runtime_pi_history_rows',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    role: text('role'),
    createdAtMs: integer('created_at_ms').notNull(),
    dataJson: text('data_json').notNull(),
  },
  (table) => [index('idx_local_runtime_pi_history_rows_session_id').on(table.sessionId, table.id)],
);

export const legacyPiHistoryRowMigrations = sqliteTable('local_runtime_pi_history_row_migrations', {
  sessionId: text('session_id').primaryKey(),
  historyRowsBackfilledAtMs: integer('history_rows_backfilled_at_ms').notNull(),
});
