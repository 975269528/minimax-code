export interface CanonicalHistorySourceReaders<T> {
  /** `undefined` means absent; an empty array is an authoritative existing target. */
  readonly readTarget: () => Promise<readonly T[] | undefined>;
  /** `undefined` means no authoritative Pi-history fact; an empty array is authoritative. */
  readonly readAuthoritativeLedgerSnapshot: () => Promise<readonly T[] | undefined>;
  readonly readSqliteRows: () => Promise<readonly T[]>;
  readonly readSqliteBlob: () => Promise<readonly T[]>;
}

export interface CanonicalHistorySourceSelection<T> {
  readonly source: 'target' | 'ledger-snapshot' | 'sqlite-rows' | 'sqlite-blob' | 'empty';
  readonly records: readonly T[];
}

/** Selects one authoritative source without falling through after a selected reader fails. */
export async function selectCanonicalHistorySource<T>(
  readers: CanonicalHistorySourceReaders<T>,
): Promise<CanonicalHistorySourceSelection<T>> {
  const target = await readers.readTarget();
  if (target !== undefined) return { source: 'target', records: target };

  const ledgerSnapshot = await readers.readAuthoritativeLedgerSnapshot();
  if (ledgerSnapshot !== undefined) {
    return { source: 'ledger-snapshot', records: ledgerSnapshot };
  }

  const rows = await readers.readSqliteRows();
  if (rows.length > 0) return { source: 'sqlite-rows', records: rows };

  const blob = await readers.readSqliteBlob();
  return blob.length > 0
    ? { source: 'sqlite-blob', records: blob }
    : { source: 'empty', records: [] };
}
