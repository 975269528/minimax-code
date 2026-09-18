import { lstatSync, type Stats } from 'node:fs';
import { join } from 'node:path';

import { loadSqlite3Constructor, type BetterSqlite3Instance } from '../db/client.js';

export interface LegacyDaemonSessionIdentity {
  readonly legacyDaemonSessionId: string;
  readonly legacyFrameworkSessionId?: string;
}

/**
 * Explicit Session deletion only. The migration receipt supplies the exact
 * legacy identity; this function never scans or prunes unrelated rows.
 */
export function deleteLegacyDaemonSessionMessages(options: {
  readonly dataDir: string;
  readonly identity: LegacyDaemonSessionIdentity;
  readonly sqlite3ModulePath?: string;
}): number {
  const daemonSessionId = options.identity.legacyDaemonSessionId.trim();
  if (!daemonSessionId) throw new TypeError('Legacy daemon Session id is required');
  const databasePath = join(options.dataDir, 'sqlite.db');
  if (!legacyDatabaseExists(options.dataDir, databasePath)) return 0;
  const Database = loadSqlite3Constructor(options.sqlite3ModulePath);
  // Obsolete copies are best effort: never wait for a legacy writer to release its lock.
  const db = new Database(databasePath, { fileMustExist: true, timeout: 0 });
  try {
    return db
      .transaction(() => {
        if (!hasColumns(db, 'session_messages', ['session_id'])) return 0;
        const sourceSessionId = resolveMessageStorageId(db, {
          legacyDaemonSessionId: daemonSessionId,
          ...(options.identity.legacyFrameworkSessionId
            ? { legacyFrameworkSessionId: options.identity.legacyFrameworkSessionId }
            : {}),
        });
        return db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(sourceSessionId)
          .changes;
      })
      .immediate();
  } finally {
    db.close();
  }
}

function resolveMessageStorageId(
  db: BetterSqlite3Instance,
  identity: LegacyDaemonSessionIdentity,
): string {
  const frameworkSessionId = identity.legacyFrameworkSessionId?.trim();
  if (!frameworkSessionId || frameworkSessionId === identity.legacyDaemonSessionId) {
    return identity.legacyDaemonSessionId;
  }
  if (!hasColumns(db, 'sessions', ['session_id', 'framework_session_id'])) {
    throw unconfirmedIdentity(identity.legacyDaemonSessionId);
  }
  const row = db
    .prepare('SELECT framework_session_id FROM sessions WHERE session_id = ? LIMIT 1')
    .get(identity.legacyDaemonSessionId);
  const recordedFrameworkSessionId = readString(row, 'framework_session_id');
  if (recordedFrameworkSessionId !== frameworkSessionId) {
    throw unconfirmedIdentity(identity.legacyDaemonSessionId);
  }
  return hasMessageRows(db, identity.legacyDaemonSessionId)
    ? identity.legacyDaemonSessionId
    : frameworkSessionId;
}

function unconfirmedIdentity(legacyDaemonSessionId: string): Error {
  return new Error(`Legacy Session message identity is unconfirmed: ${legacyDaemonSessionId}`);
}

function hasMessageRows(db: BetterSqlite3Instance, sessionId: string): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 AS found FROM session_messages WHERE session_id = ? LIMIT 1')
      .get(sessionId),
  );
}

function hasColumns(
  db: BetterSqlite3Instance,
  table: string,
  required: readonly string[],
): boolean {
  if (!/^[a-z_]+$/u.test(table)) return false;
  const present = new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .flatMap((row) => {
        const name = readString(row, 'name');
        return name ? [name] : [];
      }),
  );
  return required.every((column) => present.has(column));
}

function readString(value: unknown, key: string): string | undefined {
  const field = Reflect.get(Object(value), key);
  return typeof field === 'string' && field.trim() ? field : undefined;
}

function legacyDatabaseExists(dataDir: string, databasePath: string): boolean {
  const dataDirInfo = lstatIfExists(dataDir);
  if (!dataDirInfo) return false;
  if (!dataDirInfo.isDirectory() || dataDirInfo.isSymbolicLink()) {
    throw new Error(`Legacy data directory is not a plain directory: ${dataDir}`);
  }
  const databaseInfo = lstatIfExists(databasePath);
  if (!databaseInfo) return false;
  if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink()) {
    throw new Error(`Legacy database is not a plain file: ${databasePath}`);
  }
  return true;
}

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (Reflect.get(Object(error), 'code') === 'ENOENT') return undefined;
    throw error;
  }
}
