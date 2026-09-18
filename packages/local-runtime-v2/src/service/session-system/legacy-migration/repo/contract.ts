import type { AppDb } from '../../../../infra/db/client.js';
import type { CanonicalHistoryEnvelope } from '../../../../infra/file/canonical-history.js';
import type {
  LegacyMigrationRecord,
  LegacyOpenCodeNativeReadResult,
  LegacyOpencodeAgentRecord,
  LegacyOpencodeDisplayMessage,
  LegacyOpencodeMessageListOptions,
  LegacyOpencodeMessagePage,
  LegacyOpencodeMessageScan,
  LegacyOpencodeSessionRecord,
  LegacyOpencodeSourceManifest,
} from '../../../../infra/legacy-db/model.js';

export * from '../../../../infra/legacy-db/model.js';

export type HistoryMigrationSource = 'ledger-snapshot' | 'sqlite-rows' | 'sqlite-blob' | 'empty';
export interface HistoryMigrationCheckpoint {
  readonly sessionId: string;
  readonly migratedAtMs: number;
  readonly source: HistoryMigrationSource;
  readonly messageCount: number;
  readonly targetRevision: string;
}
export interface HistoryPersistenceRepository {
  getCheckpoint(sessionId: string): Promise<HistoryMigrationCheckpoint | undefined>;
  upsertCheckpoint(checkpoint: HistoryMigrationCheckpoint): Promise<void>;
  deleteSessionData(sessionId: string): Promise<void>;
}
export interface HistoryPersistenceRepositoryOptions {
  readonly db: AppDb;
}
export interface LegacyHistorySourceReader {
  readLedgerSnapshot(sessionId: string): Promise<readonly CanonicalHistoryEnvelope[] | undefined>;
  readSqliteRows(sessionId: string): Promise<readonly CanonicalHistoryEnvelope[]>;
  readSqliteBlob(sessionId: string): Promise<readonly CanonicalHistoryEnvelope[]>;
}
export interface LegacyHistorySourceReaderOptions {
  readonly db: AppDb;
  readonly readLedgerSnapshot: (
    sessionId: string,
  ) => Promise<readonly CanonicalHistoryEnvelope[] | undefined>;
}

export interface LegacyOpencodeSourceReader {
  getSession(sessionId: string): Promise<LegacyOpencodeSessionRecord | undefined>;
  listSessions(agentName?: string): Promise<readonly LegacyOpencodeSessionRecord[]>;
  listMessages(
    sessionId: string,
    options?: number | LegacyOpencodeMessageListOptions,
  ): Promise<readonly LegacyOpencodeDisplayMessage[]>;
  streamMessagePages(
    sessionId: string,
    pageSize: number,
    maxPageBytes?: number,
  ): AsyncIterable<readonly LegacyOpencodeDisplayMessage[]>;
  listMessagePage(
    sessionId: string,
    options?: number | LegacyOpencodeMessageListOptions,
  ): Promise<LegacyOpencodeMessagePage>;
  countMessages(sessionId: string): Promise<number>;
  scanMessages(sessionId: string): Promise<LegacyOpencodeMessageScan>;
  listNativeMessages(
    session: LegacyOpencodeSessionRecord,
  ): Promise<LegacyOpenCodeNativeReadResult | undefined>;
  getAgent(agentName: string): Promise<LegacyOpencodeAgentRecord | undefined>;
  getSourceManifest(): Promise<LegacyOpencodeSourceManifest>;
}
export interface LegacySessionMigrationRepository {
  getByLegacySessionId(legacySessionId: string): Promise<LegacyMigrationRecord | undefined>;
  getByLocalSessionId(localSessionId: string): Promise<LegacyMigrationRecord | undefined>;
  listAll(): Promise<readonly LegacyMigrationRecord[]>;
  upsert(record: LegacyMigrationRecord): Promise<void>;
  markDeleted(sessionId: string): Promise<boolean>;
}
export interface LegacySessionMigrationRepositoryOptions {
  readonly db: AppDb;
  readonly nowMs?: () => number;
}
