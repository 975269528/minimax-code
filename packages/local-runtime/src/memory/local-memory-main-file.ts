import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { firstLine, formatTs } from './local-memory-store-utils.js';
import { LocalMemoryError, type LocalMemoryLocation, type LocalMemoryReadResult } from './types.js';

interface MainFileState {
  readonly exists: boolean;
  readonly value: LocalMemoryReadResult;
  readonly location: LocalMemoryLocation;
}

export async function readMainFile(
  dataDir: string,
  location: LocalMemoryLocation,
): Promise<LocalMemoryReadResult> {
  return (await readMainFileState(dataDir, location, 1, false)).value;
}

export async function ensureEmptyMainFile(
  dataDir: string,
  location: LocalMemoryLocation,
): Promise<LocalMemoryReadResult> {
  const current = await readMainFileState(dataDir, location, 1, false);
  if (current.exists) return current.value;

  try {
    await mkdir(dirname(location.mainPath), { recursive: true });
    await validateMainParentPath(dataDir, location);
    const handle = await open(location.mainPath, 'wx');
    await handle.close();
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      const raced = await readMainFileState(dataDir, location, 1, false);
      if (!raced.exists) throw memoryFileUnavailable();
      return raced.value;
    }
    throw mapMemoryFileError(error);
  }

  const created = await readMainFileState(dataDir, location, 1, true);
  if (!created.exists) throw memoryFileUnavailable();
  return created.value;
}

async function readMainFileState(
  dataDir: string,
  location: LocalMemoryLocation,
  retriesRemaining: number,
  observedExisting: boolean,
): Promise<MainFileState> {
  const canonicalDataDir = await validateMainParentPath(dataDir, location);
  let entryStat: Stats;
  try {
    entryStat = await lstat(location.mainPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT' && !observedExisting) {
      return {
        location,
        exists: false,
        value: { content: '', sizeBytes: 0 },
      };
    }
    throw mapMemoryFileError(error);
  }
  assertRegularMemoryFile(entryStat);

  let retry = false;
  let handle: FileHandle | undefined;
  try {
    const flags =
      process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    handle = await open(location.mainPath, flags);
    const openedStat = await handle.stat();
    assertRegularMemoryFile(openedStat);
    const openedRealPath = await realpath(location.mainPath);
    assertPathContained(canonicalDataDir, openedRealPath);
    const content = await handle.readFile({ encoding: 'utf8' });
    const finalOpenedStat = await handle.stat();
    const finalEntryStat = await lstat(location.mainPath);
    assertRegularMemoryFile(finalEntryStat);
    const finalRealPath = await realpath(location.mainPath);
    assertPathContained(canonicalDataDir, finalRealPath);
    if (
      !sameFileIdentity(entryStat, openedStat) ||
      !sameFileIdentity(openedStat, finalOpenedStat) ||
      !sameFileIdentity(finalOpenedStat, finalEntryStat) ||
      openedRealPath !== finalRealPath
    ) {
      retry = true;
    } else {
      return {
        location: {
          ...location,
          memoryDir: dirname(finalRealPath),
          mainPath: finalRealPath,
        },
        exists: true,
        value: {
          content,
          sizeBytes: finalOpenedStat.size,
          brief: firstLine(content),
          updatedAt: formatTs(finalOpenedStat.mtimeMs),
        },
      };
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      retry = true;
    } else {
      throw mapMemoryFileError(error);
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }

  if (retry && retriesRemaining > 0) {
    return readMainFileState(dataDir, location, retriesRemaining - 1, true);
  }
  throw memoryFileUnavailable();
}

async function validateMainParentPath(
  dataDir: string,
  location: LocalMemoryLocation,
): Promise<string> {
  const configuredDataDir = resolve(dataDir);
  const requestedMainPath = resolve(location.mainPath);
  assertPathContained(configuredDataDir, requestedMainPath);

  let canonicalDataDir: string;
  try {
    canonicalDataDir = await realpath(configuredDataDir);
    if (!(await stat(canonicalDataDir)).isDirectory()) throw memoryFileUnavailable();
  } catch (error) {
    throw mapMemoryFileError(error);
  }

  const parentPath = dirname(requestedMainPath);
  const parentRelative = relative(configuredDataDir, parentPath);
  let currentPath = configuredDataDir;
  for (const segment of parentRelative.split(sep).filter(Boolean)) {
    currentPath = join(currentPath, segment);
    let currentStat: Stats;
    try {
      currentStat = await lstat(currentPath);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return canonicalDataDir;
      throw mapMemoryFileError(error);
    }
    if (currentStat.isSymbolicLink()) throw memoryFileInvalid();
    if (!currentStat.isDirectory()) throw memoryFileUnavailable();
    try {
      assertPathContained(canonicalDataDir, await realpath(currentPath));
    } catch (error) {
      throw mapMemoryFileError(error);
    }
  }
  return canonicalDataDir;
}

function assertRegularMemoryFile(stats: Stats): void {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw memoryFileInvalid();
  }
}

function assertPathContained(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === '') return;
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw memoryFileInvalid();
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  const hasStableIdentity = left.ino > 0 && right.ino > 0;
  if (!hasStableIdentity) return true;
  return left.dev === right.dev && left.ino === right.ino;
}

function mapMemoryFileError(error: unknown): LocalMemoryError {
  if (error instanceof LocalMemoryError) return error;
  if (isNodeError(error) && error.code === 'ELOOP') {
    return memoryFileInvalid();
  }
  return memoryFileUnavailable();
}

function memoryFileInvalid(): LocalMemoryError {
  return new LocalMemoryError('MEMORY_FILE_INVALID', 'Memory file is invalid');
}

function memoryFileUnavailable(): LocalMemoryError {
  return new LocalMemoryError('MEMORY_FILE_UNREADABLE', 'Memory file is unavailable');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
