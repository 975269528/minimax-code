import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, realpath, rm } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

import type { DatabaseClient } from './client.js';

const BACKUP_DIRECTORY = join('v2', 'sqlite', 'backups');
const BACKUP_FILE_PREFIX = 'runtime-state-before-v2-migration';
const BACKUP_FILE_PATTERN = new RegExp(
  `^${BACKUP_FILE_PREFIX}-(\\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.sqlite$`,
  'iu',
);

const DATABASE_BACKUP_INITIALIZATION_ERROR_CODE = 'LOCAL_RUNTIME_V2_DATABASE_BACKUP_FAILED';

class DatabaseBackupInitializationError extends Error {
  readonly code = DATABASE_BACKUP_INITIALIZATION_ERROR_CODE;

  constructor(cause?: unknown) {
    super('Local runtime database backup failed');
    this.name = 'DatabaseBackupInitializationError';
    if (cause !== undefined) this.cause = cause;
  }
}

export type DatabaseBackupResult =
  | { readonly created: false }
  | {
      readonly created: true;
      readonly backupId: string;
      readonly fileName: string;
      readonly createdAtMs: number;
      /** File metadata captured before the successful integrity check, valid only in this run. */
      readonly verifiedFileIdentity: string;
      /** Wall-clock cost of the online backup copy, for startup timing diagnostics. */
      readonly backupMs: number;
      /** Wall-clock cost of the post-copy integrity verification. */
      readonly integrityMs: number;
      /** Size of the produced backup file, or undefined when it could not be read. */
      readonly sizeBytes?: number;
    };

export type CreatedDatabaseBackup = Extract<DatabaseBackupResult, { readonly created: true }>;

interface DatabaseBackupPort {
  backup(destinationPath: string): Promise<void>;
  hasValidIntegrity(databasePath: string): boolean;
}

export interface CreateDatabaseBackupOptions {
  readonly database: Pick<DatabaseClient, keyof DatabaseBackupPort>;
  readonly dataDir: string;
  /** Determined by schema/data migration preflight results. */
  readonly pending: boolean;
}

export interface DatabaseBackupRetentionResult {
  readonly deleted: number;
  readonly retainedFileName?: string;
}

/**
 * Create a validated SQLite online backup when migration is pending. Return the backup identity and
 * file metadata from validation, without exposing user directories or database contents.
 */
export async function createDatabaseBackupIfPending(
  options: CreateDatabaseBackupOptions,
): Promise<DatabaseBackupResult> {
  if (!options.pending) return { created: false };

  const createdAtMs = Date.now();
  const backupId = randomUUID();
  const fileName = `${BACKUP_FILE_PREFIX}-${createdAtMs}-${backupId}.sqlite`;
  let resolvedDataDir: string | undefined;
  let destinationPath: string | undefined;

  try {
    resolvedDataDir = await resolveBackupDataDir(options.dataDir);
    if (!resolvedDataDir || !(await ensurePlainBackupDirectoryChain(resolvedDataDir))) {
      throw new Error('unsafe backup directory');
    }
    destinationPath = join(resolvedDataDir, BACKUP_DIRECTORY, fileName);
    const backupStartedAtMs = Date.now();
    await options.database.backup(destinationPath);
    const backupMs = Math.max(0, Date.now() - backupStartedAtMs);
    if (!(await hasPlainBackupDirectoryChain(resolvedDataDir))) {
      throw new Error('unsafe backup directory after write');
    }
    const integrityStartedAtMs = Date.now();
    const verifiedFileIdentity = await verifyCreatedBackup(options.database, destinationPath);
    const integrityMs = Math.max(0, Date.now() - integrityStartedAtMs);
    const sizeBytes = readIdentitySizeBytes(verifiedFileIdentity);
    return {
      created: true,
      backupId,
      fileName,
      createdAtMs,
      verifiedFileIdentity,
      backupMs,
      integrityMs,
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    };
  } catch (error) {
    if (
      resolvedDataDir &&
      destinationPath &&
      (await hasPlainBackupDirectoryChain(resolvedDataDir))
    ) {
      await removeBackupFamily(destinationPath);
    }
    throw new DatabaseBackupInitializationError(error);
  }
}

/**
 * After all migrations and final schema validation succeed, authorize deletion only of the exact
 * backup created by this run. Never call on ordinary startup; retain all unknown files and files
 * with equal or newer timestamps.
 */
export async function pruneSupersededDatabaseBackups(options: {
  readonly dataDir: string;
  readonly retainedBackup: CreatedDatabaseBackup;
}): Promise<DatabaseBackupRetentionResult> {
  if (!validCreatedBackupIdentity(options.retainedBackup)) return { deleted: 0 };
  const resolvedDataDir = await resolveBackupDataDir(options.dataDir);
  if (!resolvedDataDir || !(await hasPlainBackupDirectoryChain(resolvedDataDir))) {
    return { deleted: 0 };
  }
  const directoryPath = join(resolvedDataDir, BACKUP_DIRECTORY);
  const retainedPath = join(directoryPath, options.retainedBackup.fileName);
  const verifiedIdentity = options.retainedBackup.verifiedFileIdentity;
  if (!verifiedIdentity || (await readBackupFileIdentity(retainedPath)) !== verifiedIdentity) {
    return { deleted: 0 };
  }
  let entries: Dirent[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return { deleted: 0 };
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .flatMap((entry) => {
      const match = BACKUP_FILE_PATTERN.exec(entry.name);
      const createdAtMs = match?.[1] ? Number(match[1]) : Number.NaN;
      return Number.isSafeInteger(createdAtMs) && createdAtMs >= 0
        ? [{ fileName: entry.name, createdAtMs }]
        : [];
    })
    .filter(
      (candidate) =>
        candidate.fileName !== options.retainedBackup.fileName &&
        candidate.createdAtMs < options.retainedBackup.createdAtMs,
    );
  const deleted = await candidates.reduce<Promise<number>>(async (countPromise, candidate) => {
    const count = await countPromise;
    if (!(await hasPlainBackupDirectoryChain(resolvedDataDir))) return count;
    if ((await readBackupFileIdentity(retainedPath)) !== verifiedIdentity) return count;
    const path = join(directoryPath, candidate.fileName);
    if (!(await removePlainFile(path))) return count;
    await removeBackupSidecars(path);
    return count + 1;
  }, Promise.resolve(0));
  return { deleted, retainedFileName: options.retainedBackup.fileName };
}

function validCreatedBackupIdentity(backup: CreatedDatabaseBackup): boolean {
  if (!Number.isSafeInteger(backup.createdAtMs) || backup.createdAtMs < 0) return false;
  const expectedFileName = `${BACKUP_FILE_PREFIX}-${String(backup.createdAtMs)}-${backup.backupId}.sqlite`;
  return backup.fileName === expectedFileName && BACKUP_FILE_PATTERN.test(backup.fileName);
}

async function resolveBackupDataDir(dataDir: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(dataDir);
    return (await isPlainDirectory(resolved)) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

async function ensurePlainBackupDirectoryChain(dataDir: string): Promise<boolean> {
  const paths = backupDirectoryChain(dataDir);
  for (const [index, path] of paths.entries()) {
    if (!(await ensurePlainDirectory(path, index > 0))) return false;
  }
  return true;
}

async function ensurePlainDirectory(path: string, createIfMissing: boolean): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if (!createIfMissing || !hasCode(error, 'ENOENT')) return false;
  }
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) return false;
  }
  return isPlainDirectory(path);
}

async function removeBackupFamily(databasePath: string): Promise<void> {
  await removePlainFile(databasePath);
  await removeBackupSidecars(databasePath);
}

async function removeBackupSidecars(databasePath: string): Promise<void> {
  await Promise.all(['-wal', '-shm'].map((suffix) => removePlainFile(`${databasePath}${suffix}`)));
}

async function removePlainFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    await rm(path);
    return true;
  } catch {
    return false;
  }
}

async function hasPlainBackupDirectoryChain(dataDir: string): Promise<boolean> {
  for (const path of backupDirectoryChain(dataDir)) {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function isPlainDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function verifyCreatedBackup(database: DatabaseBackupPort, path: string): Promise<string> {
  const identity = await readBackupFileIdentity(path);
  if (!identity || !database.hasValidIntegrity(path)) throw new Error('integrity check failed');
  return identity;
}

async function readBackupFileIdentity(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
  } catch {
    return undefined;
  }
}

/**
 * Recovers the size component from an already-captured identity string so the
 * timing diagnostics never issue an extra stat against the backup file.
 */
function readIdentitySizeBytes(identity: string): number | undefined {
  const size = Number(identity.split(':')[2]);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

function backupDirectoryChain(dataDir: string): readonly string[] {
  return [
    dataDir,
    join(dataDir, 'v2'),
    join(dataDir, 'v2', 'sqlite'),
    join(dataDir, BACKUP_DIRECTORY),
  ];
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === code);
}
