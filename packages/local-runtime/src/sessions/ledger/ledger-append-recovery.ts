import { Buffer } from 'node:buffer';
import { closeSync, openSync, readSync, statSync, truncateSync } from 'node:fs';

import { logger } from '../../common/logger.js';
import type { DatabaseLike } from '../../persistence/db.js';

export class LocalSessionLedgerCommitUncertainError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      'LOCAL_SESSION_LEDGER_COMMIT_UNCERTAIN: JSONL append could not be safely acknowledged or retried',
    );
    this.name = 'LocalSessionLedgerCommitUncertainError';
    this.cause = cause;
  }
}

export function runInTransaction<T>(db: DatabaseLike, fn: () => T): T {
  if (!db.transaction) return fn();
  return db.transaction(fn).immediate();
}

export function ledgerFileSizeSync(ledgerPath: string): number {
  try {
    return statSync(ledgerPath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

export function recoverFailedLedgerAppendSync(
  ledgerPath: string,
  preAppendSize: number,
  contents: string,
  appendError: unknown,
): boolean {
  try {
    const payload = Buffer.from(contents, 'utf-8');
    let postAppendSize: number;
    try {
      postAppendSize = statSync(ledgerPath).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && preAppendSize === 0) return false;
      throw error;
    }
    const writtenLength = postAppendSize - preAppendSize;
    if (writtenLength === 0) return false;
    if (writtenLength < 0 || writtenLength > payload.length) {
      throw new Error('ledger size is outside the expected append range');
    }
    const written = readLedgerRangeSync(ledgerPath, preAppendSize, writtenLength);
    if (!written.equals(payload.subarray(0, writtenLength))) {
      throw new Error('ledger append bytes do not match the expected payload');
    }
    if (writtenLength === payload.length) return true;
    truncateSync(ledgerPath, preAppendSize);
    return false;
  } catch (recoveryError) {
    throw new LocalSessionLedgerCommitUncertainError(
      recoveryError instanceof Error ? recoveryError : appendError,
    );
  }
}

export function logLedgerMetricFailure(sessionId: string, metric: string, error: unknown): void {
  logger.warn(
    {
      session_id: sessionId,
      metric,
      error_type: error instanceof Error ? error.name : typeof error,
    },
    '[file-session-ledger] metrics callback failed after ledger append',
  );
}

export function needsJsonlLineBoundarySync(ledgerPath: string): boolean {
  let handle: number | undefined;
  try {
    handle = openSync(ledgerPath, 'r');
    const fileStat = statSync(ledgerPath);
    if (fileStat.size === 0) return false;
    const lastByte = Buffer.alloc(1);
    readSync(handle, lastByte, 0, 1, fileStat.size - 1);
    return lastByte[0] !== 0x0a;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function readLedgerRangeSync(ledgerPath: string, start: number, length: number): Buffer {
  const contents = Buffer.alloc(length);
  let handle: number | undefined;
  let offset = 0;
  try {
    handle = openSync(ledgerPath, 'r');
    while (offset < length) {
      const bytesRead = readSync(handle, contents, offset, length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
  if (offset !== length) throw new Error('ledger append bytes could not be read completely');
  return contents;
}
