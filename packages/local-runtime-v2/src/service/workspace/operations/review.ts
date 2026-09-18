import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import type {
  GitChangedFile,
  GitChangesBase,
  GitChangesValue,
  GitMetadataValue,
  ScopedGitChangeScope,
  WorkspaceReviewCommit,
  WorkspaceReviewCommitList,
  WorkspaceReviewFile,
  WorkspaceReviewFileContent,
  WorkspaceReviewFileDiff,
  WorkspaceReviewSearchResult,
  WorkspaceReviewSource,
  WorkspaceReviewSummary,
  WorkspaceReviewUntrackedOmission,
} from '../contracts.js';
import { WorkspaceGitSnapshotChangedError } from '../contracts.js';
import type { WorkspaceGitSnapshotManager } from '../snapshot/snapshot-manager.js';
import { getWorkspaceFileDiff } from './diffs.js';
import { git, gitStream } from './git-process.js';
import { readWorkspaceFile, resolveWorkspacePath } from './workspace-path.js';
import {
  normalizeReviewSearchQuery,
  searchResolvedWorkspaceReviewDiffs,
  type WorkspaceReviewSearchIndexCache,
} from './review-search.js';

type SnapshotManager = WorkspaceGitSnapshotManager<
  GitChangesBase,
  GitChangesValue,
  GitMetadataValue
>;

interface ResolvedReview {
  summary: WorkspaceReviewSummary;
  diffArgs: string[];
  oldRevision?: string;
  newRevision?: string;
}

interface NameStatusEntry {
  path: string;
  originalPath?: string;
  status: GitChangedFile['status'];
}

interface DiffMetric {
  additions: number;
  deletions: number;
  binary: boolean;
}

interface ExpectedReviewInput {
  manager: SnapshotManager;
  workspace: string;
  source: WorkspaceReviewSource;
  expectedSnapshotId: string;
}

interface ReviewDiffListInput extends ExpectedReviewInput {
  fileIds?: string[];
}

interface ReviewFileContentInput extends ExpectedReviewInput {
  targetFileId: string;
  side: 'old' | 'new';
}

interface ReviewSearchInput extends ExpectedReviewInput {
  query: string;
  includeUntrackedFiles: boolean;
  pageIndex: number;
  pageSize: number;
  cache: WorkspaceReviewSearchIndexCache;
  signal?: AbortSignal;
}

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const REVIEW_UNTRACKED_FILE_LIMIT = 256;
const REVIEW_BATCH_FILE_LIMIT = 5;
const REVIEW_SMALL_FILE_LIMIT = 128;
const REVIEW_TOTAL_CHANGED_LINES_LIMIT = 9_000;
const REVIEW_TOTAL_CHANGED_BYTES_LIMIT = 12 * 1024 * 1024;
const REVIEW_SINGLE_CHANGED_LINES_LIMIT = 15_000;
const REVIEW_SINGLE_PATCH_BYTES_LIMIT = 3 * 1024 * 1024;
const REVIEW_SINGLE_LINE_BYTES_LIMIT = 1024 * 1024;

export async function listWorkspaceReviewCommits(
  workspace: string,
  baseRef: string,
  query = '',
  requestedLimit = 10,
): Promise<WorkspaceReviewCommitList> {
  const limit = Math.max(1, Math.min(50, Math.trunc(requestedLimit)));
  const headCommit = await resolveCommit(workspace, 'HEAD');
  const baseCommit = await resolveCommit(workspace, baseRef);
  const mergeBase = await requireStdout(
    git(['merge-base', baseCommit, headCommit], workspace),
    'Unable to resolve review merge base',
  );
  const range = `${mergeBase}..${headCommit}`;
  const totalCountRaw = await requireStdout(
    git(['rev-list', '--count', range], workspace),
    'Unable to count review commits',
  );
  const totalCount = Number.parseInt(totalCountRaw, 10) || 0;
  const normalizedQuery = query.trim();
  const format = '%H%x00%P%x00%ct%x00%an%x00%s%x00%B%x00';
  const args = ['log', `--max-count=${limit}`, `--format=${format}`];
  if (normalizedQuery) {
    args.push('--fixed-strings', '--regexp-ignore-case', `--grep=${normalizedQuery}`);
  }
  args.push(range);
  const log = await git(args, workspace);
  if (log.code !== 0) throw new Error(log.stderr || 'Unable to list review commits');
  const items = parseCommitLog(log.stdout);

  if (/^[0-9a-f]{4,40}$/iu.test(normalizedQuery)) {
    const sha = await resolveOptionalCommit(workspace, normalizedQuery);
    if (sha && (await isCommitInRange(workspace, mergeBase, headCommit, sha))) {
      const exact = await readCommit(workspace, sha);
      if (exact && !items.some((item) => item.sha === exact.sha)) items.unshift(exact);
    }
  }

  const bounded = items.slice(0, limit);
  await Promise.all(bounded.map((item) => enrichCommitStats(workspace, item)));
  return { baseCommit: mergeBase, headCommit, totalCount, items: bounded };
}

export async function getWorkspaceReviewSummary(
  manager: SnapshotManager,
  workspace: string,
  source: WorkspaceReviewSource,
): Promise<WorkspaceReviewSummary> {
  return (await resolveReview(manager, workspace, source)).summary;
}

export async function listWorkspaceReviewFileDiffs(
  input: ReviewDiffListInput,
): Promise<{ reviewSnapshotId: string; diffs: WorkspaceReviewFileDiff[] }> {
  const resolved = await resolveExpectedReview(input);
  const requested = resolveRequestedFiles(resolved.summary, input.fileIds);
  const diffs = await Promise.all(
    requested.map(async (file): Promise<WorkspaceReviewFileDiff> => {
      try {
        const diff = await buildReviewFileDiff(input.manager, input.workspace, resolved, file);
        return { fileId: file.fileId, diff };
      } catch (error) {
        return {
          fileId: file.fileId,
          errorCode: 'REVIEW_FILE_DIFF_FAILED',
          error: describeError(error),
        };
      }
    }),
  );
  return { reviewSnapshotId: resolved.summary.reviewSnapshotId, diffs };
}

export async function getWorkspaceReviewFileContent(
  input: ReviewFileContentInput,
): Promise<WorkspaceReviewFileContent> {
  const resolved = await resolveExpectedReview(input);
  const file = resolved.summary.files.find((candidate) => candidate.fileId === input.targetFileId);
  if (!file) throw new Error(`Unknown review file id: ${input.targetFileId}`);
  const path = input.side === 'old' ? (file.originalPath ?? file.path) : file.path;
  const content = await readReviewSide(input.workspace, resolved, file, input.side);
  return { fileId: input.targetFileId, path, side: input.side, ...content };
}

export async function searchWorkspaceReviewDiffs(
  input: ReviewSearchInput,
): Promise<WorkspaceReviewSearchResult> {
  const resolved = await resolveExpectedReview(input);
  return searchResolvedWorkspaceReviewDiffs({
    workspace: input.workspace,
    files: resolved.summary.files,
    reviewSnapshotId: resolved.summary.reviewSnapshotId,
    diffArgs: resolved.diffArgs,
    query: input.query,
    includeUntrackedFiles: input.includeUntrackedFiles,
    pageIndex: input.pageIndex,
    pageSize: input.pageSize,
    cache: input.cache,
    cacheKey: [
      input.workspace,
      resolved.summary.reviewSnapshotId,
      normalizeReviewSearchQuery(input.query),
      input.includeUntrackedFiles ? 'untracked' : 'tracked',
    ].join('\0'),
    isFileTooLarge: isReviewFileTooLarge,
    ...(resolved.summary.untrackedFilesOmitted
      ? { untrackedFilesOmitted: resolved.summary.untrackedFilesOmitted }
      : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

async function resolveReview(
  manager: SnapshotManager,
  workspace: string,
  source: WorkspaceReviewSource,
): Promise<ResolvedReview> {
  if (source.type === 'workspace') {
    const repositoryId = await resolveRepositoryId(workspace);
    return resolveWorkspaceReview(manager, workspace, source, repositoryId);
  }

  const [repositoryId, headCommit] = await Promise.all([
    resolveRepositoryId(workspace),
    resolveCommit(workspace, 'HEAD'),
  ]);
  if (source.type === 'commit') {
    return resolveCommitReview(workspace, source, repositoryId, headCommit);
  }

  return resolveBranchReview(manager, workspace, source, { repositoryId, headCommit });
}

async function resolveWorkspaceReview(
  manager: SnapshotManager,
  workspace: string,
  source: WorkspaceReviewSource & { type: 'workspace' },
  repositoryId: string,
): Promise<ResolvedReview> {
  // Review applies its own 256-file untracked guard before reading file
  // contents. Reusing the full Git status projection would eagerly count
  // every untracked file's lines and defeat that protection.
  const snapshot = await manager.getChanges(workspace, 'fast');
  const headCommit = await resolveOptionalCommit(workspace, 'HEAD');
  const untracked = await listUntrackedPaths(workspace);
  const omission = omissionFor(untracked.count);
  const files = await buildWorkspaceFiles({
    workspace,
    changedFiles: snapshot.value.changes.files,
    untrackedPaths: new Set(untracked.paths),
    revisionSeed: snapshot.snapshotId,
    headRevision: headCommit ?? EMPTY_TREE_SHA,
  });
  const diffArgs = headCommit
    ? ['diff', '--no-ext-diff', '--unified=3', headCommit, '--']
    : ['diff', '--no-ext-diff', '--unified=3', '--cached', EMPTY_TREE_SHA, '--'];
  const summary = buildSummary({
    repositoryId,
    source,
    files,
    workspaceSnapshotId: snapshot.snapshotId,
    ...(headCommit ? { headCommit } : {}),
    ...(omission ? { omission } : {}),
  });
  return { summary, diffArgs, oldRevision: headCommit ?? EMPTY_TREE_SHA };
}

async function resolveCommitReview(
  workspace: string,
  source: WorkspaceReviewSource & { type: 'commit' },
  repositoryId: string,
  headCommit: string,
): Promise<ResolvedReview> {
  const commitSha = await resolveCommit(workspace, source.commitSha);
  const selectedBase = await resolveCommit(workspace, source.baseRef);
  const mergeBase = await requireStdout(
    git(['merge-base', selectedBase, headCommit], workspace),
    'Unable to resolve review merge base',
  );
  if (!(await isCommitInRange(workspace, mergeBase, headCommit, commitSha))) {
    throw new Error('Selected commit is outside the current branch review range');
  }
  const parent = await firstParent(workspace, commitSha);
  const oldRevision = parent ?? EMPTY_TREE_SHA;
  const files = await buildRangeFiles(
    workspace,
    ['diff', '--no-ext-diff', '-M', oldRevision, commitSha, '--'],
    `commit:${oldRevision}:${commitSha}`,
  );
  const summary = buildSummary({
    repositoryId,
    source: { ...source, commitSha },
    files,
    baseCommit: oldRevision,
    headCommit: commitSha,
  });
  return {
    summary,
    diffArgs: ['diff', '--no-ext-diff', '--unified=3', oldRevision, commitSha, '--'],
    oldRevision,
    newRevision: commitSha,
  };
}

async function resolveBranchReview(
  manager: SnapshotManager,
  workspace: string,
  source: WorkspaceReviewSource & { type: 'branch' },
  revisions: { repositoryId: string; headCommit: string },
): Promise<ResolvedReview> {
  const [baseCommit, workspaceSnapshot, untracked] = await Promise.all([
    resolveCommit(workspace, source.baseRef),
    manager.getChanges(workspace, 'fast'),
    listUntrackedPaths(workspace),
  ]);
  const mergeBase = await requireStdout(
    git(['merge-base', baseCommit, revisions.headCommit], workspace),
    'Unable to resolve review merge base',
  );
  const omission = omissionFor(untracked.count);
  const includedUntracked = untracked.paths;
  const files = await buildRangeFiles(
    workspace,
    ['diff', '--no-ext-diff', '-M', mergeBase, '--'],
    `branch:${mergeBase}:${revisions.headCommit}:${workspaceSnapshot.snapshotId}`,
    includedUntracked,
  );
  const summary = buildSummary({
    repositoryId: revisions.repositoryId,
    source,
    files,
    baseCommit: mergeBase,
    headCommit: revisions.headCommit,
    workspaceSnapshotId: workspaceSnapshot.snapshotId,
    ...(omission ? { omission } : {}),
  });
  return {
    summary,
    diffArgs: ['diff', '--no-ext-diff', '--unified=3', mergeBase, '--'],
    oldRevision: mergeBase,
  };
}

async function resolveExpectedReview(input: ExpectedReviewInput): Promise<ResolvedReview> {
  const resolved = await resolveReview(input.manager, input.workspace, input.source);
  if (resolved.summary.reviewSnapshotId !== input.expectedSnapshotId) {
    throw new WorkspaceGitSnapshotChangedError(resolved.summary.reviewSnapshotId);
  }
  return resolved;
}

function buildSummary(input: {
  repositoryId: string;
  source: WorkspaceReviewSource;
  files: WorkspaceReviewFile[];
  baseCommit?: string;
  headCommit?: string;
  workspaceSnapshotId?: string;
  omission?: WorkspaceReviewUntrackedOmission;
}): WorkspaceReviewSummary {
  const totals = {
    files: input.files.length,
    additions: input.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: input.files.reduce((sum, file) => sum + file.deletions, 0),
    changedBytes: input.files.reduce((sum, file) => sum + (file.changedBytes ?? 0), 0),
  };
  const reviewSnapshotId = hash([
    input.repositoryId,
    JSON.stringify(input.source),
    input.baseCommit ?? '',
    input.headCommit ?? '',
    input.workspaceSnapshotId ?? '',
    input.omission ? `${input.omission.count}/${input.omission.limit}` : '',
  ]);
  return {
    repositoryId: input.repositoryId,
    reviewSnapshotId,
    source: input.source,
    files: input.files,
    totals,
    ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
    ...(input.headCommit ? { headCommit: input.headCommit } : {}),
    ...(input.workspaceSnapshotId ? { workspaceSnapshotId: input.workspaceSnapshotId } : {}),
    ...(input.omission ? { untrackedFilesOmitted: input.omission } : {}),
  };
}

async function buildWorkspaceFiles(input: {
  workspace: string;
  changedFiles: GitChangedFile[];
  untrackedPaths: ReadonlySet<string>;
  revisionSeed: string;
  headRevision: string;
}): Promise<WorkspaceReviewFile[]> {
  const filtered = input.changedFiles.filter(
    (file) =>
      !(file.status === 'added' && file.changeScope === 'unstaged') ||
      input.untrackedPaths.has(file.path) ||
      !isPotentialUntracked(file),
  );
  const files = filtered.map((file) => ({
    fileId: fileId(file.path, file.changeScope, file.originalPath),
    path: file.path,
    ...(file.originalPath ? { originalPath: file.originalPath } : {}),
    status: file.status,
    ...(file.changeScope ? { changeScope: file.changeScope } : {}),
    revision: hash([
      input.revisionSeed,
      file.path,
      file.originalPath ?? '',
      file.changeScope ?? 'all',
    ]),
    additions: file.additions,
    deletions: file.deletions,
    ...(input.untrackedPaths.has(file.path) ? { untracked: true } : {}),
  }));
  await enrichUntrackedMetrics(input.workspace, files);
  await enrichWorkspacePatchMetrics(input.workspace, input.headRevision, files);
  await enrichGeneratedPaths(input.workspace, files);
  return files;
}

function isPotentialUntracked(file: GitChangedFile): boolean {
  return file.status === 'added' && file.changeScope === 'unstaged';
}

async function buildRangeFiles(
  workspace: string,
  baseDiffArgs: string[],
  revisionSeed: string,
  untrackedPaths: string[] = [],
): Promise<WorkspaceReviewFile[]> {
  const [nameStatus, numstat] = await Promise.all([
    git(withDiffOption(baseDiffArgs, '--name-status', '-z'), workspace),
    git(withDiffOption(baseDiffArgs, '--numstat', '-z'), workspace),
  ]);
  if (nameStatus.code !== 0) throw new Error(nameStatus.stderr || 'Unable to list review files');
  if (numstat.code !== 0) throw new Error(numstat.stderr || 'Unable to read review stats');
  const metrics = parseNumstat(numstat.stdout);
  const files: WorkspaceReviewFile[] = parseNameStatus(nameStatus.stdout).map((entry) => {
    const metric = metrics.get(entry.path) ?? { additions: 0, deletions: 0, binary: false };
    return {
      fileId: fileId(entry.path, undefined, entry.originalPath),
      path: entry.path,
      ...(entry.originalPath ? { originalPath: entry.originalPath } : {}),
      status: entry.status,
      revision: hash([
        revisionSeed,
        entry.path,
        entry.originalPath ?? '',
        `${metric.additions}`,
        `${metric.deletions}`,
      ]),
      ...(metric.binary ? { type: 'binary' as const } : {}),
      additions: metric.additions,
      deletions: metric.deletions,
    };
  });
  for (const path of untrackedPaths) {
    files.push({
      fileId: fileId(path),
      path,
      status: 'added',
      revision: hash([revisionSeed, path, 'untracked']),
      additions: 0,
      deletions: 0,
      untracked: true,
    });
  }
  await Promise.all([
    enrichUntrackedMetrics(workspace, files),
    enrichGeneratedPaths(workspace, files),
  ]);
  return files;
}

async function enrichWorkspacePatchMetrics(
  workspace: string,
  headRevision: string,
  files: WorkspaceReviewFile[],
): Promise<void> {
  for (const scope of ['staged', 'unstaged'] as const) {
    await enrichWorkspaceScopePatchMetrics(workspace, headRevision, files, scope);
  }
}

async function enrichWorkspaceScopePatchMetrics(
  workspace: string,
  headRevision: string,
  files: WorkspaceReviewFile[],
  scope: ScopedGitChangeScope,
): Promise<void> {
  const candidates = files.filter((file) => !file.untracked && file.changeScope === scope);
  if (candidates.length === 0) return;
  const baseArgs =
    scope === 'staged'
      ? ['diff', '--no-ext-diff', '--cached', headRevision, '--']
      : ['diff', '--no-ext-diff', '--'];
  const [names, numstat, patch] = await Promise.all([
    git(withDiffOption(baseArgs, '--name-status', '-z'), workspace),
    git(withDiffOption(baseArgs, '--numstat', '-z'), workspace),
    git(withDiffOption(baseArgs, '--patch', '--unified=0'), workspace),
  ]);
  if (names.code !== 0 || numstat.code !== 0 || patch.code !== 0) {
    const first = candidates[0];
    if (first) first.changedBytes = REVIEW_TOTAL_CHANGED_BYTES_LIMIT + 1;
    return;
  }
  applyWorkspacePatchMetrics(candidates, names.stdout, numstat.stdout, patch.stdout);
}

function applyWorkspacePatchMetrics(
  candidates: WorkspaceReviewFile[],
  names: string,
  numstat: string,
  patch: string,
): void {
  const entries = parseNameStatus(names);
  const metrics = parseNumstat(numstat);
  const blocks = patch.split(/(?=^diff --git )/mu).filter(Boolean);
  const byPath = new Map(candidates.map((file) => [file.path, file]));
  for (let index = 0; index < Math.min(entries.length, blocks.length); index += 1) {
    const file = byPath.get(entries[index]?.path ?? '');
    const block = blocks[index];
    if (!file || block === undefined) continue;
    applyPatchMetric(file, block, metrics.get(file.path));
  }
}

function applyPatchMetric(file: WorkspaceReviewFile, block: string, metric?: DiffMetric): void {
  if (metric) {
    file.additions = metric.additions;
    file.deletions = metric.deletions;
    if (metric.binary) file.type = 'binary';
  }
  file.changedBytes = Buffer.byteLength(block);
  file.maxChangedLineBytes = maxChangedLineBytes(block);
  file.revision = hash([file.revision, block]);
  if (/^Binary files /mu.test(block) || /\nGIT binary patch\n/u.test(block)) file.type = 'binary';
}

async function enrichUntrackedMetrics(
  workspace: string,
  files: WorkspaceReviewFile[],
): Promise<void> {
  await Promise.all(
    files
      .filter((file) => file.untracked)
      .map(async (file) => {
        const absolute = await resolveWorkspacePath(workspace, file.path);
        if (!absolute) return;
        const info = await optionalStat(absolute);
        if (!info?.isFile()) return;
        file.changedBytes = info.size;
        const content = await readWorkspaceFile(workspace, file.path);
        if (content.type !== 'text') {
          file.type = 'binary';
          file.revision = hash([file.revision, `${info.size}`]);
          return;
        }
        file.revision = hash([file.revision, content.content]);
        const lines = content.content.split('\n');
        if (lines.at(-1) === '') lines.pop();
        file.additions = lines.length;
        file.maxChangedLineBytes = lines.reduce(
          (maximum, line) => Math.max(maximum, Buffer.byteLength(line)),
          0,
        );
      }),
  );
}

async function optionalStat(path: string) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function enrichGeneratedPaths(
  workspace: string,
  files: WorkspaceReviewFile[],
): Promise<void> {
  if (files.length === 0) return;
  const result = await git(
    ['check-attr', '-z', 'linguist-generated', '--', ...files.map((file) => file.path)],
    workspace,
  );
  if (result.code !== 0) return;
  const parts = result.stdout.split('\0');
  const generated = new Set<string>();
  for (let index = 0; index + 2 < parts.length; index += 3) {
    if (parts[index + 2] === 'set' || parts[index + 2] === 'true')
      generated.add(parts[index] ?? '');
  }
  for (const file of files) if (generated.has(file.path)) file.generated = true;
}

async function buildReviewFileDiff(
  manager: SnapshotManager,
  workspace: string,
  resolved: ResolvedReview,
  file: WorkspaceReviewFile,
) {
  if (isReviewFileTooLarge(file)) return buildTooLargeDiff(file);
  if (resolved.summary.source.type === 'workspace') {
    const diff = await getWorkspaceFileDiff(manager, workspace, file.path, {
      ...(file.changeScope ? { scope: file.changeScope } : {}),
      ...(resolved.summary.workspaceSnapshotId
        ? { snapshotId: resolved.summary.workspaceSnapshotId }
        : {}),
      lean: true,
    });
    return {
      ...diff,
      file: file.path,
      ...(file.originalPath ? { originalPath: file.originalPath } : {}),
      additions: file.additions,
      deletions: file.deletions,
      status: file.status,
      ...(file.changeScope ? { changeScope: file.changeScope } : {}),
    };
  }
  if (file.untracked) return buildUntrackedFileDiff(workspace, file);
  return buildRangeReviewFileDiff(workspace, resolved, file);
}

function isReviewFileTooLarge(file: WorkspaceReviewFile): boolean {
  return (
    file.additions + file.deletions > REVIEW_SINGLE_CHANGED_LINES_LIMIT ||
    (file.changedBytes ?? 0) > REVIEW_SINGLE_PATCH_BYTES_LIMIT ||
    (file.maxChangedLineBytes ?? 0) > REVIEW_SINGLE_LINE_BYTES_LIMIT
  );
}

function buildTooLargeDiff(file: WorkspaceReviewFile) {
  return {
    type: file.type ?? 'text',
    content: '',
    file: file.path,
    ...(file.originalPath ? { originalPath: file.originalPath } : {}),
    additions: file.additions,
    deletions: file.deletions,
    status: file.status,
    previewState: 'too_large' as const,
  };
}

async function buildUntrackedFileDiff(workspace: string, file: WorkspaceReviewFile) {
  const content = await readWorkspaceFile(workspace, file.path);
  if (content.type === 'binary') {
    return { type: 'binary' as const, content: '', previewState: 'binary' as const };
  }
  return {
    type: 'text' as const,
    content: '',
    file: file.path,
    additions: file.additions,
    deletions: 0,
    status: 'added' as const,
    diff: addedFilePatch(file.path, content.content),
    previewState: 'ready' as const,
  };
}

async function buildRangeReviewFileDiff(
  workspace: string,
  resolved: ResolvedReview,
  file: WorkspaceReviewFile,
) {
  const args = [...resolved.diffArgs.slice(0, -1), '--', file.path];
  const result = await git(args, workspace);
  if (result.code !== 0) throw new Error(result.stderr || `Unable to diff ${file.path}`);
  const patchMetrics = {
    ...file,
    changedBytes: Buffer.byteLength(result.stdout),
    maxChangedLineBytes: maxChangedLineBytes(result.stdout),
  };
  if (isReviewFileTooLarge(patchMetrics)) return buildTooLargeDiff(patchMetrics);
  return {
    type: file.type ?? 'text',
    content: '',
    file: file.path,
    ...(file.originalPath ? { originalPath: file.originalPath } : {}),
    additions: file.additions,
    deletions: file.deletions,
    status: file.status,
    ...(result.stdout
      ? { diff: result.stdout, previewState: 'ready' as const }
      : { previewState: 'no_diff' as const }),
  };
}

async function readReviewSide(
  workspace: string,
  resolved: ResolvedReview,
  file: WorkspaceReviewFile,
  side: 'old' | 'new',
) {
  if (file.untracked) return readUntrackedReviewSide(workspace, file.path, side);
  if (isAbsentReviewSide(file, side)) return emptyReviewContent();
  if (resolved.summary.source.type === 'workspace') {
    return readWorkspaceReviewSide(workspace, resolved, file, side);
  }
  if (side === 'new' && resolved.summary.source.type === 'branch') {
    return readWorkspaceFile(workspace, file.path);
  }
  return readRevisionReviewSide(workspace, resolved, file, side);
}

function readUntrackedReviewSide(workspace: string, path: string, side: 'old' | 'new') {
  if (side === 'new') return readWorkspaceFile(workspace, path);
  return emptyReviewContent();
}

function isAbsentReviewSide(file: WorkspaceReviewFile, side: 'old' | 'new'): boolean {
  return (
    (side === 'old' && file.status === 'added') || (side === 'new' && file.status === 'deleted')
  );
}

function readRevisionReviewSide(
  workspace: string,
  resolved: ResolvedReview,
  file: WorkspaceReviewFile,
  side: 'old' | 'new',
) {
  const revision = side === 'old' ? resolved.oldRevision : resolved.newRevision;
  if (!revision) return emptyReviewContent();
  const path = side === 'old' ? (file.originalPath ?? file.path) : file.path;
  return readGitObject(workspace, `${revision}:${path}`, file.type);
}

function emptyReviewContent() {
  return { type: 'text' as const, content: '' };
}

function readWorkspaceReviewSide(
  workspace: string,
  resolved: ResolvedReview,
  file: WorkspaceReviewFile,
  side: 'old' | 'new',
) {
  if (file.changeScope === 'staged') {
    if (side === 'new') return readGitObject(workspace, `:${file.path}`, file.type);
    return readGitObject(
      workspace,
      `${resolved.oldRevision}:${file.originalPath ?? file.path}`,
      file.type,
    );
  }
  if (side === 'new') return readWorkspaceFile(workspace, file.path);
  return readGitObject(workspace, `:${file.originalPath ?? file.path}`, file.type);
}

async function readGitObject(
  workspace: string,
  object: string,
  fileType: WorkspaceReviewFile['type'],
) {
  const result = await git(['show', object], workspace);
  if (result.code !== 0) return { type: 'text' as const, content: '' };
  if (fileType === 'binary' || result.stdout.includes('\0')) {
    return { type: 'binary' as const, content: '' };
  }
  return { type: 'text' as const, content: result.stdout };
}

function resolveRequestedFiles(
  summary: WorkspaceReviewSummary,
  fileIds: string[] | undefined,
): WorkspaceReviewFile[] {
  if (!fileIds || fileIds.length === 0) {
    const changedLines = summary.totals.additions + summary.totals.deletions;
    const changedBytes = summary.totals.changedBytes ?? 0;
    if (
      summary.files.length > REVIEW_SMALL_FILE_LIMIT ||
      changedLines > REVIEW_TOTAL_CHANGED_LINES_LIMIT ||
      changedBytes > REVIEW_TOTAL_CHANGED_BYTES_LIMIT
    ) {
      throw new Error('Large review requires an explicit file batch');
    }
    return summary.files;
  }
  const unique = [...new Set(fileIds)];
  if (unique.length > REVIEW_BATCH_FILE_LIMIT) {
    throw new Error(`Review batch is limited to ${REVIEW_BATCH_FILE_LIMIT} files`);
  }
  const byId = new Map(summary.files.map((file) => [file.fileId, file]));
  return unique.map((id) => {
    const file = byId.get(id);
    if (!file) throw new Error(`Unknown review file id: ${id}`);
    return file;
  });
}

async function listUntrackedPaths(workspace: string): Promise<{ count: number; paths: string[] }> {
  const paths: string[] = [];
  let count = 0;
  let pending = '';
  const record = (path: string) => {
    if (!path) return;
    count += 1;
    if (count <= REVIEW_UNTRACKED_FILE_LIMIT) {
      paths.push(path);
    } else if (count === REVIEW_UNTRACKED_FILE_LIMIT + 1) {
      paths.length = 0;
    }
  };
  const result = await gitStream(
    ['ls-files', '--others', '--exclude-standard', '-z', '--'],
    workspace,
    {
      onStdout: (chunk) => {
        pending += chunk;
        const records = pending.split('\0');
        pending = records.pop() ?? '';
        for (const path of records) record(path);
      },
    },
  );
  if (pending) record(pending);
  if (result.code !== 0) throw new Error(result.stderr || 'Unable to enumerate untracked files');
  return { count, paths };
}

function omissionFor(count: number): WorkspaceReviewUntrackedOmission | undefined {
  return count > REVIEW_UNTRACKED_FILE_LIMIT
    ? { count, limit: REVIEW_UNTRACKED_FILE_LIMIT }
    : undefined;
}

function parseNameStatus(stdout: string): NameStatusEntry[] {
  const parts = stdout.split('\0');
  const entries: NameStatusEntry[] = [];
  for (let index = 0; index < parts.length; ) {
    const parsed = parseNameStatusEntry(parts, index);
    index = parsed.nextIndex;
    if (parsed.entry) entries.push(parsed.entry);
  }
  return entries;
}

function parseNameStatusEntry(
  parts: string[],
  index: number,
): { nextIndex: number; entry?: NameStatusEntry } {
  const token = parts[index] ?? '';
  const firstPath = parts[index + 1] ?? '';
  if (!token) return { nextIndex: index + 1 };
  const statusCode = token[0];
  if (statusCode === 'R' || statusCode === 'C') {
    const path = parts[index + 2] ?? '';
    return path
      ? { nextIndex: index + 3, entry: { path, originalPath: firstPath, status: 'modified' } }
      : { nextIndex: index + 3 };
  }
  return firstPath
    ? { nextIndex: index + 2, entry: { path: firstPath, status: mapChangedFileStatus(statusCode) } }
    : { nextIndex: index + 2 };
}

function mapChangedFileStatus(statusCode: string | undefined): GitChangedFile['status'] {
  if (statusCode === 'A') return 'added';
  if (statusCode === 'D') return 'deleted';
  return 'modified';
}

function parseNumstat(stdout: string): Map<string, DiffMetric> {
  const parts = stdout.split('\0');
  const metrics = new Map<string, DiffMetric>();
  for (let index = 0; index < parts.length; ) {
    const parsed = parseNumstatEntry(parts, index);
    index = parsed.nextIndex;
    if (parsed.path && parsed.metric) metrics.set(parsed.path, parsed.metric);
  }
  return metrics;
}

function parseNumstatEntry(
  parts: string[],
  index: number,
): { nextIndex: number; path?: string; metric?: DiffMetric } {
  const token = parts[index] ?? '';
  if (!token) return { nextIndex: index + 1 };
  const [addedRaw = '0', deletedRaw = '0', inlinePath = ''] = token.split('\t');
  const { path, nextIndex } = resolveNumstatPath(parts, index, inlinePath);
  if (!path) return { nextIndex };
  return {
    nextIndex,
    path,
    metric: buildDiffMetric(addedRaw, deletedRaw),
  };
}

function resolveNumstatPath(
  parts: string[],
  index: number,
  inlinePath: string,
): { path: string; nextIndex: number } {
  if (inlinePath) return { path: inlinePath, nextIndex: index + 1 };
  return { path: parts[index + 2] ?? '', nextIndex: index + 3 };
}

function buildDiffMetric(addedRaw: string, deletedRaw: string): DiffMetric {
  const binary = addedRaw === '-' || deletedRaw === '-';
  if (binary) return { additions: 0, deletions: 0, binary: true };
  return {
    additions: Number.parseInt(addedRaw, 10) || 0,
    deletions: Number.parseInt(deletedRaw, 10) || 0,
    binary: false,
  };
}

function withDiffOption(args: string[], ...options: string[]): string[] {
  const separator = args.lastIndexOf('--');
  if (separator < 0) return [...args, ...options];
  return [...args.slice(0, separator), ...options, ...args.slice(separator)];
}

async function resolveRepositoryId(workspace: string): Promise<string> {
  const commonDir = await requireStdout(
    git(['rev-parse', '--git-common-dir'], workspace),
    'Unable to resolve Git common directory',
  );
  const absolute = resolve(workspace, commonDir);
  const canonical = await optionalRealpath(absolute);
  return hash([canonical]);
}

async function optionalRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function resolveCommit(workspace: string, ref: string): Promise<string> {
  const result = await git(
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    workspace,
  );
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error(result.stderr || `Unable to resolve Git ref: ${ref}`);
  }
  return result.stdout.trim();
}

async function resolveOptionalCommit(workspace: string, ref: string): Promise<string | undefined> {
  try {
    return await resolveCommit(workspace, ref);
  } catch {
    return undefined;
  }
}

async function firstParent(workspace: string, sha: string): Promise<string | undefined> {
  const result = await git(['rev-list', '--parents', '-n', '1', sha], workspace);
  if (result.code !== 0) throw new Error(result.stderr || `Unable to read commit parents: ${sha}`);
  return result.stdout.trim().split(/\s+/u)[1];
}

async function isCommitInRange(
  workspace: string,
  mergeBase: string,
  headCommit: string,
  sha: string,
): Promise<boolean> {
  if (sha === mergeBase) return false;
  const afterBase = await git(['merge-base', '--is-ancestor', mergeBase, sha], workspace);
  const beforeHead = await git(['merge-base', '--is-ancestor', sha, headCommit], workspace);
  return afterBase.code === 0 && beforeHead.code === 0;
}

function parseCommitLog(stdout: string): WorkspaceReviewCommit[] {
  const fields = stdout.split('\0');
  const items: WorkspaceReviewCommit[] = [];
  for (let index = 0; index + 5 < fields.length; index += 6) {
    const item = parseCommitLogEntry(fields.slice(index, index + 6));
    if (item) items.push(item);
  }
  return items;
}

function parseCommitLogEntry(fields: string[]): WorkspaceReviewCommit | undefined {
  const sha = commitLogField(fields, 0).trim();
  if (!sha) return undefined;
  const parents = commitLogField(fields, 1).trim().split(/\s+/u).filter(Boolean);
  const committedAtSeconds = Number.parseInt(commitLogField(fields, 2).trim(), 10);
  const authorName = commitLogField(fields, 3).trim();
  const subject = commitLogField(fields, 4);
  const message = commitLogField(fields, 5).trim();
  const item: WorkspaceReviewCommit = {
    sha,
    shortSha: sha.slice(0, 8),
    subject,
    authorName,
    committedAtMs: (Number.isNaN(committedAtSeconds) ? 0 : committedAtSeconds) * 1_000,
  };
  if (message) item.message = message;
  if (parents.length > 1) item.isMerge = true;
  return item;
}

function commitLogField(fields: string[], index: number): string {
  return fields[index] ?? '';
}

async function readCommit(
  workspace: string,
  sha: string,
): Promise<WorkspaceReviewCommit | undefined> {
  const result = await git(
    ['show', '-s', '--format=%H%x00%P%x00%ct%x00%an%x00%s%x00%B%x00', sha],
    workspace,
  );
  if (result.code !== 0) return undefined;
  return parseCommitLog(result.stdout)[0];
}

async function enrichCommitStats(workspace: string, item: WorkspaceReviewCommit): Promise<void> {
  const result = await git(['show', '--format=', '--numstat', '-z', item.sha, '--'], workspace);
  if (result.code !== 0) return;
  let additions = 0;
  let deletions = 0;
  for (const metric of parseNumstat(result.stdout).values()) {
    additions += metric.additions;
    deletions += metric.deletions;
  }
  item.additions = additions;
  item.deletions = deletions;
}

async function requireStdout(
  pending: Promise<{ code: number; stdout: string; stderr: string }>,
  message: string,
): Promise<string> {
  const result = await pending;
  if (result.code !== 0 || !result.stdout.trim()) throw new Error(result.stderr || message);
  return result.stdout.trim();
}

function fileId(path: string, scope?: ScopedGitChangeScope, originalPath?: string): string {
  return hash([scope ?? 'all', originalPath ?? '', path]).slice(0, 24);
}

function hash(parts: string[]): string {
  const digest = createHash('sha256');
  for (const part of parts) digest.update(part).update('\0');
  return digest.digest('hex');
}

function maxChangedLineBytes(patch: string): number {
  let maximum = 0;
  for (const line of patch.split('\n')) {
    if (!line.startsWith('+') && !line.startsWith('-')) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    maximum = Math.max(maximum, Buffer.byteLength(line.slice(1)));
  }
  return maximum;
}

function addedFilePatch(path: string, content: string): string {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
