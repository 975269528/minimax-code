import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import type {
  GitBranchesInfo,
  GitChangedFile,
  GitChangeScope,
  GitChangesBase,
  GitChangesValue,
  GitDefaultBranchInfo,
  GitMetadataValue,
  ScopedGitChangeScope,
} from '../contracts.js';
import { git } from './git-process.js';
import { isKnownBinaryExtension, resolveWorkspacePath } from './workspace-path.js';

const UNTRACKED_LINE_COUNT_CONCURRENCY = 4;
const UNTRACKED_LINE_COUNT_MAX_BYTES = 1024 * 1024;
const MAX_RECENT_BRANCHES = 100;
const MAX_BRANCH_SEARCH_RESULTS = 20;

export interface GitBranchSearchOptions {
  limit?: number;
  includeRemote?: boolean;
  signal?: AbortSignal;
}

export async function captureGitChangesBase(workspace: string): Promise<GitChangesBase> {
  if (!(await isGitRepo(workspace))) {
    return { changes: emptyChanges(false), untrackedPaths: new Set() };
  }
  const hasHead = (await git(['rev-parse', '--verify', 'HEAD'], workspace)).code === 0;
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], workspace);
  if (status.code !== 0) {
    return {
      changes: { ...emptyChanges(true), hasHead, error: status.stderr || status.stdout },
      untrackedPaths: new Set(),
    };
  }
  const parsedStatus = parsePorcelainStatus(status.stdout);
  return {
    changes: {
      isGitRepo: true,
      changedFiles: parsedStatus.files.length,
      stagedFiles: parsedStatus.stagedFiles,
      unstagedFiles: parsedStatus.unstagedFiles,
      untrackedFiles: parsedStatus.untrackedFiles,
      insertions: 0,
      deletions: 0,
      hasHead,
      files: parsedStatus.files,
      lineStatsStatus: 'skipped',
    },
    untrackedPaths: parsedStatus.untrackedPaths,
  };
}

export async function enrichGitChanges(
  workspace: string,
  base: GitChangesBase,
): Promise<GitChangesValue> {
  if (!base.changes.isGitRepo || base.changes.error) return base.changes;
  const files = base.changes.files.map((file) => ({ ...file }));
  const statsByScope = new Map<
    ScopedGitChangeScope,
    Map<string, { additions: number; deletions: number }>
  >();
  let lineStatsComplete = true;
  const untrackedFiles = files.filter(
    (file) => file.status === 'added' && base.untrackedPaths.has(file.path),
  );
  const [, untrackedLineCounts] = await Promise.all([
    Promise.all(
      gitDiffScopes('all').map(async (scope) => {
        const numstat = await git(gitNumstatArgs(scope, base.changes.hasHead), workspace);
        const parsedNumstat = parseNumstat(numstat.stdout);
        if (numstat.code !== 0 || !parsedNumstat.complete) lineStatsComplete = false;
        statsByScope.set(scope, parsedNumstat.stats);
      }),
    ),
    mapWithConcurrency(
      untrackedFiles,
      UNTRACKED_LINE_COUNT_CONCURRENCY,
      async (file) => [file.path, await countWorkspaceTextLines(workspace, file.path)] as const,
    ),
  ]);
  const untrackedLineCountsByPath = new Map(untrackedLineCounts);
  for (const file of files) {
    const fileStats = file.changeScope
      ? statsByScope.get(file.changeScope)?.get(file.path)
      : undefined;
    if (fileStats) {
      file.additions = fileStats.additions;
      file.deletions = fileStats.deletions;
    } else if (file.status === 'added' && base.untrackedPaths.has(file.path)) {
      const lineCount = untrackedLineCountsByPath.get(file.path);
      if (lineCount === undefined) lineStatsComplete = false;
      else file.additions = lineCount;
    }
  }
  return {
    ...base.changes,
    insertions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    files,
    lineStatsStatus: lineStatsComplete ? 'ready' : 'partial',
  };
}

export async function getGitMetadata(workspace: string): Promise<GitMetadataValue> {
  if (!(await isGitRepo(workspace))) {
    return { isGitRepo: false, branch: '', isWorktree: false };
  }
  const branch = await git(['branch', '--show-current'], workspace);
  const gitDirectories = await git(['rev-parse', '--git-dir', '--git-common-dir'], workspace);
  const remotes = await git(['remote'], workspace);
  const upstream = await git(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    workspace,
  );
  const { ahead, behind } = await readAheadBehind(workspace, upstream.code === 0);
  const [gitDir, gitCommonDir] = gitDirectories.stdout
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    isGitRepo: true,
    branch: branch.stdout.trim(),
    isWorktree: isSeparateWorktree(workspace, gitDirectories.code, gitDir, gitCommonDir),
    ahead,
    behind,
    hasUpstream: upstream.code === 0,
    hasRemote: remotes.stdout.trim().length > 0,
    canPush: remotes.stdout.trim().length > 0,
    hasHead: (await git(['rev-parse', '--verify', 'HEAD'], workspace)).code === 0,
  };
}

async function readAheadBehind(
  workspace: string,
  hasUpstream: boolean,
): Promise<{ ahead: number; behind: number }> {
  if (!hasUpstream) return { ahead: 0, behind: 0 };
  const counts = await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], workspace);
  const [aheadRaw, behindRaw] = counts.stdout.trim().split(/\s+/u, 2);
  return {
    ahead: Number.parseInt(aheadRaw ?? '0', 10) || 0,
    behind: Number.parseInt(behindRaw ?? '0', 10) || 0,
  };
}

function isSeparateWorktree(
  workspace: string,
  resultCode: number,
  gitDir: string | undefined,
  gitCommonDir: string | undefined,
): boolean {
  if (resultCode !== 0 || gitDir === undefined || gitCommonDir === undefined) return false;
  return resolve(workspace, gitDir) !== resolve(workspace, gitCommonDir);
}

export async function getGitBranches(
  workspace: string,
  includeRemote: boolean,
): Promise<GitBranchesInfo> {
  if (!(await isGitRepo(workspace))) {
    return {
      success: false,
      current: '',
      branches: [],
      error: 'Not a git repository',
    };
  }
  const current = (await git(['branch', '--show-current'], workspace)).stdout.trim();
  const local = lines((await git(['branch', '--format=%(refname:short)'], workspace)).stdout);
  const remote = includeRemote
    ? lines((await git(['branch', '-r', '--format=%(refname:short)'], workspace)).stdout).filter(
        (line) => !line.endsWith('/HEAD'),
      )
    : [];
  return { success: true, current, branches: local, local, ...(includeRemote ? { remote } : {}) };
}

export async function listRecentGitBranches(
  workspace: string,
  limit = MAX_RECENT_BRANCHES,
  signal?: AbortSignal,
): Promise<GitBranchesInfo> {
  const boundedLimit = clampBranchLimit(limit, MAX_RECENT_BRANCHES);
  if (!(await isGitRepo(workspace, signal))) return notGitRepositoryBranches();
  const [currentResult, branchesResult] = await Promise.all([
    git(['branch', '--show-current'], workspace, { signal }),
    git(
      [
        'for-each-ref',
        `--count=${boundedLimit + 1}`,
        '--sort=-committerdate',
        '--format=%(refname:short)',
        'refs/heads',
      ],
      workspace,
      { signal },
    ),
  ]);
  if (currentResult.code !== 0 || branchesResult.code !== 0) {
    return branchCommandFailure(currentResult, branchesResult);
  }
  const current = currentResult.stdout.trim();
  const local = lines(branchesResult.stdout)
    .filter((branch) => branch !== current)
    .slice(0, boundedLimit);
  return { success: true, current, branches: local, local };
}

export async function searchGitBranches(
  workspace: string,
  query: string,
  options: GitBranchSearchOptions = {},
): Promise<GitBranchesInfo> {
  const { limit = MAX_BRANCH_SEARCH_RESULTS, includeRemote = true, signal } = options;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const boundedLimit = clampBranchLimit(limit, MAX_BRANCH_SEARCH_RESULTS);
  if (!normalizedQuery) {
    return { success: true, current: '', branches: [], local: [], remote: [] };
  }
  if (!(await isGitRepo(workspace, signal))) return notGitRepositoryBranches();
  const [currentResult, localResult, remoteResult] = await Promise.all([
    git(['branch', '--show-current'], workspace, { signal }),
    git(
      ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'],
      workspace,
      { signal },
    ),
    includeRemote
      ? git(
          ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes'],
          workspace,
          { signal },
        )
      : Promise.resolve({ code: 0, stdout: '', stderr: '' }),
  ]);
  if (currentResult.code !== 0 || localResult.code !== 0 || remoteResult.code !== 0) {
    return branchCommandFailure(currentResult, localResult, remoteResult);
  }
  const current = currentResult.stdout.trim();
  const localRefs = lines(localResult.stdout).filter((branch) => branch !== current);
  const remoteRefs = lines(remoteResult.stdout).filter((branch) => !branch.endsWith('/HEAD'));
  const localSet = new Set(localRefs);
  const remoteSet = new Set(remoteRefs);
  const matches = [...new Set([...localRefs, ...remoteRefs])]
    .map((branch, index) => ({ branch, index, rank: branchSearchRank(branch, normalizedQuery) }))
    .filter((entry) => entry.rank < Number.POSITIVE_INFINITY)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, boundedLimit)
    .map((entry) => entry.branch);
  return {
    success: true,
    current,
    branches: matches,
    local: matches.filter((branch) => localSet.has(branch)),
    ...(includeRemote ? { remote: matches.filter((branch) => remoteSet.has(branch)) } : {}),
  };
}

export async function getDefaultBranch(workspace: string): Promise<GitDefaultBranchInfo> {
  const symbolic = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], workspace);
  if (symbolic.code === 0 && symbolic.stdout.trim()) {
    return {
      success: true,
      branch: symbolic.stdout.trim().replace(/^origin\//, ''),
      source: 'symbolic-ref',
    };
  }
  const branches = await getGitBranches(workspace, false);
  const local = branches.local ?? [];
  const branch = chooseDefaultBranch(local, branches.current);
  return branch
    ? { success: true, branch, source: 'fallback-probe' }
    : { success: false, error: 'No default branch found' };
}

function chooseDefaultBranch(local: string[], current: string | undefined): string | undefined {
  if (local.includes('main')) return 'main';
  if (local.includes('master')) return 'master';
  return current;
}

export async function isGitRepo(workspace: string, signal?: AbortSignal): Promise<boolean> {
  return (
    (
      await git(['rev-parse', '--is-inside-work-tree'], workspace, signal ? { signal } : {})
    ).stdout.trim() === 'true'
  );
}

export async function classifyWorkspacePathsIgnored(
  workspace: string,
  paths: string[],
): Promise<boolean> {
  if (paths.length === 0) return false;
  if (paths.some((filePath) => filePath.includes('\n') || filePath.includes('\r'))) return false;
  const result = await git(['check-ignore', '--', ...paths], workspace);
  if (result.code !== 0 && result.code !== 1) {
    if (!(await isGitRepo(workspace))) return false;
    throw new Error(result.stderr || result.stdout || 'git check-ignore failed');
  }
  const ignored = new Set(lines(result.stdout));
  return paths.every((filePath) => ignored.has(filePath));
}

export function gitDiffScopes(scope: GitChangeScope): ScopedGitChangeScope[] {
  return scope === 'staged' || scope === 'unstaged' ? [scope] : ['staged', 'unstaged'];
}

export function gitDiffArgs(
  scope: GitChangeScope,
  hasHead: boolean,
  paths: string[] = [],
): string[] {
  const args = ['diff', '--no-ext-diff', '--unified=3'];
  if (scope === 'staged') {
    args.push('--cached');
    if (hasHead) args.push('HEAD');
  } else if (scope === 'all') {
    if (hasHead) args.push('HEAD');
    else args.push('--cached');
  }
  args.push('--', ...paths);
  return args;
}

function gitNumstatArgs(scope: ScopedGitChangeScope, hasHead: boolean): string[] {
  const args = ['diff', '--numstat', '-z'];
  if (scope === 'staged') {
    args.push('--cached');
    if (hasHead) args.push('HEAD');
  }
  args.push('--');
  return args;
}

export function parsePorcelainStatus(stdout: string): {
  files: GitChangedFile[];
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  untrackedPaths: Set<string>;
} {
  const records = stdout.split('\0');
  const accumulator: StatusAccumulator = {
    files: [],
    stagedFiles: 0,
    unstagedFiles: 0,
    untrackedFiles: 0,
    untrackedPaths: new Set(),
  };
  for (let index = 0; index < records.length; index += 1) {
    const parsed = parseStatusRecord(records, index);
    if (!parsed) continue;
    index = parsed.nextIndex;
    addStatusRecord(accumulator, parsed);
  }
  return accumulator;
}

interface StatusAccumulator {
  files: GitChangedFile[];
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  untrackedPaths: Set<string>;
}

interface ParsedStatusRecord {
  x: string;
  y: string;
  path: string;
  originalPath?: string;
  nextIndex: number;
}

function parseStatusRecord(records: string[], index: number): ParsedStatusRecord | undefined {
  const record = records[index];
  if (!record || record.length < 4) return undefined;
  const x = record[0] ?? ' ';
  const y = record[1] ?? ' ';
  const path = record.slice(3);
  if (!path) return undefined;
  const renamePath = x === 'R' || x === 'C' ? records[index + 1] : undefined;
  return {
    x,
    y,
    path,
    ...(renamePath ? { originalPath: renamePath } : {}),
    nextIndex: renamePath ? index + 1 : index,
  };
}

function addStatusRecord(accumulator: StatusAccumulator, record: ParsedStatusRecord): void {
  if (record.x === '?' && record.y === '?') {
    accumulator.untrackedFiles += 1;
    accumulator.unstagedFiles += 1;
    accumulator.untrackedPaths.add(record.path);
    accumulator.files.push(createChangedFile(record.path, '?', 'unstaged'));
    return;
  }
  if (record.x !== ' ') {
    accumulator.stagedFiles += 1;
    accumulator.files.push(createChangedFile(record.path, record.x, 'staged', record.originalPath));
  }
  if (record.y !== ' ') {
    accumulator.unstagedFiles += 1;
    accumulator.files.push(createChangedFile(record.path, record.y, 'unstaged'));
  }
}

function createChangedFile(
  path: string,
  code: string,
  changeScope: ScopedGitChangeScope,
  originalPath?: string,
): GitChangedFile {
  return {
    path,
    ...(originalPath ? { originalPath } : {}),
    status: statusFromGitCode(code),
    additions: 0,
    deletions: 0,
    changeScope,
  };
}

function parseNumstat(stdout: string): {
  stats: Map<string, { additions: number; deletions: number }>;
  complete: boolean;
} {
  const stats = new Map<string, { additions: number; deletions: number }>();
  let complete = true;
  const records = stdout.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const parsed = parseNumstatRecord(records, index);
    if (!parsed) continue;
    index = parsed.nextIndex;
    complete &&= parsed.complete;
    stats.set(parsed.filePath, { additions: parsed.additions, deletions: parsed.deletions });
  }
  return { stats, complete };
}

function parseNumstatRecord(
  records: string[],
  index: number,
):
  | {
      filePath: string;
      additions: number;
      deletions: number;
      complete: boolean;
      nextIndex: number;
    }
  | undefined {
  const record = records[index];
  if (!record?.trim()) return undefined;
  const [addRaw, delRaw, ...pathParts] = record.split('\t');
  let filePath = pathParts.join('\t');
  let nextIndex = index;
  if (!filePath) {
    filePath = records[index + 2] ?? '';
    nextIndex = index + 2;
  }
  if (!filePath) return undefined;
  const additions = parseStatValue(addRaw);
  const deletions = parseStatValue(delRaw);
  return {
    filePath,
    additions: additions.value,
    deletions: deletions.value,
    complete: additions.complete && deletions.complete,
    nextIndex,
  };
}

function parseStatValue(value: string | undefined): { value: number; complete: boolean } {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed)
    ? { value: parsed, complete: true }
    : { value: 0, complete: false };
}

async function countWorkspaceTextLines(
  workspace: string,
  filePath: string,
): Promise<number | undefined> {
  const absolute = await resolveWorkspacePath(workspace, filePath);
  if (!absolute || isKnownBinaryExtension(filePath)) return undefined;
  const decoder = new TextDecoder('utf8', { fatal: true });
  const state: TextLineCountState = {
    bytesRead: 0,
    newlineCount: 0,
    sampledBytes: 0,
    sampledControlBytes: 0,
  };
  try {
    // end is inclusive: one extra byte distinguishes an exact-budget file from a larger one.
    // Bounding the stream also prevents growing files and read-ahead from escaping the budget.
    for await (const rawChunk of createReadStream(absolute, {
      end: UNTRACKED_LINE_COUNT_MAX_BYTES,
    })) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      if (!consumeTextChunk(chunk, decoder, state)) return undefined;
    }
    decoder.decode();
  } catch {
    return undefined;
  }
  if (isControlHeavy(state)) return undefined;
  return state.newlineCount + (state.bytesRead > 0 && state.lastByte !== 10 ? 1 : 0);
}

interface TextLineCountState {
  bytesRead: number;
  newlineCount: number;
  lastByte?: number;
  sampledBytes: number;
  sampledControlBytes: number;
}

function consumeTextChunk(chunk: Buffer, decoder: TextDecoder, state: TextLineCountState): boolean {
  if (state.bytesRead + chunk.length > UNTRACKED_LINE_COUNT_MAX_BYTES) return false;
  if (chunk.includes(0)) return false;
  decoder.decode(chunk, { stream: true });
  const sampleLength = Math.min(Math.max(0, 8_000 - state.sampledBytes), chunk.length);
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = chunk[index] as number;
    if (isControlByte(byte)) state.sampledControlBytes += 1;
  }
  state.sampledBytes += sampleLength;
  for (const byte of chunk) {
    if (byte === 10) state.newlineCount += 1;
  }
  state.bytesRead += chunk.length;
  state.lastByte = chunk.at(-1);
  return true;
}

function isControlByte(byte: number): boolean {
  return byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13;
}

function isControlHeavy(state: TextLineCountState): boolean {
  return state.sampledBytes > 0 && state.sampledControlBytes / state.sampledBytes > 0.3;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapValue: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        results[index] = await mapValue(values[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function statusFromGitCode(code: string): GitChangedFile['status'] {
  if (code === 'A' || code === '?') return 'added';
  if (code === 'D') return 'deleted';
  return 'modified';
}

function emptyChanges(repoAvailable: boolean): GitChangesValue {
  return {
    isGitRepo: repoAvailable,
    changedFiles: 0,
    stagedFiles: 0,
    unstagedFiles: 0,
    untrackedFiles: 0,
    insertions: 0,
    deletions: 0,
    hasHead: false,
    files: [],
    lineStatsStatus: 'skipped',
  };
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function clampBranchLimit(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return maximum;
  return Math.max(1, Math.min(Math.trunc(value), maximum));
}

function notGitRepositoryBranches(): GitBranchesInfo {
  return {
    success: false,
    current: '',
    branches: [],
    error: 'Not a git repository',
  };
}

function branchCommandFailure(
  ...results: Array<{ code: number; stdout: string; stderr: string }>
): GitBranchesInfo {
  const failed = results.find((result) => result.code !== 0);
  return {
    success: false,
    current: '',
    branches: [],
    error: failed
      ? failed.stderr || failed.stdout || 'Unable to list Git branches'
      : 'Unable to list Git branches',
  };
}

function branchSearchRank(branch: string, query: string): number {
  const normalized = branch.toLocaleLowerCase();
  if (normalized === query) return 0;
  if (normalized.split('/').at(-1) === query) return 1;
  if (normalized.startsWith(query)) return 2;
  return normalized.includes(query) ? 3 : Number.POSITIVE_INFINITY;
}
