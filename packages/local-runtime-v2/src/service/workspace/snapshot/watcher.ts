import { watch, type FSWatcher, type Stats } from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

import type {
  WorkspaceGitChangeKind,
  WorkspaceGitWatchCallbacks,
  WorkspaceGitWatchHandle,
} from './snapshot-manager.js';

const DEFAULT_QUIET_WINDOW_MS = 120;
const DEFAULT_MAX_WAIT_MS = 800;
const MAX_CLASSIFIED_PATHS = 1_000;
const REPOSITORY_ROOT_FILES = new Set([
  'HEAD',
  'ORIG_HEAD',
  'FETCH_HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'index',
  'packed-refs',
  'config',
  'config.worktree',
  'commondir',
  'gitdir',
  'info/exclude',
]);
const REPOSITORY_STATE_PREFIXES = ['refs/', 'rebase-apply/', 'rebase-merge/', 'sequencer/'];

export interface WorkspaceGitWatcherOptions {
  workspace: string;
  callbacks: WorkspaceGitWatchCallbacks;
  /** Returns true only when every path in this batch is ignored by Git. */
  classifyIgnored: (paths: string[]) => Promise<boolean>;
  quietWindowMs?: number;
  maxWaitMs?: number;
}

export interface WorkspaceGitWatcherDependencies {
  watchDirectory?: (
    directory: string,
    recursive: boolean,
    listener: (fileName: string | Buffer | null) => void,
  ) => FSWatcher;
}

interface GitDirectoryLayout {
  gitDir: string;
  commonDir: string;
}

interface RepositoryWatcherCandidate {
  active: boolean;
}

/**
 * Watches product files and the small subset of Git administrative paths that
 * can change status/branch metadata. Raw events are coalesced before the
 * manager is told to refresh; objects and logs are never watched.
 */
export async function createWorkspaceGitWatcher(
  options: WorkspaceGitWatcherOptions,
  dependencies: WorkspaceGitWatcherDependencies = {},
): Promise<WorkspaceGitWatchHandle> {
  const workspace = await realpath(options.workspace);
  const watchDirectory =
    dependencies.watchDirectory ??
    ((directory, recursive, listener) =>
      watch(directory, { recursive }, (_eventType, fileName) => listener(fileName)));
  const coordinator = new WorkspaceGitWatcherCoordinator(workspace, options, watchDirectory);
  await coordinator.start();
  return coordinator;
}

type WatchDirectory = NonNullable<WorkspaceGitWatcherDependencies['watchDirectory']>;

class WorkspaceGitWatcherCoordinator implements WorkspaceGitWatchHandle {
  private readonly workspaceWatchers: FSWatcher[] = [];
  private repositoryWatchers: FSWatcher[] = [];
  private repositoryPresent = false;
  private repositoryWatcherGeneration = 0;
  private repositoryRebindRequested = false;
  private repositoryRebindTask?: Promise<void>;
  private closed = false;
  private failure?: unknown;
  private potentialNotified = false;
  private quietTimer?: ReturnType<typeof setTimeout>;
  private maxTimer?: ReturnType<typeof setTimeout>;
  private flushing = false;
  private pendingKind?: WorkspaceGitChangeKind;
  private hasUnknownWorkspacePath = false;
  private readonly pendingPaths = new Set<string>();

  constructor(
    private readonly workspace: string,
    private readonly options: WorkspaceGitWatcherOptions,
    private readonly watchDirectory: WatchDirectory,
  ) {}

  async start(): Promise<void> {
    try {
      this.attachWatcher({
        target: this.workspaceWatchers,
        directory: this.workspace,
        recursive: true,
        listener: this.enqueueWorkspacePath,
        onError: this.failClosed,
      });
      this.assertActive();
      await this.replaceRepositoryWatchers();
      this.assertActive();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.pendingPaths.clear();
    closeWatchers(this.workspaceWatchers);
    closeWatchers(this.repositoryWatchers);
  }

  private readonly failClosed = (error: unknown): void => {
    if (this.closed) return;
    this.failure = error;
    this.close();
    this.potentialNotified = false;
    this.options.callbacks.onError(error);
  };

  private clearTimers(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.quietTimer = undefined;
    this.maxTimer = undefined;
  }

  private scheduleFlush(): void {
    if (this.closed) return;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(
      () => void this.flush(),
      this.options.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS,
    );
    this.maxTimer ??= setTimeout(
      () => void this.flush(),
      this.options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    );
  }

  private markPotential(): void {
    if (!this.potentialNotified) {
      this.potentialNotified = true;
      this.options.callbacks.onPotentialChange();
    }
    this.scheduleFlush();
  }

  private readonly enqueueWorkspacePath = (fileName: string | Buffer | null): void => {
    if (this.closed) return;
    const normalized = normalizeWatchFileName(fileName);
    if (normalized === '.git' || normalized.startsWith('.git/')) {
      this.handleWorkspaceGitPath(normalized);
      return;
    }
    // Before a repository exists, the workspace watcher is deliberately only
    // an observer for `.git` appearing. Ordinary files cannot affect Git state
    // yet and must not trigger classification or status work.
    if (!this.repositoryPresent) return;
    if (!normalized || this.pendingPaths.size >= MAX_CLASSIFIED_PATHS) {
      this.hasUnknownWorkspacePath = true;
    } else {
      this.pendingPaths.add(normalized);
    }
    this.markPotential();
  };

  private handleWorkspaceGitPath(normalized: string): void {
    if (normalized !== '.git' && this.repositoryWatchers.length > 0) return;
    this.pendingKind = 'repository';
    this.requestRepositoryRebind();
    this.markPotential();
  }

  private enqueueRepositoryPath(fileName: string | Buffer | null, refsOnly: boolean): void {
    if (this.closed) return;
    const normalized = normalizeWatchFileName(fileName);
    const layoutMayHaveChanged =
      normalized === 'commondir' ||
      normalized === 'gitdir' ||
      normalized === 'refs' ||
      normalized === 'info';
    if (!this.isRelevantRepositoryPath(normalized, refsOnly, layoutMayHaveChanged)) return;
    this.pendingKind = 'repository';
    if (layoutMayHaveChanged) this.requestRepositoryRebind();
    this.markPotential();
  }

  private isRelevantRepositoryPath(
    normalized: string,
    refsOnly: boolean,
    layoutMayHaveChanged: boolean,
  ): boolean {
    return (
      !normalized ||
      refsOnly ||
      layoutMayHaveChanged ||
      REPOSITORY_ROOT_FILES.has(normalized) ||
      REPOSITORY_STATE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    );
  }

  private attachWatcher(options: {
    target: FSWatcher[];
    directory: string;
    recursive: boolean;
    listener: (fileName: string | Buffer | null) => void;
    onError: (error: unknown) => void;
  }): void {
    this.assertActive();
    const watcher = this.watchDirectory(options.directory, options.recursive, options.listener);
    watcher.on('error', options.onError);
    if (this.closed) {
      watcher.close();
      this.assertActive();
    }
    options.target.push(watcher);
  }

  private async replaceRepositoryWatchers(): Promise<void> {
    const layout = await resolveGitDirectoryLayout(this.workspace);
    const nextGeneration = this.repositoryWatcherGeneration + 1;
    const candidate: RepositoryWatcherCandidate = { active: true };
    let nextWatchers: FSWatcher[] = [];
    try {
      nextWatchers = await this.createRepositoryWatchers(layout, nextGeneration, candidate);
      this.assertActive();
      const previousWatchers = this.repositoryWatchers;
      this.repositoryWatcherGeneration = nextGeneration;
      this.repositoryWatchers = nextWatchers;
      this.repositoryPresent = layout !== undefined;
      closeWatchers(previousWatchers);
    } catch (error) {
      closeWatchers(nextWatchers);
      throw error;
    } finally {
      candidate.active = false;
    }
  }

  private async createRepositoryWatchers(
    layout: GitDirectoryLayout | undefined,
    generation: number,
    candidate: RepositoryWatcherCandidate,
  ): Promise<FSWatcher[]> {
    const watchers: FSWatcher[] = [];
    if (!layout) return watchers;
    const onError = (error: unknown) => {
      if (!this.closed && (candidate.active || this.repositoryWatcherGeneration === generation)) {
        this.failClosed(error);
      }
    };
    try {
      this.attachRepositoryRootWatchers(watchers, layout, onError);
      await this.attachRepositoryRefWatchers(watchers, layout, onError);
      await this.attachRepositoryInfoWatchers(watchers, layout, onError);
      return watchers;
    } catch (error) {
      closeWatchers(watchers);
      throw error;
    }
  }

  private attachRepositoryRootWatchers(
    watchers: FSWatcher[],
    layout: GitDirectoryLayout,
    onError: (error: unknown) => void,
  ): void {
    this.attachWatcher({
      target: watchers,
      directory: layout.gitDir,
      recursive: false,
      listener: (fileName) => this.enqueueRepositoryPath(fileName, false),
      onError,
    });
    if (layout.commonDir === layout.gitDir) return;
    this.attachWatcher({
      target: watchers,
      directory: layout.commonDir,
      recursive: false,
      listener: (fileName) => this.enqueueRepositoryPath(fileName, false),
      onError,
    });
  }

  private async attachRepositoryRefWatchers(
    watchers: FSWatcher[],
    layout: GitDirectoryLayout,
    onError: (error: unknown) => void,
  ): Promise<void> {
    const refsDirectories = new Set([join(layout.gitDir, 'refs'), join(layout.commonDir, 'refs')]);
    for (const directory of refsDirectories) {
      if (!(await isDirectory(directory))) continue;
      this.attachWatcher({
        target: watchers,
        directory,
        recursive: true,
        listener: (fileName) => this.enqueueRepositoryPath(fileName, true),
        onError,
      });
    }
  }

  private async attachRepositoryInfoWatchers(
    watchers: FSWatcher[],
    layout: GitDirectoryLayout,
    onError: (error: unknown) => void,
  ): Promise<void> {
    const infoDirectories = new Set([join(layout.gitDir, 'info'), join(layout.commonDir, 'info')]);
    for (const directory of infoDirectories) {
      if (!(await isDirectory(directory))) continue;
      this.attachWatcher({
        target: watchers,
        directory,
        recursive: false,
        listener: (fileName) => {
          const normalized = normalizeWatchFileName(fileName);
          if (!normalized || normalized === 'exclude') {
            this.enqueueRepositoryPath(normalized ? `info/${normalized}` : normalized, false);
          }
        },
        onError,
      });
    }
  }

  private requestRepositoryRebind(): void {
    if (this.closed) return;
    this.repositoryRebindRequested = true;
    if (this.repositoryRebindTask) return;
    this.repositoryRebindTask = this.runRepositoryRebind();
  }

  private assertActive(): void {
    if (!this.closed) return;
    if (this.failure instanceof Error) throw this.failure;
    throw new Error('Workspace Git watcher closed during setup', { cause: this.failure });
  }

  private async runRepositoryRebind(): Promise<void> {
    try {
      while (!this.closed && this.repositoryRebindRequested) {
        this.repositoryRebindRequested = false;
        await this.replaceRepositoryWatchers();
      }
    } catch (error) {
      this.failClosed(error);
    } finally {
      this.repositoryRebindTask = undefined;
      if (!this.closed && this.repositoryRebindRequested) this.requestRepositoryRebind();
    }
  }

  private async waitForRepositoryRebind(): Promise<void> {
    while (this.repositoryRebindTask) await this.repositoryRebindTask;
  }

  private async flush(): Promise<void> {
    if (this.closed || this.flushing || !this.potentialNotified) return;
    this.flushing = true;
    this.clearTimers();
    try {
      await this.waitForRepositoryRebind();
      if (this.closed) return;
      const changeKind = await this.drainPendingChanges();
      if (this.closed) return;
      this.potentialNotified = false;
      if (changeKind) this.options.callbacks.onChange(changeKind);
      else this.options.callbacks.onIgnoredOnly();
    } catch (error) {
      this.potentialNotified = false;
      this.failClosed(error);
    } finally {
      this.flushing = false;
      if (!this.closed && this.potentialNotified) this.scheduleFlush();
    }
  }

  private async drainPendingChanges(): Promise<WorkspaceGitChangeKind | undefined> {
    let changeKind: WorkspaceGitChangeKind | undefined;
    do {
      changeKind = await this.classifyBatch(changeKind, this.takePendingBatch());
    } while (!this.closed && this.hasPendingBatch());
    return changeKind;
  }

  private takePendingBatch(): {
    kind?: WorkspaceGitChangeKind;
    unknown: boolean;
    paths: string[];
  } {
    const batch = {
      ...(this.pendingKind ? { kind: this.pendingKind } : {}),
      unknown: this.hasUnknownWorkspacePath,
      paths: Array.from(this.pendingPaths),
    };
    this.pendingKind = undefined;
    this.hasUnknownWorkspacePath = false;
    this.pendingPaths.clear();
    return batch;
  }

  private async classifyBatch(
    current: WorkspaceGitChangeKind | undefined,
    batch: { kind?: WorkspaceGitChangeKind; unknown: boolean; paths: string[] },
  ): Promise<WorkspaceGitChangeKind | undefined> {
    if (batch.kind === 'repository') return 'repository';
    if (current) return current;
    if (batch.unknown || batch.paths.length === 0) return 'workspace';
    return (await this.options.classifyIgnored(batch.paths)) ? undefined : 'workspace';
  }

  private hasPendingBatch(): boolean {
    return (
      this.pendingKind !== undefined || this.hasUnknownWorkspacePath || this.pendingPaths.size > 0
    );
  }
}

function closeWatchers(watchers: FSWatcher[]): void {
  for (const watcher of watchers) watcher.close();
  watchers.length = 0;
}

async function resolveGitDirectoryLayout(
  workspace: string,
): Promise<GitDirectoryLayout | undefined> {
  const dotGit = join(workspace, '.git');
  const dotGitStat = await readGitDirectoryEntry(dotGit);
  if (!dotGitStat) return undefined;
  const gitDir = await resolveGitDirectory(workspace, dotGit, dotGitStat);
  const commonDir = await resolveGitCommonDirectory(gitDir);
  return { gitDir, commonDir };
}

async function readGitDirectoryEntry(dotGit: string): Promise<Stats | undefined> {
  try {
    return await lstat(dotGit);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

async function resolveGitDirectory(
  workspace: string,
  dotGit: string,
  dotGitStat: Stats,
): Promise<string> {
  if (dotGitStat.isDirectory()) {
    return realpath(dotGit);
  }
  if (dotGitStat.isFile()) {
    const match = /^gitdir:\s*(.+)$/mu.exec(await readFile(dotGit, 'utf8'));
    const linkedPath = match?.[1]?.trim();
    if (!linkedPath) throw new Error(`Invalid Git directory pointer: ${dotGit}`);
    return realpath(isAbsolute(linkedPath) ? linkedPath : resolve(workspace, linkedPath));
  }
  throw new Error(`Unsupported Git directory entry: ${dotGit}`);
}

async function resolveGitCommonDirectory(gitDir: string): Promise<string> {
  let commonPath: string;
  try {
    commonPath = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim();
  } catch (error) {
    // Main worktrees have no commondir file; their gitDir is also commonDir.
    if (isMissingPathError(error)) return gitDir;
    throw error;
  }
  if (!commonPath) throw new Error(`Invalid Git common directory pointer: ${gitDir}`);
  return realpath(isAbsolute(commonPath) ? commonPath : resolve(gitDir, commonPath));
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function normalizeWatchFileName(fileName: string | Buffer | null): string {
  if (fileName === null) return '';
  const value = Buffer.isBuffer(fileName) ? fileName.toString('utf8') : fileName;
  return value.split(sep).filter(Boolean).join('/');
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
