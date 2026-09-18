import type {
  CanonicalHistoryEnvelope,
  CanonicalHistoryPublication,
} from '../../../../infra/file/canonical-history.js';

export type { CanonicalHistoryEnvelope, CanonicalHistoryPublication };
export {
  canonicalActiveHistoryRevision,
  canonicalHistoryRevision,
  inspectCanonicalHistorySequence,
  JsonlAppendCommitUncertainError,
  selectCanonicalHistorySource,
} from '../../../../infra/file/canonical-history.js';

export interface CanonicalHistoryFileAdapter {
  readTarget(path: string): Promise<readonly CanonicalHistoryEnvelope[] | undefined>;
  readTargetStrict(path: string): Promise<readonly CanonicalHistoryEnvelope[] | undefined>;
  readActive(path: string): Promise<readonly CanonicalHistoryEnvelope[]>;
  readActiveStrict(path: string): Promise<readonly CanonicalHistoryEnvelope[]>;
  readEnvelopesStrict(path: string): Promise<readonly CanonicalHistoryEnvelope[]>;
  readStrict(path: string): Promise<readonly CanonicalHistoryEnvelope[]>;
  publishInitial(
    path: string,
    records: readonly CanonicalHistoryEnvelope[],
  ): Promise<CanonicalHistoryPublication>;
  append(path: string, records: readonly CanonicalHistoryEnvelope[]): Promise<void>;
  replace(path: string, records: readonly CanonicalHistoryEnvelope[]): Promise<void>;
  replaceActive(path: string, records: readonly CanonicalHistoryEnvelope[]): Promise<void>;
  publishSnapshot(
    snapshotPath: string,
    records: readonly CanonicalHistoryEnvelope[],
  ): Promise<'published' | 'already-exists'>;
}
