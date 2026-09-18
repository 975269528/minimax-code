import { execFile as execFileCallback, type ExecFileException } from 'node:child_process';
import { createReadStream } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  win32,
} from 'node:path';
import { promisify, TextDecoder } from 'node:util';
import { Readable } from 'node:stream';
import { getWorkspaceImagePreviewMimeType } from '@mavis/shared/media-asset-meta';
import { getDataDir } from '@mavis/config';
import { LocalReviewLinkStore } from '../review-link/store.js';
import { generateDefaultWorktreeBranch } from '../worktrees/branch.js';
import { IdeLauncher, IdeLauncherError } from '../ide/launcher.js';
import { git as runGitProcess, gitRoot, type GitRunResult } from './git-process.js';
import { resolvePath, toPortableRelativePath } from './path-utils.js';
import { routeFileSave } from './save.js';
import { classifyExistingPathError } from './path-error.js';
import { listWorkspaceGitWorktrees } from './worktrees.js';
import {
  buildWorkspaceFileThumbnail,
  normalizeThumbnailMaxEdge,
  resetWorkspaceFileThumbnailCache,
} from './thumbnail.js';
import type { ModuleMetricsReporter } from '../common/metrics.js';
import { logger } from '../common/logger.js';
import {
  WorkspaceGitChangesCoordinator,
  type GitChangesMode,
} from './workspace-git-changes-coordinator.js';

const execFile = promisify(execFileCallback);
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const VIDEO_PREVIEW_MIME_TYPES = new Map<string, string>([
  ['.m4v', 'video/x-m4v'],
  ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'],
  ['.mp4', 'video/mp4'],
  ['.ogv', 'video/ogg'],
  ['.webm', 'video/webm'],
]);
const RC_REQUEST_SOURCE_HEADER = 'X-MCode-Request-Source';
const RC_REQUEST_SOURCE_VALUE = 'remote-control';
const RC_FILE_CONTENT_MAX_BYTES_HEADER = 'X-MCode-Remote-Control-File-Content-Max-Bytes';
const DEFAULT_RC_FILE_CONTENT_MAX_BYTES = 10 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.css',
  '.csv',
  '.html',
  '.js',
  '.json',
  '.jsonl',
  '.jsx',
  '.log',
  '.md',
  '.mdx',
  '.mjs',
  '.scss',
  '.sh',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);
const PREVIEW_BINARY_MIME_TYPES = new Map([
  ['.aac', 'audio/aac'],
  ['.bmp', 'image/bmp'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.flac', 'audio/flac'],
  ['.gif', 'image/gif'],
  ['.key', 'application/vnd.apple.keynote'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.m4a', 'audio/mp4'],
  ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.svg', 'image/svg+xml'],
  ['.wav', 'audio/wav'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
]);
const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.aac',
  '.bin',
  '.bmp',
  '.db',
  '.doc',
  '.docx',
  '.dylib',
  '.exe',
  '.flac',
  '.gz',
  '.key',
  '.m4a',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.pdf',
  '.png',
  '.ppt',
  '.pptx',
  '.so',
  '.sqlite',
  '.tar',
  '.wasm',
  '.wav',
  '.webm',
  '.webp',
  '.xls',
  '.xlsx',
  '.zip',
]);
const HIDDEN_SEARCH_DIRS = new Set([
  '.cache',
  '.git',
  '.next',
  '.pnpm-store',
  '.turbo',
  '.venv',
  '.worktree',
  '.worktrees',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);
const FILE_SEARCH_PATH_TIEBREAKER_WEIGHT = 0.001;

type GitCommandRunner = (args: string[], workspace: string) => Promise<GitRunResult>;
type OpenCommandPlatform = NodeJS.Platform;
type OpenCommandRunner = (
  file: string,
  args: string[],
  options: {
    windowsHide: boolean;
    windowsVerbatimArguments?: boolean;
  },
) => Promise<void>;
interface OpenCommandRuntime {
  platform: OpenCommandPlatform;
  env: NodeJS.ProcessEnv;
  run: OpenCommandRunner;
}
type GitChangeScope = 'staged' | 'unstaged' | 'all';
type ScopedGitChangeScope = Exclude<GitChangeScope, 'all'>;
interface GitChangedFile {
  path: string;
  originalPath?: string;
  status: 'added' | 'deleted' | 'modified';
  additions: number;
  deletions: number;
  changeScope?: ScopedGitChangeScope;
}

export interface GitChangesInfo {
  isGitRepo: boolean;
  changedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  insertions: number;
  deletions: number;
  hasHead: boolean;
  files: GitChangedFile[];
  lineStatsStatus?: 'ready' | 'partial' | 'skipped';
  error?: string;
}

export interface LocalWorkspaceGitFacade {
  getMetadata(workspace: string): Promise<Record<string, unknown>>;
  /**
   * Reads the review link recorded for `workspace` on `branch`, or `undefined`
   * when the branch has no recorded pull request / merge request.
   *
   * Deliberately separate from `getMetadata`: that read is snapshot-cached and
   * consumed by several surfaces, whereas this one is plain derived state that
   * only the status line asks for.
   */
  getReviewLink(workspace: string, branch: string): Promise<Record<string, unknown> | undefined>;
}

/** Read-only process-local Git metadata facade; mutation remains outside this seam. */
export function createLocalWorkspaceGitFacade(
  reviewLinkStore: Pick<LocalReviewLinkStore, 'read'> = new LocalReviewLinkStore(getDataDir),
): LocalWorkspaceGitFacade {
  return {
    getMetadata: (workspace) => getGitMetadata(workspace),
    getReviewLink: async (workspace, branch) => {
      const entry = reviewLinkStore.read(workspace, branch);
      // Widened to the facade's untyped shape; the consumer re-validates it
      // rather than trusting a structural cast across the seam.
      return entry ? { ...entry } : undefined;
    },
  };
}

export interface GitChangesBase {
  changes: GitChangesInfo;
  untrackedPaths: Set<string>;
}
interface LocalFileApiIdeLauncher {
  listIdeApps(): Promise<unknown>;
  openWorkspaceInIde(
    workspaceDir: string | undefined,
    ideId: string,
    filePath?: string,
  ): Promise<void>;
}

let ideLauncher: LocalFileApiIdeLauncher = new IdeLauncher();
let gitCommandRunner: GitCommandRunner = runGitProcess;
const defaultOpenCommandRuntime: OpenCommandRuntime = {
  platform: process.platform,
  env: process.env,
  run: async (file, args, options) => {
    await execFile(file, args, options);
  },
};
let openCommandRuntime: OpenCommandRuntime = defaultOpenCommandRuntime;
export function createLocalFileApiGitChangesCoordinator(): WorkspaceGitChangesCoordinator<
  GitChangesBase,
  GitChangesInfo
> {
  return new WorkspaceGitChangesCoordinator(captureGitChangesBase, enrichGitChanges);
}
const defaultGitChangesCoordinator = createLocalFileApiGitChangesCoordinator();

export function __setLocalFileApiIdeLauncherForTests(nextLauncher?: LocalFileApiIdeLauncher): void {
  ideLauncher = nextLauncher ?? new IdeLauncher();
}

export function __setLocalFileApiGitCommandRunnerForTests(nextRunner?: GitCommandRunner): void {
  gitCommandRunner = nextRunner ?? runGitProcess;
  defaultGitChangesCoordinator.clear();
}

export function __resetFileThumbnailCacheForTests(): void {
  resetWorkspaceFileThumbnailCache();
}

export function __setLocalFileApiOpenCommandForTests(
  nextRuntime?: Partial<OpenCommandRuntime>,
): void {
  openCommandRuntime = nextRuntime
    ? { ...defaultOpenCommandRuntime, ...nextRuntime }
    : defaultOpenCommandRuntime;
}

export async function routeLocalFileApi(
  request: Request,
  parts: string[],
  url: URL,
  metrics?: ModuleMetricsReporter,
  gitChangesCoordinator = defaultGitChangesCoordinator,
): Promise<Response | undefined> {
  const method = request.method.toUpperCase();
  if (parts[0] === 'file') {
    return routeFileApi(
      method,
      request,
      parts.slice(1).join('/'),
      url,
      gitChangesCoordinator,
      metrics,
    );
  }
  if (parts[0] === 'fs') {
    return routeFsApi(method, parts.slice(1).join('/'), url);
  }
  return undefined;
}

async function routeFileApi(
  method: string,
  request: Request,
  tail: string,
  url: URL,
  gitChangesCoordinator: WorkspaceGitChangesCoordinator<GitChangesBase, GitChangesInfo>,
  metrics?: ModuleMetricsReporter,
): Promise<Response> {
  if (method === 'GET' && tail === 'tree') {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response) return workspace;
    const subPath = url.searchParams.get('path') ?? '.';
    return json(await listFileTree(workspace, subPath));
  }
  if (method === 'GET' && tail === 'info') {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response) return workspace;
    const filePath = requiredQuery(url, 'path');
    if (filePath instanceof Response) return filePath;
    const resolved = await resolveExistingWorkspacePath(workspace, filePath);
    if (!resolved.ok) {
      if (resolved.code === 'NOT_FOUND') {
        return json({ exists: false, reason: 'file_not_found' });
      }
      if (resolved.code === 'WORKSPACE_NOT_FOUND') {
        return json({ exists: false, reason: 'workspace_not_found' });
      }
      return json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
    }
    const targetStat = await stat(resolved.absolute);
    return json({
      exists: true,
      type: targetStat.isFile() ? 'file' : targetStat.isDirectory() ? 'directory' : 'other',
      sizeBytes: targetStat.size,
      modifiedAtMs: targetStat.mtimeMs,
    });
  }
  if (method === 'GET' && tail === 'content') {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response) return workspace;
    const filePath = requiredQuery(url, 'path');
    if (filePath instanceof Response) return filePath;
    const fileTooLarge = await remoteControlFileContentLimitResponse(
      request.headers,
      workspace,
      filePath,
      metrics,
      'content',
    );
    if (fileTooLarge) return fileTooLarge;
    return json(await readWorkspaceFile(workspace, filePath));
  }
  if (method === 'GET' && tail === 'thumbnail') {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response) return workspace;
    const filePath = requiredQuery(url, 'path');
    if (filePath instanceof Response) return filePath;
    const resolved = await resolveExistingWorkspacePath(workspace, filePath);
    if (!resolved.ok) {
      return json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
    }
    const thumbnail = await buildWorkspaceFileThumbnail(
      resolved.absolute,
      normalizeThumbnailMaxEdge(url.searchParams.get('maxEdge')),
      url.searchParams.get('preserveAlpha') === '1',
    );
    if (!thumbnail.ok) {
      return json({ error: thumbnail.error, code: thumbnail.code }, { status: thumbnail.status });
    }
    return new Response(Uint8Array.from(thumbnail.bytes), {
      headers: {
        'Content-Type': thumbnail.mimeType,
        'Content-Length': String(thumbnail.bytes.byteLength),
        'Cache-Control': 'private, no-store',
        'X-MCode-Thumbnail-Cache': thumbnail.cache,
      },
    });
  }
  if (method === 'GET' && tail === 'media') {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response) return workspace;
    const filePath = requiredQuery(url, 'path');
    if (filePath instanceof Response) return filePath;
    const resolved = await resolveExistingWorkspacePath(workspace, filePath);
    if (!resolved.ok) {
      return json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
    }
    const contentType =
      VIDEO_PREVIEW_MIME_TYPES.get(extname(resolved.absolute).toLowerCase()) ??
      getWorkspaceImagePreviewMimeType(resolved.absolute);
    if (!contentType) {
      return json(
        { error: 'Media preview format is not supported', code: 'MEDIA_PREVIEW_UNSUPPORTED' },
        { status: 415 },
      );
    }
    return streamWorkspaceMedia(resolved.absolute, contentType, request.headers.get('range'));
  }
  if (method === 'GET' && tail === 'preview') {
    return serveFilePreview(url, request.headers, metrics);
  }
  if (method === 'GET' && tail === 'diff') {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response) return workspace;
    const filePath = requiredQuery(url, 'path');
    if (filePath instanceof Response) return filePath;
    const scope = readGitDiffScope(url.searchParams.get('scope'));
    const hasHead = (await git(['rev-parse', '--verify', 'HEAD'], workspace)).code === 0;
    const content = await readWorkspaceFileForDiffScope(workspace, filePath, scope);
    const diff = await git(gitDiffArgs(scope, hasHead, [filePath]), workspace);
    const addedDiff = diff.stdout.trim()
      ? undefined
      : scope === 'staged'
        ? undefined
        : await buildAddedFileDiff(workspace, filePath);
    const binary = diff.stdout.trim()
      ? isBinaryDiff(diff.stdout)
      : scope === 'staged'
        ? false
        : await isUntrackedBinaryFile(workspace, filePath);
    return json({
      ...content,
      ...(scope !== 'all' ? { changeScope: scope } : {}),
      ...(binary
        ? { previewState: 'binary' }
        : diff.code === 0 && diff.stdout.trim()
          ? { diff: diff.stdout, previewState: 'ready' }
          : addedDiff
            ? { diff: addedDiff.diff, previewState: 'ready' }
            : {}),
    });
  }
  if (method === 'GET' && tail === 'diff-context') {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response) return workspace;
    const filePath = requiredQuery(url, 'path');
    if (filePath instanceof Response) return filePath;
    const context = await readDiffContext(
      workspace,
      filePath,
      readGitDiffScope(url.searchParams.get('scope')),
    );
    return context
      ? json(context)
      : json(
          { error: 'Diff context is not available', code: 'DIFF_CONTEXT_UNAVAILABLE' },
          { status: 422 },
        );
  }
  if (method === 'GET' && tail === 'diffs') {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response) return workspace;
    const scope = readGitDiffScope(url.searchParams.get('scope'));
    const changes = await getGitChanges(workspace, 'full', gitChangesCoordinator);
    const requestedScopes = gitDiffScopes(scope);
    const diffBlocksByScope = new Map<ScopedGitChangeScope, Map<string, string>>();
    await Promise.all(
      requestedScopes.map(async (diffScope) => {
        const diff = await git(gitDiffArgs(diffScope, changes.hasHead), workspace);
        diffBlocksByScope.set(diffScope, splitDiffBlocksByFile(diff.stdout));
      }),
    );
    const files = changes.files.filter(
      (file) => file.changeScope && requestedScopes.includes(file.changeScope),
    );
    return json(
      await Promise.all(
        files.map(async (file) => {
          const fileScope = file.changeScope!;
          const block = diffBlocksByScope.get(fileScope)?.get(file.path);
          const addedDiff =
            block || fileScope === 'staged'
              ? undefined
              : await buildAddedFileDiff(workspace, file.path);
          const diffText = block ?? addedDiff?.diff;
          const binary = block
            ? isBinaryDiff(block)
            : fileScope === 'staged'
              ? false
              : await isUntrackedBinaryFile(workspace, file.path);
          return {
            file: file.path,
            ...(file.originalPath ? { originalPath: file.originalPath } : {}),
            additions: file.additions || addedDiff?.additions || 0,
            deletions: file.deletions,
            status: file.status,
            changeScope: fileScope,
            ...(binary
              ? { previewState: 'binary' }
              : diffText
                ? { diff: diffText, previewState: 'ready' }
                : { previewState: 'no_diff' }),
          };
        }),
      ),
    );
  }
  if (method === 'GET' && tail === 'status') {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response) return workspace;
    const changes = await getGitChanges(workspace, 'full', gitChangesCoordinator);
    return json(
      changes.files.map((file) => ({
        path: file.path,
        ...(file.originalPath ? { originalPath: file.originalPath } : {}),
        added: file.additions,
        removed: file.deletions,
        status: file.status,
        ...(file.changeScope ? { changeScope: file.changeScope } : {}),
      })),
    );
  }
  if (tail.startsWith('git/')) {
    return routeGitApi(method, request, tail.slice('git/'.length), url, gitChangesCoordinator);
  }
  if (method === 'GET' && tail === 'search') {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response) return workspace;
    const query = requiredQuery(url, 'query');
    if (query instanceof Response) return query;
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
    return json(await searchFiles(workspace, query, Number.isFinite(limit) ? limit : 50));
  }
  if (method === 'GET' && tail === 'open-app') {
    return json(null);
  }
  if (method === 'GET' && tail === 'ide-apps') {
    return json(await ideLauncher.listIdeApps());
  }
  if (method === 'POST' && tail === 'open') {
    const body = await readJsonBody(request);
    const target = await resolveBodyPath(body);
    if (target instanceof Response) return target;
    return runOpenCommand('open', target.absolute);
  }
  if (method === 'POST' && tail === 'reveal') {
    const body = await readJsonBody(request);
    const target = await resolveBodyPath(body);
    if (target instanceof Response) return target;
    return runOpenCommand('reveal', target.absolute);
  }
  if (method === 'POST' && tail === 'open-in-ide') {
    const body = await readJsonBody(request);
    const ideId = readString(body, 'ideId');
    const workspace = readString(body, 'workspace');
    const filePath = readString(body, 'path');
    if (!ideId) return json({ error: 'ideId is required' }, { status: 400 });
    if (!workspace && !filePath) {
      return json({ error: 'workspace or path is required' }, { status: 400 });
    }
    try {
      await ideLauncher.openWorkspaceInIde(workspace, ideId, filePath);
      return json({ ok: true });
    } catch (error) {
      return ideLauncherErrorResponse(error);
    }
  }
  if (method === 'POST' && tail === 'save') {
    return routeFileSave(request, { readJsonBody, resolveBodyPath, readString, json });
  }
  if (method === 'POST' && tail === 'commit-message') {
    const body = await readJsonBody(request);
    const workspace = readString(body, 'workspace');
    if (!workspace) return json({ error: 'workspace is required' }, { status: 400 });
    const changes = await getGitChanges(workspace, 'full', gitChangesCoordinator);
    if (!changes.isGitRepo) return json({ error: 'Not a git repository' }, { status: 400 });
    if (changes.changedFiles === 0)
      return json({ error: 'No changes to summarize' }, { status: 400 });
    const first = changes.files[0];
    const action =
      first?.status === 'added' ? 'add' : first?.status === 'deleted' ? 'remove' : 'update';
    return json({
      message: `chore: ${action} ${first ? basename(first.path) : 'workspace files'}`,
    });
  }
  return notFound(`/file/${tail}`);
}

async function streamWorkspaceMedia(
  absolutePath: string,
  contentType: string,
  rangeHeader: string | null,
): Promise<Response> {
  const info = await stat(absolutePath);
  if (!info.isFile()) return json({ error: 'File not found', code: 'NOT_FOUND' }, { status: 404 });
  const range = parseSingleByteRange(rangeHeader, info.size);
  if (rangeHeader && !range) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${info.size}`, 'Accept-Ranges': 'bytes' },
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, info.size - 1);
  const stream = createReadStream(absolutePath, { start, end });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: range ? 206 : 200,
    headers: {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'Content-Length': String(Math.max(0, end - start + 1)),
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      ...(contentType === 'image/svg+xml'
        ? {
            'Content-Security-Policy':
              "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
          }
        : {}),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
    },
  });
}

function parseSingleByteRange(
  value: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || size <= 0) return null;
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (!startText && !endText) return null;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function ideLauncherErrorResponse(error: unknown): Response {
  if (error instanceof IdeLauncherError) {
    return json({ error: error.message, code: error.code }, { status: error.status });
  }
  return json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 });
}

async function serveFilePreview(
  url: URL,
  headers?: Headers,
  metrics?: ModuleMetricsReporter,
): Promise<Response> {
  const filePath = requiredQuery(url, 'path');
  if (filePath instanceof Response) return filePath;
  if (filePath.includes('..')) {
    return json({ error: 'Path traversal not allowed' }, { status: 403 });
  }
  const contentType = getWorkspaceImagePreviewMimeType(filePath);
  if (!contentType) {
    return json({ error: 'Only image files are allowed' }, { status: 403 });
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return json({ error: 'File not found' }, { status: 404 });
    const fileTooLarge = remoteControlFileSizeLimitResponse(headers, info.size, metrics, 'preview');
    if (fileTooLarge) return fileTooLarge;
    const data = await readFile(filePath);
    const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return new Response(body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch {
    return json({ error: 'File not found' }, { status: 404 });
  }
}

async function routeFsApi(method: string, tail: string, url: URL): Promise<Response> {
  if (method === 'GET' && tail === 'dirs') {
    const directory = url.searchParams.get('directory') || homedir();
    const query = url.searchParams.get('query') ?? '';
    const maxdepth = clampInt(url.searchParams.get('maxdepth'), query ? 8 : 1, 1, 10);
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
    const hideDotFiles = url.searchParams.get('hideDotFiles') !== 'false';
    return json(await listDirs(directory, query, maxdepth, offset, limit, hideDotFiles));
  }
  if (method === 'GET' && tail === 'git-info') {
    const targetPath = requiredQuery(url, 'path');
    if (targetPath instanceof Response) return targetPath;
    const gitFile = resolve(targetPath, '.git');
    try {
      const info = await stat(gitFile);
      const isInsideWorktree = info.isFile();
      const hasHead = await probeGitWorkspaceHasHead(gitFile, info);
      return json({ isGitWorkspace: true, isInsideWorktree, hasHead });
    } catch {
      return json({ isGitWorkspace: false, isInsideWorktree: false, hasHead: false });
    }
  }
  return notFound(`/fs/${tail}`);
}

/**
 * Pure-fs probe for whether the workspace at `.git` has a resolvable HEAD
 * commit. Returns `false` for the unborn case (`git init` with no
 * commits — HEAD points to `refs/heads/<branch>` but the ref file does
 * not exist yet, so `git worktree add main` would fail with
 * `fatal: invalid reference: main` and BranchPill's base-ref picker
 * would be empty).
 *
 * Stays in-process (no `git` subprocess) so the render-gate probe path
 * keeps the same lightweight semantics as the existing `stat(.git)`
 * probe.
 *
 * @param gitFilePath  resolved path to the workspace's `.git`
 * @param gitFileInfo  stat() of `gitFilePath` — directory (main checkout)
 *                     vs. file (worktree gitlink) decides which gitdir
 *                     houses HEAD.
 */
async function probeGitWorkspaceHasHead(gitFilePath: string, gitFileInfo: Stats): Promise<boolean> {
  try {
    let gitDir: string;
    if (gitFileInfo.isDirectory()) {
      gitDir = gitFilePath;
    } else if (gitFileInfo.isFile()) {
      // worktree gitlink: ".git" contains "gitdir: <path-to-real-gitdir>".
      const linkContent = (await readFile(gitFilePath, 'utf8')).trim();
      const linkMatch = linkContent.match(/^gitdir:\s*(.+)$/m);
      const linkedDir = linkMatch?.[1]?.trim();
      if (!linkedDir) return false;
      gitDir = isAbsolute(linkedDir) ? linkedDir : resolve(dirname(gitFilePath), linkedDir);
    } else {
      return false;
    }
    const headContent = (await readFile(resolve(gitDir, 'HEAD'), 'utf8')).trim();
    // Detached HEAD: 40-64 hex chars (sha1/sha256). Always backed by an
    // object, so any commit at all means hasHead=true.
    if (/^[0-9a-f]{40,64}$/i.test(headContent)) return true;
    const symMatch = headContent.match(/^ref:\s*(.+)$/);
    const refName = symMatch?.[1]?.trim();
    if (!refName) return false;
    // For linked worktrees, refs live under the main gitdir (resolved via
    // the `commondir` file). For a top-level gitdir, commondir is absent
    // (or `.`).
    let refsBaseDir = gitDir;
    try {
      const commonRel = (await readFile(resolve(gitDir, 'commondir'), 'utf8')).trim();
      if (commonRel) {
        refsBaseDir = isAbsolute(commonRel) ? commonRel : resolve(gitDir, commonRel);
      }
    } catch {
      // No `commondir` → main checkout. Keep `refsBaseDir = gitDir`.
    }
    try {
      // Loose ref: <gitdir>/refs/heads/<branch> exists as a regular file.
      const looseInfo = await stat(resolve(refsBaseDir, refName));
      if (looseInfo.isFile()) return true;
    } catch {
      // Loose ref missing → fall through to packed-refs.
    }
    try {
      const packed = await readFile(resolve(refsBaseDir, 'packed-refs'), 'utf8');
      for (const line of packed.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2 && parts[1] === refName) return true;
      }
    } catch {
      // No packed-refs file → fall through.
    }
    return false;
  } catch {
    // Any unexpected probe error (permission denied, unreadable HEAD,
    // partial git layout) is treated as "no HEAD yet" — the conservative
    // default that disables `git worktree add` rather than enabling it
    // against an unverified ref.
    return false;
  }
}

async function routeGitApi(
  method: string,
  request: Request,
  tail: string,
  url: URL,
  gitChangesCoordinator: WorkspaceGitChangesCoordinator<GitChangesBase, GitChangesInfo>,
): Promise<Response> {
  if (method === 'GET' && tail === 'probe') {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response) return workspace;
    return json({ isGitRepo: await isGitRepo(workspace) });
  }
  if (method === 'GET' && tail === 'changes') {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response) return workspace;
    const mode: GitChangesMode = url.searchParams.get('mode') === 'fast' ? 'fast' : 'full';
    return json(await getGitChanges(workspace, mode, gitChangesCoordinator));
  }
  if (method === 'GET' && tail === 'metadata') {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response) return workspace;
    return json(await getGitMetadata(workspace));
  }
  if (method === 'GET' && tail === 'branches') {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response) return workspace;
    const includeRemote = url.searchParams.get('includeRemote') === 'true';
    return json(await getGitBranches(workspace, includeRemote));
  }
  if (method === 'GET' && tail === 'branch-picker') {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response) return workspace;
    const [branchInfo, worktreeInfo] = await Promise.all([
      getGitBranches(workspace, false),
      listWorkspaceGitWorktrees(workspace),
    ]);
    if (!branchInfo.success) return json(branchInfo);
    return json({
      success: true,
      current: branchInfo.current,
      branches: branchInfo.branches,
      local: branchInfo.local,
      worktrees: Array.isArray(worktreeInfo.worktrees) ? worktreeInfo.worktrees : [],
    });
  }
  if (method === 'GET' && tail === 'default-branch') {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response) return workspace;
    return json(await getDefaultBranch(workspace));
  }
  if (method === 'POST' && tail === 'checkout') {
    const body = await readJsonBody(request);
    const invalid = await validateGitBranchBody(body);
    if (invalid) return invalid;
    return json(
      await gitMutation(body, ['checkout', readString(body, 'branch')], gitChangesCoordinator),
    );
  }
  if (method === 'POST' && tail === 'create-branch') {
    const body = await readJsonBody(request);
    const invalid = await validateGitBranchBody(body);
    if (invalid) return invalid;
    return json(
      await gitMutation(
        body,
        ['checkout', '-b', readString(body, 'branch')],
        gitChangesCoordinator,
      ),
    );
  }
  if (method === 'POST' && tail === 'commit') {
    const body = await readJsonBody(request);
    const message = readString(body, 'message');
    if (!message) return json({ success: false, error: 'message is required' }, { status: 400 });
    const workspace = readString(body, 'workspace');
    if (!workspace)
      return json({ success: false, error: 'workspace is required' }, { status: 400 });
    const result = await withGitChangesInvalidation(workspace, gitChangesCoordinator, async () => {
      if (body.includeUnstaged !== false) {
        await git(['add', '--all'], workspace);
      }
      return await git(['commit', '-m', message], workspace);
    });
    return json(toMutationResult(result));
  }
  if (method === 'POST' && tail === 'push') {
    const body = await readJsonBody(request);
    const workspace = readString(body, 'workspace');
    if (!workspace)
      return json({ success: false, error: 'workspace is required' }, { status: 400 });
    const result = await git(['push'], workspace);
    if (
      result.code !== 0 &&
      /no upstream branch|set-upstream|--set-upstream/i.test(result.stderr)
    ) {
      return json(toMutationResult(await git(['push', '-u', 'origin', 'HEAD'], workspace)));
    }
    return json(toMutationResult(result));
  }
  if (method === 'POST' && tail === 'change-action') {
    const body = await readJsonBody(request);
    return json(await applyGitFileChangeAction(body, gitChangesCoordinator));
  }
  if (method === 'GET' && tail === 'worktrees') {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response) return workspace;
    return json(await listWorkspaceGitWorktrees(workspace));
  }
  if (method === 'POST' && tail === 'worktrees') {
    const body = await readJsonBody(request);
    const workspace = readString(body, 'workspace');
    if (!workspace)
      return json({ success: false, error: 'workspace is required' }, { status: 400 });
    const options = readRecord(body, 'options') ?? {};
    const branch = readString(options, 'branch') ?? generateDefaultWorktreeBranch();
    const invalidBranch = await validateGitBranch(workspace, branch);
    if (invalidBranch) return invalidBranch;
    const dirName = readString(options, 'dirName') ?? branch.replace(/[^a-zA-Z0-9._-]+/g, '-');
    const base = readString(options, 'base') ?? 'HEAD';
    const workspaceRoot = await gitRoot(workspace);
    if (!workspaceRoot)
      return json({ success: false, error: 'Not a git repository' }, { status: 400 });
    const worktreeDir = await resolveWorktreeTarget(workspaceRoot, dirName);
    if (!worktreeDir) {
      return json({ success: false, error: 'Invalid worktree dirName' }, { status: 400 });
    }
    const result = await git(['worktree', 'add', '-b', branch, worktreeDir, base], workspaceRoot);
    return json(
      result.code === 0
        ? { success: true, worktreeDir, branch, resolvedBase: base }
        : { success: false, error: result.stderr || result.stdout },
    );
  }
  if (method === 'POST' && tail === 'worktrees/remove') {
    const body = await readJsonBody(request);
    const workspace = readString(body, 'workspace');
    const worktreeDir = readString(body, 'worktreeDir');
    if (!workspace)
      return json({ success: false, error: 'workspace is required' }, { status: 400 });
    if (!worktreeDir)
      return json({ success: false, error: 'worktreeDir is required' }, { status: 400 });
    return json(toMutationResult(await git(['worktree', 'remove', worktreeDir], workspace)));
  }
  return notFound(`/file/git/${tail}`);
}

export async function listFileTree(workspace: string, subPath: string): Promise<unknown[]> {
  const root = resolveWorkspace(workspace);
  const realRoot = await realpath(root).catch(() => undefined);
  if (!realRoot) return [];
  const dir = await resolveWorkspacePath(workspace, subPath);
  if (!dir) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const relativeBase = relative(realRoot, dir);
  return entries
    .filter((entry) => entry.name !== '.git')
    .map((entry) => {
      const nodePath =
        !relativeBase || relativeBase === '.' ? entry.name : join(relativeBase, entry.name);
      return {
        name: entry.name,
        path: toPortableRelativePath(nodePath),
        type: entry.isDirectory() ? 'directory' : 'file',
        ignored: entry.isDirectory() && HIDDEN_SEARCH_DIRS.has(entry.name),
      };
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

interface WorkspaceFileReadOutcome {
  value: Record<string, unknown>;
  readSucceeded: boolean;
}

async function readWorkspaceFile(
  workspace: string,
  filePath: string,
): Promise<Record<string, unknown>> {
  return (await readWorkspaceFileOutcome(workspace, filePath)).value;
}

async function readWorkspaceFileOutcome(
  workspace: string,
  filePath: string,
): Promise<WorkspaceFileReadOutcome> {
  const absolute = await resolveWorkspacePath(workspace, filePath);
  if (!absolute) {
    return {
      value: { type: 'binary', content: '', error: 'Path traversal denied' },
      readSucceeded: false,
    };
  }
  const ext = extname(filePath).toLowerCase();
  const previewBinaryMime = PREVIEW_BINARY_MIME_TYPES.get(ext);
  if (previewBinaryMime) {
    try {
      return {
        value: {
          type: 'binary',
          content: (await readFile(absolute)).toString('base64'),
          encoding: 'base64',
          mimeType: previewBinaryMime,
        },
        readSucceeded: true,
      };
    } catch {
      return {
        value: { type: 'binary', content: '', mimeType: previewBinaryMime },
        readSucceeded: false,
      };
    }
  }
  if (BINARY_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(ext)) {
    return { value: { type: 'binary', content: '' }, readSucceeded: true };
  }
  try {
    const bytes = await readFile(absolute);
    const utf16Text = decodeUtf16TextBytes(bytes);
    if (utf16Text !== undefined) {
      return { value: { type: 'text', content: utf16Text }, readSucceeded: true };
    }
    if (!TEXT_EXTENSIONS.has(ext) && isProbablyBinary(bytes)) {
      return { value: { type: 'binary', content: '' }, readSucceeded: true };
    }
    return {
      value: { type: 'text', content: bytes.toString('utf-8') },
      readSucceeded: true,
    };
  } catch {
    return { value: { type: 'text', content: '' }, readSucceeded: false };
  }
}

async function remoteControlFileContentLimitResponse(
  headers: Headers,
  workspace: string,
  filePath: string,
  metrics: ModuleMetricsReporter | undefined,
  route: 'content' | 'preview',
): Promise<Response | undefined> {
  if (headers.get(RC_REQUEST_SOURCE_HEADER) !== RC_REQUEST_SOURCE_VALUE) return undefined;
  const absolute = await resolveWorkspacePath(workspace, filePath);
  if (!absolute) return undefined;
  let info: Stats;
  try {
    info = await stat(absolute);
  } catch {
    return undefined;
  }
  if (!info.isFile()) return undefined;
  return remoteControlFileSizeLimitResponse(headers, info.size, metrics, route);
}

function remoteControlFileSizeLimitResponse(
  headers: Headers | undefined,
  sizeBytes: number,
  metrics: ModuleMetricsReporter | undefined,
  route: 'content' | 'preview',
): Response | undefined {
  if (!headers || headers.get(RC_REQUEST_SOURCE_HEADER) !== RC_REQUEST_SOURCE_VALUE) {
    return undefined;
  }
  const maxBytes =
    readPositiveIntegerHeader(headers, RC_FILE_CONTENT_MAX_BYTES_HEADER) ??
    DEFAULT_RC_FILE_CONTENT_MAX_BYTES;
  if (sizeBytes <= maxBytes) return undefined;
  metrics?.incr('remote_control_file_content_rejected_total', {
    reason: 'too_large',
    route,
  });
  return json(
    {
      error: 'File content is too large for remote-control inline response',
      code: 'REMOTE_CONTROL_FILE_CONTENT_TOO_LARGE',
      sizeBytes,
      maxBytes,
    },
    { status: 413 },
  );
}

function readPositiveIntegerHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

async function readWorkspaceFileForDiffScope(
  workspace: string,
  filePath: string,
  scope: GitChangeScope,
): Promise<Record<string, unknown>> {
  if (scope !== 'staged') return readWorkspaceFile(workspace, filePath);
  const indexContent = await readWorkspaceTextFileFromGitIndex(workspace, filePath);
  return indexContent ?? { type: 'text', content: '' };
}

async function readWorkspaceTextFileFromGitIndex(
  workspace: string,
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  const ext = extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(ext)) return undefined;
  let normalizedPath: string;
  try {
    normalizedPath = normalizeGitActionPath(filePath);
  } catch {
    return undefined;
  }
  const result = await git(['show', `:${normalizedPath}`], workspace);
  if (result.code !== 0) return undefined;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/u.test(result.stdout)) {
    return undefined;
  }
  return { type: 'text', content: result.stdout };
}

export async function searchFiles(
  workspace: string,
  query: string,
  limit: number,
): Promise<string[]> {
  const root = resolveWorkspace(workspace);
  const needle = query.trim().toLowerCase();
  if (!needle || limit <= 0) return [];

  const candidates =
    (await listGitSearchCandidates(workspace)) ?? (await listFsSearchCandidates(root));
  return candidates
    .filter(isSearchableRelativePath)
    .map((filePath) => ({ filePath, score: scoreFileSearchCandidate(filePath, needle) }))
    .filter((item): item is { filePath: string; score: number } => item.score !== undefined)
    .sort((a, b) => a.score - b.score || a.filePath.localeCompare(b.filePath))
    .slice(0, limit)
    .map((item) => toPortableRelativePath(item.filePath));
}

async function listGitSearchCandidates(workspace: string): Promise<string[] | undefined> {
  const [result, deletedResult] = await Promise.all([
    git(['ls-files', '-co', '--exclude-standard', '-z'], workspace),
    git(['ls-files', '-d', '-z'], workspace),
  ]);
  if (result.code !== 0 || deletedResult.code !== 0) return undefined;
  const deleted = new Set(deletedResult.stdout.split('\0').filter(Boolean));
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const filePath of result.stdout.split('\0')) {
    if (
      !filePath ||
      deleted.has(filePath) ||
      seen.has(filePath) ||
      !isSearchableRelativePath(filePath)
    ) {
      continue;
    }
    seen.add(filePath);
    candidates.push(filePath);
  }
  return candidates;
}

async function listFsSearchCandidates(root: string): Promise<string[]> {
  const results: string[] = [];
  await walk(root, async (absolute, entry) => {
    if (entry.isDirectory()) return true;
    const rel = relative(root, absolute);
    if (isSearchableRelativePath(rel)) results.push(rel);
    return true;
  });
  return results;
}

function scoreFileSearchCandidate(filePath: string, needle: string): number | undefined {
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  const normalizedName = basename(normalizedPath);
  const stem = normalizedName.slice(0, normalizedName.length - extname(normalizedName).length);
  const pathIndex = normalizedPath.indexOf(needle);
  if (pathIndex < 0) return undefined;

  const nameIndex = normalizedName.indexOf(needle);
  const segments = normalizedPath.split('/').filter(Boolean);
  const matchingSegmentIndex = segments.findIndex((segment) => segment.startsWith(needle));
  const tieBreaker = normalizedPath.length * FILE_SEARCH_PATH_TIEBREAKER_WEIGHT;
  const depthPenalty = Math.max(0, segments.length - 1);

  if (normalizedName === needle) return tieBreaker;
  if (stem === needle) return 5 + tieBreaker;
  if (normalizedName.startsWith(needle)) return 10 + normalizedName.length + tieBreaker;
  if (nameIndex >= 0) return 20 + nameIndex + normalizedName.length + tieBreaker;
  if (matchingSegmentIndex >= 0) return 40 + matchingSegmentIndex + depthPenalty + tieBreaker;
  return 80 + pathIndex + depthPenalty + tieBreaker;
}

function isSearchableRelativePath(filePath: string): boolean {
  return filePath
    .split(/[\\/]/u)
    .filter(Boolean)
    .every((segment) => !HIDDEN_SEARCH_DIRS.has(segment));
}

async function listDirs(
  directory: string,
  query: string,
  maxDepth: number,
  offset: number,
  limit: number,
  hideDotFiles: boolean,
): Promise<{ entries: Array<{ relative: string; absolute: string; type: 'dir' }>; total: number }> {
  const root = resolvePath(directory);
  const entries: Array<{ relative: string; absolute: string; type: 'dir' }> = [];
  const needle = query.toLowerCase();
  await walk(root, async (absolute, entry, depth) => {
    if (!entry.isDirectory()) return false;
    if (depth > maxDepth) return false;
    const rel = relative(root, absolute);
    if (hideDotFiles && basename(absolute).startsWith('.')) return false;
    if (
      !query ||
      rel.toLowerCase().includes(needle) ||
      basename(absolute).toLowerCase().includes(needle)
    ) {
      entries.push({ relative: rel ? `${rel}/` : absolute, absolute, type: 'dir' });
    }
    return true;
  });
  entries.sort((a, b) => a.relative.localeCompare(b.relative));
  return { entries: entries.slice(offset, offset + limit), total: entries.length };
}

async function walk(
  root: string,
  visit: (absolute: string, entry: Dirent, depth: number) => Promise<boolean> | boolean,
  depth = 0,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (HIDDEN_SEARCH_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
    const absolute = join(root, entry.name);
    const shouldDescend = await visit(absolute, entry, depth + 1);
    if (shouldDescend && entry.isDirectory()) {
      await walk(absolute, visit, depth + 1);
    }
  }
}

async function getGitChanges(
  workspace: string,
  mode: GitChangesMode,
  gitChangesCoordinator: WorkspaceGitChangesCoordinator<GitChangesBase, GitChangesInfo>,
): Promise<GitChangesInfo> {
  return mode === 'fast'
    ? (await gitChangesCoordinator.getChanges(workspace, 'fast')).changes
    : await gitChangesCoordinator.getChanges(workspace, 'full');
}

async function captureGitChangesBase(workspace: string): Promise<GitChangesBase> {
  const repo = await isGitRepo(workspace);
  if (!repo) return { changes: emptyChanges(false), untrackedPaths: new Set() };
  const hasHead = (await git(['rev-parse', '--verify', 'HEAD'], workspace)).code === 0;
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], workspace);
  if (status.code !== 0) {
    return {
      changes: {
        ...emptyChanges(true),
        hasHead,
        error: status.stderr || status.stdout,
      },
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

async function enrichGitChanges(workspace: string, base: GitChangesBase): Promise<GitChangesInfo> {
  if (!base.changes.isGitRepo || base.changes.error) return base.changes;

  const files = base.changes.files.map((file) => ({ ...file }));
  const statsByScope = new Map<
    ScopedGitChangeScope,
    Map<string, { additions: number; deletions: number }>
  >();
  let lineStatsComplete = true;
  await Promise.all(
    gitDiffScopes('all').map(async (scope) => {
      const numstat = await git(gitNumstatArgs(scope, base.changes.hasHead), workspace);
      const parsedNumstat = parseNumstat(numstat.stdout);
      if (numstat.code !== 0 || !parsedNumstat.complete) lineStatsComplete = false;
      statsByScope.set(scope, parsedNumstat.stats);
    }),
  );
  for (const file of files) {
    const fileStats = file.changeScope
      ? statsByScope.get(file.changeScope)?.get(file.path)
      : undefined;
    if (fileStats) {
      file.additions = fileStats.additions;
      file.deletions = fileStats.deletions;
    } else if (file.status === 'added' && base.untrackedPaths.has(file.path)) {
      const lines = await readWorkspaceTextLines(workspace, file.path);
      if (lines) {
        file.additions = lines.length;
      } else {
        lineStatsComplete = false;
      }
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

export async function getGitMetadata(workspace: string): Promise<Record<string, unknown>> {
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
  const counts =
    upstream.code === 0
      ? await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], workspace)
      : undefined;
  const [aheadRaw, behindRaw] = counts?.stdout.trim().split(/\s+/, 2) ?? [];
  const [gitDir, gitCommonDir] = gitDirectories.stdout
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    isGitRepo: true,
    branch: branch.stdout.trim(),
    isWorktree:
      gitDirectories.code === 0 &&
      gitDir !== undefined &&
      gitCommonDir !== undefined &&
      resolve(workspace, gitDir) !== resolve(workspace, gitCommonDir),
    ahead: Number.parseInt(aheadRaw ?? '0', 10) || 0,
    behind: Number.parseInt(behindRaw ?? '0', 10) || 0,
    hasUpstream: upstream.code === 0,
    hasRemote: remotes.stdout.trim().length > 0,
    canPush: remotes.stdout.trim().length > 0,
    hasHead: (await git(['rev-parse', '--verify', 'HEAD'], workspace)).code === 0,
  };
}

async function getGitBranches(
  workspace: string,
  includeRemote: boolean,
): Promise<Record<string, unknown>> {
  if (!(await isGitRepo(workspace)))
    return { success: false, current: '', branches: [], error: 'Not a git repository' };
  const current = (await git(['branch', '--show-current'], workspace)).stdout.trim();
  const local = (await git(['branch', '--format=%(refname:short)'], workspace)).stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const remote = includeRemote
    ? (await git(['branch', '-r', '--format=%(refname:short)'], workspace)).stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.endsWith('/HEAD'))
    : [];
  return { success: true, current, branches: local, local, ...(includeRemote ? { remote } : {}) };
}

async function getDefaultBranch(workspace: string): Promise<Record<string, unknown>> {
  const symbolic = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], workspace);
  if (symbolic.code === 0 && symbolic.stdout.trim()) {
    return {
      success: true,
      branch: symbolic.stdout.trim().replace(/^origin\//, ''),
      source: 'symbolic-ref',
    };
  }
  const branches = await getGitBranches(workspace, false);
  const local = Array.isArray(branches.local) ? branches.local : [];
  const branch = local.includes('main')
    ? 'main'
    : local.includes('master')
      ? 'master'
      : String(branches.current ?? '');
  return branch
    ? { success: true, branch, source: 'fallback-probe' }
    : { success: false, error: 'No default branch found' };
}

async function isGitRepo(workspace: string): Promise<boolean> {
  return (await git(['rev-parse', '--is-inside-work-tree'], workspace)).stdout.trim() === 'true';
}

async function gitMutation(
  body: Record<string, unknown>,
  args: Array<string | undefined>,
  gitChangesCoordinator: WorkspaceGitChangesCoordinator<GitChangesBase, GitChangesInfo>,
): Promise<Record<string, unknown>> {
  const workspace = readString(body, 'workspace');
  if (!workspace) return { success: false, error: 'workspace is required' };
  if (args.some((arg) => !arg)) return { success: false, error: 'missing git argument' };
  return toMutationResult(
    await withGitChangesInvalidation(workspace, gitChangesCoordinator, () =>
      git(args as string[], workspace),
    ),
  );
}

async function withGitChangesInvalidation<T>(
  workspace: string,
  gitChangesCoordinator: WorkspaceGitChangesCoordinator<GitChangesBase, GitChangesInfo>,
  operation: () => Promise<T>,
): Promise<T> {
  // The first barrier detaches requests from the snapshot that existed before
  // the mutation. The second detaches any read that raced while Git was
  // mutating, so post-mutation callers are forced onto a fresh base.
  gitChangesCoordinator.invalidate(workspace);
  try {
    return await operation();
  } finally {
    gitChangesCoordinator.invalidate(workspace);
  }
}

type GitFileChangeAction = 'stage' | 'unstage' | 'discard';

interface DiffContextResponse {
  contextContent: string;
  changeScope?: ScopedGitChangeScope;
}

async function readDiffContext(
  workspace: string,
  filePath: string,
  scope: GitChangeScope,
): Promise<DiffContextResponse | undefined> {
  const contextContent =
    scope === 'staged'
      ? await readTextFromGitIndex(workspace, filePath)
      : await readTextForWorkspaceDiff(workspace, filePath);
  if (contextContent === undefined) return undefined;
  return {
    contextContent,
    ...(scope === 'staged' || scope === 'unstaged' ? { changeScope: scope } : {}),
  };
}

async function readTextFromGitIndex(
  workspace: string,
  filePath: string,
): Promise<string | undefined> {
  let normalizedPath: string;
  try {
    normalizedPath = normalizeGitActionPath(filePath);
  } catch {
    return undefined;
  }
  const result = await git(['show', `:${normalizedPath}`], workspace);
  if (result.code !== 0 || !isDiffContextTextContent(result.stdout)) return undefined;
  return result.stdout;
}

async function readTextForWorkspaceDiff(
  workspace: string,
  filePath: string,
): Promise<string | undefined> {
  const content = await readWorkspaceFile(workspace, filePath);
  if (content.type !== 'text' || typeof content.content !== 'string') return undefined;
  return isDiffContextTextContent(content.content) ? content.content : undefined;
}

function readGitDiffScope(scope: string | null): GitChangeScope {
  return scope === 'staged' || scope === 'unstaged' || scope === 'all' ? scope : 'all';
}

function isDiffContextTextContent(content: string): boolean {
  return (
    content.length > 0 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/u.test(content)
  );
}

async function applyGitFileChangeAction(
  body: Record<string, unknown>,
  gitChangesCoordinator: WorkspaceGitChangesCoordinator<GitChangesBase, GitChangesInfo>,
): Promise<Record<string, unknown>> {
  const workspace = readString(body, 'workspace');
  if (!workspace) return { success: false, error: 'workspace is required' };
  if (!(await isGitRepo(workspace))) return { success: false, error: 'Not a git repository' };

  const action = readGitFileChangeAction(body);
  if (!action) return { success: false, error: 'action is required' };
  const scope = readGitChangeScope(body);
  let paths: string[];
  try {
    paths = normalizeGitActionPaths(
      resolvePath(workspace),
      resolveGitChangeActionPaths(body, scope),
    );
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (paths.length === 0) return { success: false, error: 'No paths provided' };

  return await withGitChangesInvalidation(workspace, gitChangesCoordinator, async () => {
    if (action === 'stage') {
      return toMutationResult(await git(['add', '--', ...paths], workspace));
    }
    if (action === 'unstage') {
      return toMutationResult(await git(['restore', '--staged', '--', ...paths], workspace));
    }
    if (scope === 'staged') {
      return {
        success: false,
        error: 'Staged changes cannot be discarded directly. Unstage them first.',
      };
    }
    return discardGitPaths(workspace, paths);
  });
}

function readGitFileChangeAction(body: Record<string, unknown>): GitFileChangeAction | undefined {
  const action = readString(body, 'action');
  return action === 'stage' || action === 'unstage' || action === 'discard' ? action : undefined;
}

function readGitChangeScope(body: Record<string, unknown>): GitChangeScope {
  const scope = readString(body, 'scope');
  return scope === 'staged' || scope === 'unstaged' || scope === 'all' ? scope : 'all';
}

function resolveGitChangeActionPaths(
  body: Record<string, unknown>,
  scope: GitChangeScope,
): string[] {
  const path = readString(body, 'path');
  const originalPath = readString(body, 'originalPath') ?? readString(body, 'original_path');
  if (path && originalPath && path !== originalPath) {
    if (scope === 'staged') return [originalPath];
    if (scope === 'unstaged') return [path];
    return [originalPath, path];
  }
  const paths = readStringArray(body, 'paths');
  return paths.length > 0
    ? paths
    : [path, originalPath].filter((item): item is string => Boolean(item));
}

async function discardGitPaths(
  workspace: string,
  paths: string[],
): Promise<Record<string, unknown>> {
  const status = await git(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths],
    workspace,
  );
  if (status.code !== 0) return toMutationResult(status);
  const parsed = parsePorcelainStatus(status.stdout);
  const untrackedPaths = new Set(parsed.untrackedPaths);
  const trackedPaths = paths.filter((filePath) => !untrackedPaths.has(filePath));
  if (trackedPaths.length > 0) {
    const result = await git(['restore', '--worktree', '--', ...trackedPaths], workspace);
    if (result.code !== 0) return toMutationResult(result);
  }
  await Promise.all(
    Array.from(untrackedPaths, async (filePath) => {
      const absolutePath = resolvePath(join(workspace, ...filePath.split('/')));
      if (!isPathInside(resolvePath(workspace), absolutePath)) return;
      await rm(absolutePath, { recursive: true, force: true });
    }),
  );
  return { success: true };
}

function normalizeGitActionPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (
    !trimmed ||
    trimmed.includes('\0') ||
    isAbsolute(trimmed) ||
    /^[a-zA-Z]:[\\/]/u.test(trimmed)
  ) {
    throw new Error(`Invalid git path: ${filePath}`);
  }
  const normalized = posix.normalize(trimmed.replace(/\\/gu, '/'));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Invalid git path: ${filePath}`);
  }
  return normalized;
}

function normalizeGitActionPaths(workspaceRoot: string, paths: string[]): string[] {
  const normalizedPaths = new Set<string>();
  for (const filePath of paths) {
    const normalized = normalizeGitActionPath(filePath);
    const absolutePath = resolvePath(join(workspaceRoot, ...normalized.split('/')));
    if (!isPathInside(workspaceRoot, absolutePath)) {
      throw new Error(`Path is outside workspace: ${filePath}`);
    }
    normalizedPaths.add(normalized);
  }
  return Array.from(normalizedPaths);
}

async function validateGitBranchBody(body: Record<string, unknown>): Promise<Response | undefined> {
  const workspace = readString(body, 'workspace');
  if (!workspace) return json({ success: false, error: 'workspace is required' }, { status: 400 });
  const branch = readString(body, 'branch');
  return branch
    ? validateGitBranch(workspace, branch)
    : json({ success: false, error: 'branch is required' }, { status: 400 });
}

async function validateGitBranch(workspace: string, branch: string): Promise<Response | undefined> {
  if (branch.startsWith('-') || branch.startsWith('@') || branch.includes('\0')) {
    return json({ success: false, error: `Invalid git branch name: ${branch}` }, { status: 400 });
  }
  const check = await git(['check-ref-format', `refs/heads/${branch}`], workspace);
  return check.code === 0
    ? undefined
    : json(
        { success: false, error: `Invalid git branch name: ${check.stderr || check.stdout}` },
        { status: 400 },
      );
}

async function git(args: string[], workspace: string): Promise<GitRunResult> {
  return await gitCommandRunner(args, workspace);
}
function gitDiffScopes(scope: GitChangeScope): ScopedGitChangeScope[] {
  return scope === 'staged' || scope === 'unstaged' ? [scope] : ['staged', 'unstaged'];
}

function gitDiffArgs(scope: GitChangeScope, hasHead: boolean, paths: string[] = []): string[] {
  const args = ['diff', '--no-ext-diff', '--unified=3'];
  if (scope === 'staged') {
    args.push('--cached');
    if (hasHead) args.push('HEAD');
  } else if (scope === 'all') {
    if (hasHead) {
      args.push('HEAD');
    } else {
      args.push('--cached');
    }
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

function parsePorcelainStatus(stdout: string): {
  files: GitChangedFile[];
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  untrackedPaths: Set<string>;
} {
  const records = stdout.split('\0');
  const files: GitChangedFile[] = [];
  const untrackedPaths = new Set<string>();
  let stagedFiles = 0;
  let unstagedFiles = 0;
  let untrackedFiles = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const x = record[0] ?? ' ';
    const y = record[1] ?? ' ';
    const path = record.slice(3);
    if (!path) continue;
    let originalPath: string | undefined;
    if ((x === 'R' || x === 'C') && records[index + 1]) {
      index += 1;
      originalPath = records[index];
    }
    if (x === '?' && y === '?') {
      untrackedFiles += 1;
      untrackedPaths.add(path);
      files.push({
        path,
        status: 'added',
        additions: 0,
        deletions: 0,
        changeScope: 'unstaged',
      });
      unstagedFiles += 1;
      continue;
    } else {
      if (x !== ' ') stagedFiles += 1;
      if (y !== ' ') unstagedFiles += 1;
    }
    if (x !== ' ') {
      files.push({
        path,
        ...(originalPath ? { originalPath } : {}),
        status: statusFromGitCode(x),
        additions: 0,
        deletions: 0,
        changeScope: 'staged',
      });
    }
    if (y !== ' ') {
      files.push({
        path,
        status: statusFromGitCode(y),
        additions: 0,
        deletions: 0,
        changeScope: 'unstaged',
      });
    }
  }
  return { files, stagedFiles, unstagedFiles, untrackedFiles, untrackedPaths };
}

function statusFromGitCode(code: string): GitChangedFile['status'] {
  if (code === 'A' || code === '?') return 'added';
  if (code === 'D') return 'deleted';
  return 'modified';
}

function parseNumstat(stdout: string): {
  stats: Map<string, { additions: number; deletions: number }>;
  complete: boolean;
} {
  const stats = new Map<string, { additions: number; deletions: number }>();
  let complete = true;
  const records = stdout.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record?.trim()) continue;
    const [addRaw, delRaw, ...pathParts] = record.split('\t');
    let filePath = pathParts.join('\t');
    if (!filePath && records[index + 2]) {
      index += 2;
      filePath = records[index] ?? '';
    }
    if (!filePath) continue;
    const additions = Number.parseInt(addRaw ?? '', 10);
    const deletions = Number.parseInt(delRaw ?? '', 10);
    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) complete = false;
    stats.set(filePath, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    });
  }
  return { stats, complete };
}

function splitDiffBlocksByFile(diff: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const block of diff.split(/(?=^diff --git )/mu)) {
    if (!block.trim()) continue;
    const match = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/mu.exec(block);
    const filePath = match?.[2] ?? match?.[1];
    if (filePath) blocks.set(unquoteGitPath(filePath), block.trimEnd());
  }
  return blocks;
}

function isBinaryDiff(diff: string): boolean {
  return /^Binary files /mu.test(diff) || /\nGIT binary patch\n/u.test(diff);
}

async function buildAddedFileDiff(
  workspace: string,
  filePath: string,
): Promise<{ diff: string; additions: number } | undefined> {
  if (!(await isUntrackedWorkspacePath(workspace, filePath))) return undefined;
  const lines = await readWorkspaceTextLines(workspace, filePath);
  if (!lines) return undefined;
  if (lines.length === 0) return undefined;
  return {
    additions: lines.length,
    diff: [
      `diff --git a/${filePath} b/${filePath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${filePath}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join('\n'),
  };
}

async function isUntrackedBinaryFile(workspace: string, filePath: string): Promise<boolean> {
  if (!(await isUntrackedWorkspacePath(workspace, filePath))) return false;
  const content = await readWorkspaceFile(workspace, filePath);
  return content.type === 'binary';
}

async function isUntrackedWorkspacePath(workspace: string, filePath: string): Promise<boolean> {
  const untracked = await git(
    ['ls-files', '--others', '-z', '--exclude-standard', '--', filePath],
    workspace,
  );
  return untracked.stdout
    .split('\0')
    .filter(Boolean)
    .some((line) => line === filePath);
}

async function readWorkspaceTextLines(
  workspace: string,
  filePath: string,
): Promise<string[] | undefined> {
  const outcome = await readWorkspaceFileOutcome(workspace, filePath);
  if (!outcome.readSucceeded) return undefined;
  const content = outcome.value;
  if (content.type !== 'text' || typeof content.content !== 'string') return undefined;
  const lines = content.content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function emptyChanges(repoAvailable: boolean): GitChangesInfo {
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

function toMutationResult(result: GitRunResult): Record<string, unknown> {
  return result.code === 0
    ? { success: true, output: result.stdout || result.stderr }
    : { success: false, error: result.stderr || result.stdout };
}

async function runOpenCommand(action: 'open' | 'reveal', target: string): Promise<Response> {
  const command = resolveOpenCommand(action, target, openCommandRuntime);
  if (!command) {
    return json(
      { error: `Opening files is not supported on ${openCommandRuntime.platform}` },
      { status: 501 },
    );
  }

  try {
    await openCommandRuntime.run(command.file, command.args, {
      windowsHide: !command.windowsShow,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
    });
    return json({ ok: true });
  } catch (error) {
    const code = getOpenCommandErrorCode(error);
    // explorer.exe can report a numeric non-zero exit code after Windows has
    // already accepted the open request. Preserve that compatibility, but do
    // not hide spawn failures such as ENOENT, EACCES, or EPERM.
    if (openCommandRuntime.platform === 'win32' && typeof code === 'number') {
      return json({ ok: true });
    }

    logger.warn(
      {
        action,
        platform: openCommandRuntime.platform,
        executable: basename(command.file),
        targetKind: extname(target) ? 'file' : 'directory',
        errorCode: code ?? 'UNKNOWN',
      },
      'Local file open command failed',
    );
    return json(
      { error: 'Unable to open the local file', code: 'OPEN_COMMAND_FAILED' },
      { status: 422 },
    );
  }
}

function getOpenCommandErrorCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as ExecFileException).code;
  return typeof code === 'string' || typeof code === 'number' ? code : undefined;
}

function resolveOpenCommand(
  action: 'open' | 'reveal',
  target: string,
  runtime: Pick<OpenCommandRuntime, 'platform' | 'env'> = openCommandRuntime,
):
  | { file: string; args: string[]; windowsShow?: boolean; windowsVerbatimArguments?: boolean }
  | undefined {
  if (runtime.platform === 'darwin') {
    return { file: 'open', args: action === 'reveal' ? ['-R', target] : [target] };
  }
  if (runtime.platform === 'win32') {
    const windowsDirectory = runtime.env.WINDIR || runtime.env.SystemRoot;
    const explorer = windowsDirectory
      ? win32.join(windowsDirectory, 'explorer.exe')
      : 'explorer.exe';
    return action === 'reveal'
      ? {
          file: explorer,
          args: [`/select,"${target}"`],
          windowsShow: true,
          windowsVerbatimArguments: true,
        }
      : {
          file: explorer,
          args: [`"${target}"`],
          windowsShow: true,
          windowsVerbatimArguments: true,
        };
  }
  if (runtime.platform === 'linux') {
    return { file: 'xdg-open', args: [action === 'reveal' ? dirname(target) : target] };
  }
  return undefined;
}

type ExistingWorkspacePathResult =
  | { ok: true; absolute: string }
  | { ok: false; status: number; error: string; code: string };

async function resolveBodyPath(
  body: Record<string, unknown>,
): Promise<{ absolute: string } | Response> {
  const workspace = readString(body, 'workspace');
  const filePath = readString(body, 'path');
  if (!workspace) return json({ error: 'workspace is required' }, { status: 400 });
  if (!filePath) return json({ error: 'path is required' }, { status: 400 });
  const resolved = await resolveExistingWorkspacePath(workspace, filePath);
  return resolved.ok
    ? { absolute: resolved.absolute }
    : json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
}

async function resolveWorkspacePath(workspace: string, child: string): Promise<string | undefined> {
  const root = resolveWorkspace(workspace);
  const target = resolveInside(root, child);
  if (!target) return undefined;
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    return isPathInside(realRoot, realTarget) ? realTarget : undefined;
  } catch {
    return undefined;
  }
}

async function resolveExistingWorkspacePath(
  workspace: string,
  child: string,
): Promise<ExistingWorkspacePathResult> {
  const root = resolveWorkspace(workspace);
  const target = resolveInside(root, child);
  if (!target) {
    return {
      ok: false,
      status: 400,
      error: 'Path traversal denied',
      code: 'PATH_TRAVERSAL',
    };
  }

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    return { ok: false, ...classifyExistingPathError(error, 'workspace') };
  }

  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch (error) {
    return { ok: false, ...classifyExistingPathError(error, 'file') };
  }

  if (!isPathInside(realRoot, realTarget)) {
    return {
      ok: false,
      status: 400,
      error: 'Path traversal denied',
      code: 'PATH_TRAVERSAL',
    };
  }

  return { ok: true, absolute: realTarget };
}

function resolveWorkspace(workspace: string): string {
  return resolvePath(workspace);
}

function resolveInside(root: string, child: string): string | undefined {
  const target = isAbsolute(child) ? resolve(child) : resolve(root, child);
  return isPathInside(root, target) ? target : undefined;
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function resolveWorktreeTarget(
  workspaceRoot: string,
  dirName: string,
): Promise<string | undefined> {
  if (isAbsolute(dirName)) return undefined;
  if (dirName !== basename(dirName) || dirName.includes('\\')) return undefined;
  const worktreeParent = join(workspaceRoot, '.worktrees');
  const lexicalTarget = resolveInside(worktreeParent, dirName);
  if (!lexicalTarget) return undefined;
  try {
    await mkdir(worktreeParent, { recursive: true });
    const [realRoot, realParent] = await Promise.all([
      realpath(workspaceRoot),
      realpath(worktreeParent),
    ]);
    if (!isPathInside(realRoot, realParent)) return undefined;
    const target = resolve(realParent, dirName);
    return isPathInside(realParent, target) ? target : undefined;
  } catch {
    return undefined;
  }
}

function isProbablyBinary(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  if (bytes.includes(0)) return true;
  try {
    FATAL_UTF8_DECODER.decode(bytes);
  } catch {
    return true;
  }
  const sampleLength = Math.min(bytes.length, 8_000);
  let controlBytes = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = bytes[index]!;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) controlBytes += 1;
  }
  return controlBytes / sampleLength > 0.3;
}

/**
 * Decodes a byte-order-marked UTF-16 payload into text.
 *
 * Windows-authored text formats (`.inf`, `.reg`, PowerShell output) are
 * routinely UTF-16LE, where every ASCII character carries a NUL padding byte.
 * `isProbablyBinary` rejects any buffer containing NUL, so without this decode
 * such files are reported as binary and never reach the code viewer.
 *
 * Only reached for extensions that are not already known binaries: those return
 * earlier, so a `.bin` that happens to start with `FF FE` stays binary.
 */
function decodeUtf16TextBytes(bytes: Buffer): string | undefined {
  if (bytes.length < 4 || bytes.length % 2 !== 0) return undefined;
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = bytes.subarray(2).toString('utf16le');
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    text = swapped.toString('utf16le');
  } else {
    return undefined;
  }
  return isProbablyBinaryText(text) ? undefined : text;
}

/** Control-character heuristic for already-decoded text, mirroring `isProbablyBinary`. */
function isProbablyBinaryText(text: string): boolean {
  if (text.length === 0) return false;
  if (text.includes('\u0000')) return true;
  const sampleLength = Math.min(text.length, 8_000);
  let controlChars = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) controlChars += 1;
  }
  return controlChars / sampleLength > 0.3;
}

function requiredQuery(url: URL, key: string): string | Response {
  const value = url.searchParams.get(key);
  return value || json({ error: `${key} is required` }, { status: 400 });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = (await request.json()) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function readRecord(
  data: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = data[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function unquoteGitPath(value: string): string {
  return value.replace(/^"|"$/g, '');
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers: { ...JSON_HEADERS, ...(init?.headers ?? {}) },
  });
}

function notFound(pathname: string): Response {
  return json({ error: `Local runtime route not found: ${pathname}` }, { status: 404 });
}
