import { lstat, readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Dirent } from 'node:fs';

const DAY_MS = 24 * 60 * 60 * 1_000;
const LOG_RETENTION_MS = 7 * DAY_MS;
const DEFAULT_ENTRY_BUDGET = 2_000;

export interface TransientStorageRetentionResult {
  readonly logFilesDeleted: number;
  readonly retiredContextDebugDeleted: boolean;
}

/**
 * Post-ready retention for fixed diagnostic log roots and retired context debug.
 * Business temporary directories and workspaces are never discovered or traversed.
 */
export async function pruneTransientStorage(options: {
  readonly dataDir: string;
  readonly nowMs?: () => number;
  readonly maxEntries?: number;
}): Promise<TransientStorageRetentionResult> {
  if (!(await isPlainDirectory(options.dataDir))) {
    return { logFilesDeleted: 0, retiredContextDebugDeleted: false };
  }
  const nowMs = (options.nowMs ?? Date.now)();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    return { logFilesDeleted: 0, retiredContextDebugDeleted: false };
  }
  const budget = createEntryBudget(options.maxEntries);
  if (!budget) {
    return { logFilesDeleted: 0, retiredContextDebugDeleted: false };
  }
  const retiredContextDebugDeleted = await removeRetiredContextDebug(options.dataDir);
  const logRoots = await resolveManagedLogRoots(options.dataDir);
  let logFilesDeleted = 0;
  for (const root of logRoots) {
    logFilesDeleted += await pruneLogDirectory(root, nowMs - LOG_RETENTION_MS, budget);
  }
  return { logFilesDeleted, retiredContextDebugDeleted };
}

async function removeRetiredContextDebug(dataDir: string): Promise<boolean> {
  const target = join(dataDir, 'debug');
  if (!(await isPlainDirectory(target))) return false;
  try {
    await rm(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function resolveManagedLogRoots(dataDir: string): Promise<string[]> {
  const chains = [
    [dataDir, join(dataDir, 'logs')],
    [
      dataDir,
      join(dataDir, 'v2'),
      join(dataDir, 'v2', 'observability'),
      join(dataDir, 'v2', 'observability', 'logs'),
    ],
  ];
  const valid = await Promise.all(
    chains.map(async (chain) => (await Promise.all(chain.map(isPlainDirectory))).every(Boolean)),
  );
  return chains.flatMap((chain, index) => {
    const root = chain.at(-1);
    return valid[index] && root ? [root] : [];
  });
}

async function pruneLogDirectory(
  root: string,
  cutoffMs: number,
  budget: EntryBudget,
): Promise<number> {
  if (!(await isPlainDirectory(root))) return 0;
  return pruneLogChildren(root, cutoffMs, budget);
}

async function pruneLogChildren(
  directory: string,
  cutoffMs: number,
  budget: EntryBudget,
): Promise<number> {
  if (!(await isPlainDirectory(directory))) return 0;
  const entries = await safeDirectoryEntries(directory);
  if (entries === undefined) return 0;
  let deleted = 0;
  for (const entry of entries) {
    if (!consumeEntry(budget)) break;
    deleted += await pruneLogEntry(directory, entry, cutoffMs, budget);
  }
  return deleted;
}

async function pruneLogEntry(
  directory: string,
  entry: Dirent,
  cutoffMs: number,
  budget: EntryBudget,
): Promise<number> {
  if (entry.isSymbolicLink()) return 0;
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return pruneLogSubdirectory(path, cutoffMs, budget);
  if (!entry.isFile()) return 0;
  return pruneLogFile(path, cutoffMs);
}

async function pruneLogSubdirectory(
  path: string,
  cutoffMs: number,
  budget: EntryBudget,
): Promise<number> {
  const deleted = await pruneLogChildren(path, cutoffMs, budget);
  try {
    await rmdir(path);
  } catch {
    // Non-empty/current directories stay in place.
  }
  return deleted;
}

async function pruneLogFile(path: string, cutoffMs: number): Promise<number> {
  try {
    const info = await lstat(path);
    if (info.mtimeMs >= cutoffMs) return 0;
    await rm(path, { force: true });
    return 1;
  } catch {
    return 0;
  }
}

async function isPlainDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function safeDirectoryEntries(path: string): Promise<Dirent[] | undefined> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

interface EntryBudget {
  remaining: number;
}

function createEntryBudget(value: number | undefined): EntryBudget | undefined {
  const limit = value ?? DEFAULT_ENTRY_BUDGET;
  return Number.isSafeInteger(limit) && limit > 0 ? { remaining: limit } : undefined;
}

function consumeEntry(budget: EntryBudget): boolean {
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}
