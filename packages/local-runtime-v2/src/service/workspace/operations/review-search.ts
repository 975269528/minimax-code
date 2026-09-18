import type {
  WorkspaceReviewFile,
  WorkspaceReviewSearchResult,
  WorkspaceReviewUntrackedOmission,
} from '../contracts.js';
import { WorkspaceReviewSearchTooLargeError } from '../contracts.js';
import { gitStream } from './git-process.js';
import { readWorkspaceFile } from './workspace-path.js';

const REVIEW_SEARCH_UNTRACKED_BYTES_LIMIT = 64 * 1024 * 1024;
const REVIEW_SEARCH_UNTRACKED_CONCURRENCY = 8;
const REVIEW_SEARCH_PAGE_SIZE_LIMIT = 10;
const REVIEW_SEARCH_INDEX_ENTRY_BYTES = 16;
const REVIEW_SEARCH_SINGLE_INDEX_BYTES_LIMIT = 16 * 1024 * 1024;
const REVIEW_SEARCH_CACHE_BYTES_LIMIT = 64 * 1024 * 1024;
const REVIEW_SEARCH_CACHE_ENTRY_LIMIT = 8;

interface ResolvedReviewSearchInput {
  workspace: string;
  files: WorkspaceReviewFile[];
  reviewSnapshotId: string;
  diffArgs: string[];
  query: string;
  includeUntrackedFiles: boolean;
  pageIndex: number;
  pageSize: number;
  cacheKey: string;
  cache: WorkspaceReviewSearchIndexCache;
  untrackedFilesOmitted?: WorkspaceReviewUntrackedOmission;
  isFileTooLarge: (file: WorkspaceReviewFile) => boolean;
  signal?: AbortSignal;
}

interface IndexedReviewFile {
  file: WorkspaceReviewFile;
  fileIndex: number;
}

interface WorkspaceReviewSearchIndex {
  reviewSnapshotId: string;
  fileOrdinals: Uint32Array;
  matchCounts: Uint32Array;
  matchPrefixes: Float64Array;
  totalMatches: number;
  byteLength: number;
  untrackedFilesOmitted?: WorkspaceReviewUntrackedOmission;
}

class MatchedFileCollector {
  private readonly matchCounts: Uint32Array;
  private totalMatches = 0;

  constructor(fileCount: number) {
    const workingBytes = fileCount * Uint32Array.BYTES_PER_ELEMENT;
    if (workingBytes > REVIEW_SEARCH_SINGLE_INDEX_BYTES_LIMIT) {
      throw new WorkspaceReviewSearchTooLargeError('index');
    }
    this.matchCounts = new Uint32Array(fileCount);
  }

  record(fileIndex: number): void {
    const nextCount = (this.matchCounts[fileIndex] ?? 0) + 1;
    if (nextCount > 0xffffffff || !Number.isSafeInteger(this.totalMatches + 1)) {
      throw new WorkspaceReviewSearchTooLargeError('index');
    }
    this.matchCounts[fileIndex] = nextCount;
    this.totalMatches += 1;
  }

  finish(input: {
    reviewSnapshotId: string;
    untrackedFilesOmitted?: WorkspaceReviewUntrackedOmission;
  }): WorkspaceReviewSearchIndex {
    let matchedFileCount = 0;
    for (const count of this.matchCounts) {
      if (count > 0) matchedFileCount += 1;
    }
    const byteLength =
      matchedFileCount * REVIEW_SEARCH_INDEX_ENTRY_BYTES + Float64Array.BYTES_PER_ELEMENT;
    if (byteLength > REVIEW_SEARCH_SINGLE_INDEX_BYTES_LIMIT) {
      throw new WorkspaceReviewSearchTooLargeError('index');
    }
    const fileOrdinals = new Uint32Array(matchedFileCount);
    const matchCounts = new Uint32Array(matchedFileCount);
    const matchPrefixes = new Float64Array(matchedFileCount + 1);
    let targetIndex = 0;
    for (let fileIndex = 0; fileIndex < this.matchCounts.length; fileIndex += 1) {
      const count = this.matchCounts[fileIndex] ?? 0;
      if (count === 0) continue;
      fileOrdinals[targetIndex] = fileIndex;
      matchCounts[targetIndex] = count;
      matchPrefixes[targetIndex + 1] = (matchPrefixes[targetIndex] ?? 0) + count;
      targetIndex += 1;
    }
    return {
      reviewSnapshotId: input.reviewSnapshotId,
      fileOrdinals,
      matchCounts,
      matchPrefixes,
      totalMatches: this.totalMatches,
      byteLength,
      ...(input.untrackedFilesOmitted
        ? { untrackedFilesOmitted: input.untrackedFilesOmitted }
        : {}),
    };
  }
}

export class WorkspaceReviewSearchIndexCache {
  private readonly entries = new Map<string, WorkspaceReviewSearchIndex>();
  private totalBytes = 0;

  get(key: string): WorkspaceReviewSearchIndex | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: WorkspaceReviewSearchIndex): void {
    const existing = this.entries.get(key);
    if (existing) this.totalBytes -= existing.byteLength;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.totalBytes += entry.byteLength;
    while (
      this.entries.size > REVIEW_SEARCH_CACHE_ENTRY_LIMIT ||
      this.totalBytes > REVIEW_SEARCH_CACHE_BYTES_LIMIT
    ) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.totalBytes -= oldest?.byteLength ?? 0;
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }
}

export async function searchResolvedWorkspaceReviewDiffs(
  input: ResolvedReviewSearchInput,
): Promise<WorkspaceReviewSearchResult> {
  const needle = normalizeReviewSearchQuery(input.query);
  if (!needle) return emptySearchResult(input);

  let index = input.cache.get(input.cacheKey);
  if (!index) {
    const collector = new MatchedFileCollector(input.files.length);
    recordPathMatches(input, needle, collector);
    await searchTrackedPatch({
      workspace: input.workspace,
      args: withReviewSearchContext(input.diffArgs),
      filesByPath: buildTrackedFileLookup(input.files, input.isFileTooLarge),
      needle,
      collector,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (input.includeUntrackedFiles && !input.untrackedFilesOmitted) {
      await searchUntrackedFiles({
        workspace: input.workspace,
        files: input.files,
        needle,
        collector,
        isFileTooLarge: input.isFileTooLarge,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }
    throwIfSearchAborted(input.signal);
    index = collector.finish({
      reviewSnapshotId: input.reviewSnapshotId,
      ...(input.untrackedFilesOmitted
        ? { untrackedFilesOmitted: input.untrackedFilesOmitted }
        : {}),
    });
    input.cache.set(input.cacheKey, index);
  }
  return pageSearchIndex(index, input.files, input.pageIndex, input.pageSize);
}

function withReviewSearchContext(args: string[]): string[] {
  let replaced = false;
  const result = args.map((arg) => {
    if (!arg.startsWith('--unified=')) return arg;
    replaced = true;
    return '--unified=3';
  });
  if (replaced) return result;
  const separatorIndex = result.indexOf('--');
  result.splice(separatorIndex >= 0 ? separatorIndex : result.length, 0, '--unified=3');
  return result;
}

function emptySearchResult(input: ResolvedReviewSearchInput): WorkspaceReviewSearchResult {
  return {
    reviewSnapshotId: input.reviewSnapshotId,
    matchedFiles: [],
    totalMatches: 0,
    totalMatchedFiles: 0,
    pageIndex: 0,
    pageSize: normalizePageSize(input.pageSize),
    matchesBeforePage: 0,
    hasPreviousPage: false,
    hasNextPage: false,
    ...(input.untrackedFilesOmitted ? { untrackedFilesOmitted: input.untrackedFilesOmitted } : {}),
  };
}

function pageSearchIndex(
  index: WorkspaceReviewSearchIndex,
  files: WorkspaceReviewFile[],
  requestedPageIndex: number,
  requestedPageSize: number,
): WorkspaceReviewSearchResult {
  const pageSize = normalizePageSize(requestedPageSize);
  const totalMatchedFiles = index.fileOrdinals.length;
  const pageCount = Math.ceil(totalMatchedFiles / pageSize);
  const pageIndex = pageCount === 0 ? 0 : Math.min(Math.max(0, requestedPageIndex), pageCount - 1);
  const start = pageIndex * pageSize;
  const end = Math.min(totalMatchedFiles, start + pageSize);
  const matchedFiles = [];
  for (let matchedIndex = start; matchedIndex < end; matchedIndex += 1) {
    const fileOrdinal = index.fileOrdinals[matchedIndex];
    const file = fileOrdinal === undefined ? undefined : files[fileOrdinal];
    if (!file) continue;
    matchedFiles.push({
      fileId: file.fileId,
      path: file.path,
      matchCount: index.matchCounts[matchedIndex] ?? 0,
    });
  }
  return {
    reviewSnapshotId: index.reviewSnapshotId,
    matchedFiles,
    totalMatches: index.totalMatches,
    totalMatchedFiles,
    pageIndex,
    pageSize,
    matchesBeforePage: index.matchPrefixes[start] ?? 0,
    hasPreviousPage: pageIndex > 0,
    hasNextPage: pageIndex + 1 < pageCount,
    ...(index.untrackedFilesOmitted ? { untrackedFilesOmitted: index.untrackedFilesOmitted } : {}),
  };
}

function normalizePageSize(pageSize: number): number {
  return Math.min(REVIEW_SEARCH_PAGE_SIZE_LIMIT, Math.max(1, Math.trunc(pageSize)));
}

function buildTrackedFileLookup(
  files: WorkspaceReviewFile[],
  isFileTooLarge: (file: WorkspaceReviewFile) => boolean,
): Map<string, IndexedReviewFile> {
  const lookup = new Map<string, IndexedReviewFile>();
  for (const [fileIndex, file] of files.entries()) {
    if (file.untracked || file.type === 'binary' || isFileTooLarge(file)) continue;
    const indexed = { file, fileIndex };
    lookup.set(file.path, indexed);
    if (file.originalPath) lookup.set(file.originalPath, indexed);
  }
  return lookup;
}

function recordPathMatches(
  input: ResolvedReviewSearchInput,
  needle: string,
  collector: MatchedFileCollector,
): void {
  for (const [fileIndex, file] of input.files.entries()) {
    if (file.untracked && !input.includeUntrackedFiles) continue;
    recordTextMatches(file.path, needle, () => collector.record(fileIndex));
  }
}

interface UntrackedSearchInput {
  workspace: string;
  files: WorkspaceReviewFile[];
  needle: string;
  collector: MatchedFileCollector;
  isFileTooLarge: (file: WorkspaceReviewFile) => boolean;
  signal?: AbortSignal;
}

interface MutableUntrackedSearchContext {
  workspace: string;
  needle: string;
  collector: MatchedFileCollector;
  unreservedBytesRemaining: number;
  signal?: AbortSignal;
}

async function searchUntrackedFiles(input: UntrackedSearchInput): Promise<void> {
  const { candidates, reservedBytes } = collectUntrackedCandidates(input);
  if (candidates.length === 0) return;

  let cursor = 0;
  let failures = 0;
  let lastFailure: unknown;
  const context: MutableUntrackedSearchContext = {
    workspace: input.workspace,
    needle: input.needle,
    collector: input.collector,
    unreservedBytesRemaining: REVIEW_SEARCH_UNTRACKED_BYTES_LIMIT - reservedBytes,
    ...(input.signal ? { signal: input.signal } : {}),
  };
  const worker = async () => {
    while (cursor < candidates.length) {
      throwIfSearchAborted(input.signal);
      const candidate = candidates[cursor];
      cursor += 1;
      if (!candidate) return;
      try {
        await searchUntrackedCandidate(candidate, context);
      } catch (error) {
        if (isSearchAbort(error, input.signal)) throw error;
        failures += 1;
        lastFailure = error;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(REVIEW_SEARCH_UNTRACKED_CONCURRENCY, candidates.length) },
      worker,
    ),
  );
  if (failures === candidates.length) throwUntrackedSearchFailure(lastFailure);
}

function collectUntrackedCandidates(input: UntrackedSearchInput): {
  candidates: IndexedReviewFile[];
  reservedBytes: number;
} {
  const candidates: IndexedReviewFile[] = [];
  let reservedBytes = 0;
  for (const [fileIndex, file] of input.files.entries()) {
    if (file.untracked !== true || file.type === 'binary' || input.isFileTooLarge(file)) continue;
    const size = file.changedBytes ?? 0;
    if (reservedBytes + size > REVIEW_SEARCH_UNTRACKED_BYTES_LIMIT) break;
    reservedBytes += size;
    candidates.push({ file, fileIndex });
  }
  return { candidates, reservedBytes };
}

function throwUntrackedSearchFailure(lastFailure: unknown): never {
  throw lastFailure instanceof Error
    ? lastFailure
    : new Error('Unable to search untracked review files');
}

async function searchUntrackedCandidate(
  candidate: IndexedReviewFile,
  context: MutableUntrackedSearchContext,
): Promise<void> {
  const content = await readWorkspaceFile(context.workspace, candidate.file.path);
  throwIfSearchAborted(context.signal);
  if (content.type !== 'text') return;
  if (candidate.file.changedBytes === undefined) {
    const actualBytes = Buffer.byteLength(content.content);
    if (actualBytes > context.unreservedBytesRemaining) return;
    context.unreservedBytesRemaining -= actualBytes;
  }
  throwIfSearchAborted(context.signal);
  recordUntrackedContentMatches({
    candidate,
    content: content.content,
    needle: context.needle,
    collector: context.collector,
    ...(context.signal ? { signal: context.signal } : {}),
  });
}

interface UntrackedContentInput {
  candidate: IndexedReviewFile;
  content: string;
  needle: string;
  collector: MatchedFileCollector;
  signal?: AbortSignal;
}

function recordUntrackedContentMatches(input: UntrackedContentInput): void {
  const lines = input.content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    throwIfSearchAborted(input.signal);
    const line = lines[index] ?? '';
    recordTextMatches(line, input.needle, () => input.collector.record(input.candidate.fileIndex));
  }
}

interface TrackedPatchSearchInput {
  workspace: string;
  args: string[];
  filesByPath: ReadonlyMap<string, IndexedReviewFile>;
  needle: string;
  collector: MatchedFileCollector;
  signal?: AbortSignal;
}

interface PatchSearchState {
  current?: IndexedReviewFile;
  oldLine: number;
  newLine: number;
  rowIndex: number;
}

interface PatchLineLocation {
  kind: 'context' | 'addition' | 'deletion';
  side: 'old' | 'new';
  line: number;
}

async function searchTrackedPatch(input: TrackedPatchSearchInput): Promise<void> {
  let pending = '';
  const state: PatchSearchState = { oldLine: 0, newLine: 0, rowIndex: 0 };
  const consumeLine = (line: string) => consumeTrackedPatchLine(line, state, input);
  const result = await gitStream(input.args, input.workspace, {
    ...(input.signal ? { signal: input.signal } : {}),
    onStdout: (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
    },
  });
  if (pending) consumeLine(pending);
  if (result.code !== 0) throw new Error(result.stderr || 'Unable to search review diff');
}

function consumeTrackedPatchLine(
  line: string,
  state: PatchSearchState,
  input: TrackedPatchSearchInput,
): void {
  if (updatePatchFileContext(line, state, input.filesByPath)) return;
  const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
  if (hunk) {
    state.oldLine = Number.parseInt(hunk[1] ?? '0', 10);
    state.newLine = Number.parseInt(hunk[2] ?? '0', 10);
    return;
  }
  const current = state.current;
  if (!current || line.startsWith('--- ')) return;
  const location = advancePatchLine(line, state);
  if (!location) return;
  const text = line.slice(1);
  state.rowIndex += 1;
  recordTextMatches(text, input.needle, () => input.collector.record(current.fileIndex));
}

function updatePatchFileContext(
  line: string,
  state: PatchSearchState,
  filesByPath: ReadonlyMap<string, IndexedReviewFile>,
): boolean {
  if (line.startsWith('diff --git')) {
    state.current = undefined;
    state.rowIndex = 0;
    return true;
  }
  if (line.startsWith('--- a/')) {
    state.current = filesByPath.get(line.slice(6));
    state.rowIndex = 0;
    return true;
  }
  if (line.startsWith('+++ b/')) {
    state.current = filesByPath.get(line.slice(6));
    state.rowIndex = 0;
    return true;
  }
  return false;
}

function advancePatchLine(line: string, state: PatchSearchState): PatchLineLocation | undefined {
  if (line.startsWith('+')) {
    const location = { kind: 'addition' as const, side: 'new' as const, line: state.newLine };
    state.newLine += 1;
    return location;
  }
  if (line.startsWith('-')) {
    const location = { kind: 'deletion' as const, side: 'old' as const, line: state.oldLine };
    state.oldLine += 1;
    return location;
  }
  if (!line.startsWith(' ')) return undefined;
  const location = { kind: 'context' as const, side: 'new' as const, line: state.newLine };
  state.oldLine += 1;
  state.newLine += 1;
  return location;
}

function recordTextMatches(
  text: string,
  needle: string,
  record: (startColumn: number, endColumn: number) => void,
): void {
  const haystack = foldSearchText(text);
  let previousStart = -1;
  let previousEnd = -1;
  for (let from = 0; from <= haystack.value.length - needle.length; ) {
    const index = haystack.value.indexOf(needle, from);
    if (index < 0) break;
    const first = haystack.sourceRanges[index];
    const last = haystack.sourceRanges[index + needle.length - 1];
    if (first && last && (first.start !== previousStart || last.end !== previousEnd)) {
      previousStart = first.start;
      previousEnd = last.end;
      record(first.start, last.end);
    }
    from = index + needle.length;
  }
}

export function normalizeReviewSearchQuery(query: string): string {
  return foldSearchText(query.trim()).value;
}

function foldSearchText(value: string): {
  value: string;
  sourceRanges: Array<{ start: number; end: number }>;
} {
  let folded = '';
  let sourceOffset = 0;
  const sourceRanges: Array<{ start: number; end: number }> = [];
  for (const codePoint of value) {
    const start = sourceOffset;
    sourceOffset += codePoint.length;
    const lower = codePoint.toLowerCase();
    folded += lower;
    for (let index = 0; index < lower.length; index += 1) {
      sourceRanges.push({ start, end: sourceOffset });
    }
  }
  return { value: folded, sourceRanges };
}

function throwIfSearchAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Review search aborted');
  error.name = 'AbortError';
  throw error;
}

function isSearchAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}
