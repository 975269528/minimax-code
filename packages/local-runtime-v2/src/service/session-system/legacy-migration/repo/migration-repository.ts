import { asc, desc, eq } from 'drizzle-orm';

import { legacyMigrations } from '../../../../infra/db/schema/legacy-session.js';
import type {
  LegacySessionMigrationRepository,
  LegacySessionMigrationRepositoryOptions,
  LegacyMigrationRecord,
  LegacyMigrationStatus,
} from './contract.js';

export function createLegacySessionMigrationRepository(
  options: LegacySessionMigrationRepositoryOptions,
): LegacySessionMigrationRepository {
  return new DrizzleLegacySessionMigrationRepository(options);
}
class DrizzleLegacySessionMigrationRepository implements LegacySessionMigrationRepository {
  constructor(private readonly options: LegacySessionMigrationRepositoryOptions) {}
  async getByLegacySessionId(legacySessionId: string) {
    const row = this.options.db
      .select()
      .from(legacyMigrations)
      .where(eq(legacyMigrations.legacySessionId, legacySessionId))
      .get();
    return row ? decode(row) : undefined;
  }
  async getByLocalSessionId(localSessionId: string) {
    const row = this.options.db
      .select()
      .from(legacyMigrations)
      .where(eq(legacyMigrations.localSessionId, localSessionId))
      .get();
    return row ? decode(row) : undefined;
  }
  async listAll() {
    return this.options.db
      .select()
      .from(legacyMigrations)
      .orderBy(desc(legacyMigrations.migratedAtMs), asc(legacyMigrations.legacySessionId))
      .all()
      .map(decode);
  }
  async upsert(record: LegacyMigrationRecord) {
    validate(record);
    const values = encode(record);
    this.options.db
      .insert(legacyMigrations)
      .values(values)
      .onConflictDoUpdate({
        target: legacyMigrations.legacySessionId,
        set: values,
      })
      .run();
  }
  async markDeleted(sessionId: string) {
    return this.options.db.transaction(
      (tx) => {
        const values = {
          status: 'deleted' as const,
          migratedAtMs: (this.options.nowMs ?? Date.now)(),
          errorJson: null,
        };
        const byLocal = tx
          .update(legacyMigrations)
          .set(values)
          .where(eq(legacyMigrations.localSessionId, sessionId))
          .run();
        if (byLocal.changes > 0) return true;
        return (
          tx
            .update(legacyMigrations)
            .set(values)
            .where(eq(legacyMigrations.legacySessionId, sessionId))
            .run().changes > 0
        );
      },
      { behavior: 'immediate' },
    );
  }
}
function encode(record: LegacyMigrationRecord): typeof legacyMigrations.$inferInsert {
  return {
    legacySessionId: record.legacySessionId,
    localSessionId: record.localSessionId,
    legacyDaemonSessionId: record.legacyDaemonSessionId ?? record.legacySessionId,
    legacyFrameworkSessionId: nullable(record.legacyFrameworkSessionId),
    sourceRuntime: record.sourceRuntime,
    status: record.status,
    migratedAtMs: record.migratedAtMs,
    sourceUpdatedAtMs: nullable(record.sourceUpdatedAtMs),
    sourceFingerprint: nullable(record.sourceFingerprint),
    sourceSchemaFingerprint: nullable(record.sourceSchemaFingerprint),
    sourceChecksum: nullable(record.sourceChecksum),
    displayChecksum: nullable(record.displayChecksum),
    piHistoryStrategy: nullable(record.piHistoryStrategy),
    piHistoryConverterVersion: nullable(record.piHistoryConverterVersion),
    sourceManifestJson: json(record.sourceManifest),
    sourceMessageCount: nullable(record.sourceMessageCount),
    importedMessageCount: nullable(record.importedMessageCount),
    reportJson: json(record.report),
    ledgerImportedAtMs: nullable(record.ledgerImportedAtMs),
    projectionReadyAtMs: nullable(record.projectionReadyAtMs),
    displayReadyAtMs: nullable(record.displayReadyAtMs),
    piHistoryReadyAtMs: nullable(record.piHistoryReadyAtMs),
    warningsJson: record.warnings?.length ? JSON.stringify(record.warnings) : null,
    errorJson: json(record.error),
  };
}
function decode(row: typeof legacyMigrations.$inferSelect): LegacyMigrationRecord {
  if (row.sourceRuntime !== 'opencode' || !status(row.status)) {
    throw new Error(`Legacy migration audit is corrupt: ${row.legacySessionId}`);
  }
  return {
    legacySessionId: row.legacySessionId,
    localSessionId: row.localSessionId,
    ...(row.legacyDaemonSessionId ? { legacyDaemonSessionId: row.legacyDaemonSessionId } : {}),
    ...(row.legacyFrameworkSessionId
      ? { legacyFrameworkSessionId: row.legacyFrameworkSessionId }
      : {}),
    sourceRuntime: 'opencode',
    status: row.status,
    migratedAtMs: row.migratedAtMs,
    ...numberField('sourceUpdatedAtMs', row.sourceUpdatedAtMs),
    ...stringField('sourceFingerprint', row.sourceFingerprint),
    ...stringField('sourceSchemaFingerprint', row.sourceSchemaFingerprint),
    ...stringField('sourceChecksum', row.sourceChecksum),
    ...stringField('displayChecksum', row.displayChecksum),
    ...stringField('piHistoryStrategy', row.piHistoryStrategy),
    ...numberField('piHistoryConverterVersion', row.piHistoryConverterVersion),
    ...jsonField('sourceManifest', row.sourceManifestJson),
    ...numberField('sourceMessageCount', row.sourceMessageCount),
    ...numberField('importedMessageCount', row.importedMessageCount),
    ...jsonField('report', row.reportJson),
    ...numberField('ledgerImportedAtMs', row.ledgerImportedAtMs),
    ...numberField('projectionReadyAtMs', row.projectionReadyAtMs),
    ...numberField('displayReadyAtMs', row.displayReadyAtMs),
    ...numberField('piHistoryReadyAtMs', row.piHistoryReadyAtMs),
    ...(row.warningsJson ? { warnings: parseWarnings(row.warningsJson) } : {}),
    ...jsonField('error', row.errorJson),
  };
}
function validate(record: LegacyMigrationRecord) {
  if (
    !record.legacySessionId ||
    !record.localSessionId ||
    record.sourceRuntime !== 'opencode' ||
    !status(record.status) ||
    !Number.isSafeInteger(record.migratedAtMs)
  )
    throw new TypeError('Invalid Legacy migration audit record');
}
function status(value: string): value is LegacyMigrationStatus {
  return ['discovered', 'metadata', 'migrated', 'failed', 'deleted'].includes(value);
}
function json(value: unknown) {
  return value === undefined ? null : JSON.stringify(value);
}
function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}
function parse(raw: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error('Legacy migration JSON is corrupt', { cause: error });
  }
}
function parseWarnings(raw: string) {
  const value = parse(raw);
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('Legacy migration warnings are corrupt');
  }
  return value;
}
function numberField<Key extends string>(key: Key, value: number | null) {
  return value === null ? {} : ({ [key]: value } as Record<Key, number>);
}
function stringField<Key extends string>(key: Key, value: string | null) {
  return value === null ? {} : ({ [key]: value } as Record<Key, string>);
}
function jsonField<Key extends string>(key: Key, value: string | null) {
  return value === null ? {} : ({ [key]: parse(value) } as Record<Key, unknown>);
}
