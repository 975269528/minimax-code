import { type DataDirInput, type DatabaseLike, withLocalRuntimeDb } from '../db.js';

/**
 * Lifecycle of a legacy opencode → v2 local-runtime migration record.
 *
 * Ordered by increasing "amount of work done" on behalf of a legacy session:
 *
 * - `discovered` — cheap fingerprint only. Migrator has seen the legacy
 *   session and written this row, but has NOT built a local pi-agent
 *   session row, agent row, or message import. Emitted from
 *   list-sessions / list-sessions-for-tree (the metadata lazy stage) so a
 *   cold-start `GET /agent/:name/session[/tree]` is bounded by an upsert per
 *   legacy session, not by session + agent + root-resolution SQLite writes.
 *   Any read/mutation on the local id will lazily "materialize" the row on
 *   demand (see `resolveLocalSessionById`).
 * - `metadata` — local pi-agent session row + agent row exist. Display /
 *   pi-history messages have not been imported yet. Reached when the user
 *   actually touches the session (open detail, mutation, etc.).
 * - `migrated` — display and pi-history imports finished; ledger + snapshot
 *   watermarks written.
 * - `failed` — a previous stage threw and the error is captured on the
 *   record for retry / diagnostics.
 * - `deleted` — user-initiated tombstone; row stays for idempotency but
 *   hides from user-facing lists.
 */
export type LegacyMigrationStatus = 'discovered' | 'metadata' | 'migrated' | 'failed' | 'deleted';
export type LegacyMigrationSourceRuntime = 'opencode';

export interface LegacyMigrationRecord {
  legacySessionId: string;
  localSessionId: string;
  legacyDaemonSessionId?: string;
  legacyFrameworkSessionId?: string;
  sourceRuntime: LegacyMigrationSourceRuntime;
  status: LegacyMigrationStatus;
  migratedAtMs: number;
  sourceUpdatedAtMs?: number;
  sourceFingerprint?: string;
  sourceSchemaFingerprint?: string;
  sourceChecksum?: string;
  displayChecksum?: string;
  piHistoryStrategy?: string;
  /**
   * Converter shape version stamped by
   * `NATIVE_PI_HISTORY_CONVERTER_VERSION` at write time. Callers use
   * `isLegacyPiHistoryReady` + `piHistoryConverterVersion` to detect
   * records migrated by an older converter (v1 emitted invalid pi-agent
   * shapes: `type: 'reasoning'`, `type: 'tool-call'`, `role: 'tool'` —
   * pi-agent's runtime dropped all three so tool calls / results
   * disappeared from replays). Undefined on records predating the
   * bump; those are treated as v1 and re-migrated once.
   *
   * Not persisted for non-native strategies (`display-seed-*`,
   * `existing-seed-preserved`, `deferred`) — those produce a single
   * user-role seed message whose shape has not changed.
   */
  piHistoryConverterVersion?: number;
  sourceManifest?: unknown;
  sourceMessageCount?: number;
  importedMessageCount?: number;
  report?: unknown;
  ledgerImportedAtMs?: number;
  projectionReadyAtMs?: number;
  displayReadyAtMs?: number;
  piHistoryReadyAtMs?: number;
  warnings?: string[];
  error?: unknown;
}

interface LegacyMigrationRow {
  legacy_session_id?: string;
  local_session_id?: string;
  legacy_daemon_session_id?: string | null;
  legacy_framework_session_id?: string | null;
  source_runtime?: string;
  status?: string;
  migrated_at_ms?: number;
  source_updated_at_ms?: number | null;
  source_fingerprint?: string | null;
  source_schema_fingerprint?: string | null;
  source_checksum?: string | null;
  display_checksum?: string | null;
  pi_history_strategy?: string | null;
  pi_history_converter_version?: number | null;
  source_manifest_json?: string | null;
  source_message_count?: number | null;
  imported_message_count?: number | null;
  report_json?: string | null;
  ledger_imported_at_ms?: number | null;
  projection_ready_at_ms?: number | null;
  display_ready_at_ms?: number | null;
  pi_history_ready_at_ms?: number | null;
  warnings_json?: string | null;
  error_json?: string | null;
}

export class SqliteLegacyMigrationStore {
  constructor(private readonly dataDir: DataDirInput) {}

  async getByLegacySessionId(legacySessionId: string): Promise<LegacyMigrationRecord | undefined> {
    return this.withDb((db) => {
      const row = db
        .prepare(
          `
          SELECT *
          FROM local_runtime_legacy_migrations
          WHERE legacy_session_id = ?
          LIMIT 1
        `,
        )
        .get(legacySessionId) as LegacyMigrationRow | undefined;
      return row ? toMigrationRecord(row) : undefined;
    });
  }

  async getByLocalSessionId(localSessionId: string): Promise<LegacyMigrationRecord | undefined> {
    return this.withDb((db) => {
      const row = db
        .prepare(
          `
          SELECT *
          FROM local_runtime_legacy_migrations
          WHERE local_session_id = ?
          LIMIT 1
        `,
        )
        .get(localSessionId) as LegacyMigrationRow | undefined;
      return row ? toMigrationRecord(row) : undefined;
    });
  }

  async listAll(): Promise<LegacyMigrationRecord[]> {
    return this.withDb((db) => {
      const rows = db
        .prepare(
          `
          SELECT *
          FROM local_runtime_legacy_migrations
          ORDER BY migrated_at_ms DESC, legacy_session_id ASC
        `,
        )
        .all() as LegacyMigrationRow[];
      return rows.flatMap((row) => {
        const record = toMigrationRecord(row);
        return record ? [record] : [];
      });
    });
  }

  async upsert(record: LegacyMigrationRecord): Promise<void> {
    this.withDb((db) => {
      db.prepare(
        `
        INSERT INTO local_runtime_legacy_migrations (
          legacy_session_id,
          local_session_id,
          legacy_daemon_session_id,
          legacy_framework_session_id,
          source_runtime,
          status,
          migrated_at_ms,
          source_updated_at_ms,
          source_fingerprint,
          source_schema_fingerprint,
          source_checksum,
          display_checksum,
          pi_history_strategy,
          pi_history_converter_version,
          source_manifest_json,
          source_message_count,
          imported_message_count,
          report_json,
          ledger_imported_at_ms,
          projection_ready_at_ms,
          display_ready_at_ms,
          pi_history_ready_at_ms,
          warnings_json,
          error_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(legacy_session_id) DO UPDATE SET
          local_session_id = excluded.local_session_id,
          legacy_daemon_session_id = excluded.legacy_daemon_session_id,
          legacy_framework_session_id = excluded.legacy_framework_session_id,
          source_runtime = excluded.source_runtime,
          status = excluded.status,
          migrated_at_ms = excluded.migrated_at_ms,
          source_updated_at_ms = excluded.source_updated_at_ms,
          source_fingerprint = excluded.source_fingerprint,
          source_schema_fingerprint = excluded.source_schema_fingerprint,
          source_checksum = excluded.source_checksum,
          display_checksum = excluded.display_checksum,
          pi_history_strategy = excluded.pi_history_strategy,
          pi_history_converter_version = excluded.pi_history_converter_version,
          source_manifest_json = excluded.source_manifest_json,
          source_message_count = excluded.source_message_count,
          imported_message_count = excluded.imported_message_count,
          report_json = excluded.report_json,
          ledger_imported_at_ms = excluded.ledger_imported_at_ms,
          projection_ready_at_ms = excluded.projection_ready_at_ms,
          display_ready_at_ms = excluded.display_ready_at_ms,
          pi_history_ready_at_ms = excluded.pi_history_ready_at_ms,
          warnings_json = excluded.warnings_json,
          error_json = excluded.error_json
      `,
      ).run(
        record.legacySessionId,
        record.localSessionId,
        record.legacyDaemonSessionId ?? record.legacySessionId,
        record.legacyFrameworkSessionId ?? null,
        record.sourceRuntime,
        record.status,
        record.migratedAtMs,
        record.sourceUpdatedAtMs ?? null,
        record.sourceFingerprint ?? null,
        record.sourceSchemaFingerprint ?? null,
        record.sourceChecksum ?? null,
        record.displayChecksum ?? null,
        record.piHistoryStrategy ?? null,
        record.piHistoryConverterVersion ?? null,
        record.sourceManifest === undefined ? null : JSON.stringify(record.sourceManifest),
        record.sourceMessageCount ?? null,
        record.importedMessageCount ?? null,
        record.report === undefined ? null : JSON.stringify(record.report),
        record.ledgerImportedAtMs ?? null,
        record.projectionReadyAtMs ?? null,
        record.displayReadyAtMs ?? null,
        record.piHistoryReadyAtMs ?? null,
        record.warnings?.length ? JSON.stringify(record.warnings) : null,
        record.error === undefined ? null : JSON.stringify(record.error),
      );
    });
  }

  private withDb<T>(fn: (db: DatabaseLike) => T): T {
    return withLocalRuntimeDb(this.dataDir, fn);
  }
}

function toMigrationRecord(row: LegacyMigrationRow): LegacyMigrationRecord | undefined {
  if (
    !row.legacy_session_id ||
    !row.local_session_id ||
    row.source_runtime !== 'opencode' ||
    !isMigrationStatus(row.status) ||
    typeof row.migrated_at_ms !== 'number'
  ) {
    return undefined;
  }
  return {
    legacySessionId: row.legacy_session_id,
    localSessionId: row.local_session_id,
    ...(row.legacy_daemon_session_id
      ? { legacyDaemonSessionId: row.legacy_daemon_session_id }
      : {}),
    ...(row.legacy_framework_session_id
      ? { legacyFrameworkSessionId: row.legacy_framework_session_id }
      : {}),
    sourceRuntime: 'opencode',
    status: row.status,
    migratedAtMs: row.migrated_at_ms,
    ...(typeof row.source_updated_at_ms === 'number'
      ? { sourceUpdatedAtMs: row.source_updated_at_ms }
      : {}),
    ...(row.source_fingerprint ? { sourceFingerprint: row.source_fingerprint } : {}),
    ...(row.source_schema_fingerprint
      ? { sourceSchemaFingerprint: row.source_schema_fingerprint }
      : {}),
    ...(row.source_checksum ? { sourceChecksum: row.source_checksum } : {}),
    ...(row.display_checksum ? { displayChecksum: row.display_checksum } : {}),
    ...(row.pi_history_strategy ? { piHistoryStrategy: row.pi_history_strategy } : {}),
    ...(typeof row.pi_history_converter_version === 'number'
      ? { piHistoryConverterVersion: row.pi_history_converter_version }
      : {}),
    ...(row.source_manifest_json ? { sourceManifest: parseJson(row.source_manifest_json) } : {}),
    ...(typeof row.source_message_count === 'number'
      ? { sourceMessageCount: row.source_message_count }
      : {}),
    ...(typeof row.imported_message_count === 'number'
      ? { importedMessageCount: row.imported_message_count }
      : {}),
    ...(row.report_json ? { report: parseJson(row.report_json) } : {}),
    ...(typeof row.ledger_imported_at_ms === 'number'
      ? { ledgerImportedAtMs: row.ledger_imported_at_ms }
      : {}),
    ...(typeof row.projection_ready_at_ms === 'number'
      ? { projectionReadyAtMs: row.projection_ready_at_ms }
      : {}),
    ...(typeof row.display_ready_at_ms === 'number'
      ? { displayReadyAtMs: row.display_ready_at_ms }
      : {}),
    ...(typeof row.pi_history_ready_at_ms === 'number'
      ? { piHistoryReadyAtMs: row.pi_history_ready_at_ms }
      : {}),
    ...(row.warnings_json ? { warnings: parseWarnings(row.warnings_json) } : {}),
    ...(row.error_json ? { error: parseJson(row.error_json) } : {}),
  };
}

function isMigrationStatus(value: unknown): value is LegacyMigrationStatus {
  return (
    value === 'discovered' ||
    value === 'metadata' ||
    value === 'migrated' ||
    value === 'failed' ||
    value === 'deleted'
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseWarnings(value: string): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : [];
}
