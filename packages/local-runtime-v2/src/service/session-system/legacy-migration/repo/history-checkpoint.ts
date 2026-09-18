import { eq } from 'drizzle-orm';

import {
  fileHistoryMigrations,
  legacyPiHistoryRowMigrations,
  legacyPiHistoryRows,
} from '../../../../infra/db/schema/legacy-session.js';
import { legacyMessages } from '../../../../infra/db/schema/messages.js';
import type {
  HistoryMigrationCheckpoint,
  HistoryMigrationSource,
  HistoryPersistenceRepository,
  HistoryPersistenceRepositoryOptions,
} from './contract.js';

export function createHistoryPersistenceRepository(
  options: HistoryPersistenceRepositoryOptions,
): HistoryPersistenceRepository {
  return new DrizzleHistoryPersistenceRepository(options);
}
class DrizzleHistoryPersistenceRepository implements HistoryPersistenceRepository {
  constructor(private readonly options: HistoryPersistenceRepositoryOptions) {}
  async getCheckpoint(sessionId: string) {
    const row = this.options.db
      .select()
      .from(fileHistoryMigrations)
      .where(eq(fileHistoryMigrations.sessionId, sessionId))
      .get();
    return row ? decode(row) : undefined;
  }
  async upsertCheckpoint(checkpoint: HistoryMigrationCheckpoint) {
    validate(checkpoint);
    this.options.db
      .insert(fileHistoryMigrations)
      .values(checkpoint)
      .onConflictDoUpdate({
        target: fileHistoryMigrations.sessionId,
        set: {
          migratedAtMs: checkpoint.migratedAtMs,
          source: checkpoint.source,
          messageCount: checkpoint.messageCount,
          targetRevision: checkpoint.targetRevision,
        },
      })
      .run();
  }
  async deleteSessionData(sessionId: string) {
    this.options.db.transaction((db) => {
      db.delete(fileHistoryMigrations).where(eq(fileHistoryMigrations.sessionId, sessionId)).run();
      deleteLegacyHistoryRows(db, sessionId);
      deleteLegacyHistoryBlob(db, sessionId);
    });
  }
}

function deleteLegacyHistoryRows(db: HistoryPersistenceRepositoryOptions['db'], sessionId: string) {
  deleteOptional(db, legacyPiHistoryRows, sessionId, 'local_runtime_pi_history_rows');
  deleteOptional(
    db,
    legacyPiHistoryRowMigrations,
    sessionId,
    'local_runtime_pi_history_row_migrations',
  );
}

function deleteLegacyHistoryBlob(db: HistoryPersistenceRepositoryOptions['db'], sessionId: string) {
  const legacy = db
    .select({ displayMessagesJson: legacyMessages.displayMessagesJson })
    .from(legacyMessages)
    .where(eq(legacyMessages.sessionId, sessionId))
    .get();
  if (legacy?.displayMessagesJson === '[]') {
    db.delete(legacyMessages).where(eq(legacyMessages.sessionId, sessionId)).run();
  } else if (legacy) {
    db.update(legacyMessages)
      .set({ piHistoryJson: '[]' })
      .where(eq(legacyMessages.sessionId, sessionId))
      .run();
  }
}

function decode(row: typeof fileHistoryMigrations.$inferSelect): HistoryMigrationCheckpoint {
  if (!isSource(row.source)) throw new Error(`Invalid History checkpoint source: ${row.source}`);
  return { ...row, source: row.source };
}
function validate(checkpoint: HistoryMigrationCheckpoint) {
  if (
    !checkpoint.sessionId ||
    !isSource(checkpoint.source) ||
    !Number.isSafeInteger(checkpoint.migratedAtMs) ||
    !Number.isSafeInteger(checkpoint.messageCount) ||
    checkpoint.messageCount < 0 ||
    !checkpoint.targetRevision
  ) {
    throw new TypeError('Invalid History migration checkpoint');
  }
}
function isSource(value: string): value is HistoryMigrationSource {
  return ['ledger-snapshot', 'sqlite-rows', 'sqlite-blob', 'empty'].includes(value);
}
function deleteOptional(
  db: HistoryPersistenceRepositoryOptions['db'],
  table: typeof legacyPiHistoryRows | typeof legacyPiHistoryRowMigrations,
  sessionId: string,
  tableName: string,
) {
  try {
    db.delete(table).where(eq(table.sessionId, sessionId)).run();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== `no such table: ${tableName}`) throw error;
  }
}
