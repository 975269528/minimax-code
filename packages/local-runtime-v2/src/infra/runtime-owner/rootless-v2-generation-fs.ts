import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import {
  chmod,
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  statfs,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SOURCE_RELEASE = 'previewtrain-root-v1';
export const TARGET_RELEASE = 'desktop-rootless-v2';

export type SwapDirection = 'rollback' | 'reupgrade';

export interface GenerationManifest {
  readonly schemaVersion: 1;
  readonly sourceRelease: string;
  readonly targetRelease: string;
  readonly activeFingerprint: string;
  readonly sourceAbsent: boolean;
  readonly completed: true;
  readonly upgradedFingerprint?: string;
  readonly previousFingerprint?: string;
  readonly previousPresent?: boolean;
}

export interface SwapJournal {
  readonly schemaVersion: 1;
  readonly operation: SwapDirection;
  readonly stage: 'prepared' | 'active-saved' | 'target-activated';
  readonly completed: false;
}

export interface GenerationPaths {
  readonly dataDir: string;
  readonly root: string;
  readonly stagingRoot: string;
  readonly previous: string;
  readonly upgraded: string;
  readonly manifest: string;
  readonly journal: string;
  readonly lockTarget: string;
}

export function generationPaths(input: string): GenerationPaths {
  const dataDir = resolve(input);
  if (dataDir === resolve(dirname(dataDir))) throw new Error('Filesystem root cannot be a dataDir');
  const root = `${dataDir}.rootless-v2-rollback`;
  if (dirname(root) !== dirname(dataDir)) throw new Error('Rollback slot must be a sibling');
  return {
    dataDir,
    root,
    stagingRoot: `${root}.tmp`,
    previous: join(root, 'previous-data-dir'),
    upgraded: join(root, 'upgraded-data-dir'),
    manifest: join(root, 'manifest.json'),
    journal: join(root, 'swap-journal.json'),
    lockTarget: `${root}.operation-lock`,
  };
}

export async function readAndValidateManifest(
  paths: GenerationPaths,
  releases: { readonly sourceRelease?: string; readonly targetRelease?: string },
): Promise<GenerationManifest> {
  const raw = JSON.parse(await readFile(paths.manifest, 'utf8')) as unknown;
  const manifest = decodeManifest(raw, releases);
  await assertOwnerOnlyDirectory(paths.root);
  return manifest;
}

function decodeManifest(
  raw: unknown,
  releases: { readonly sourceRelease?: string; readonly targetRelease?: string },
): GenerationManifest {
  const manifest = requiredManifestRecord(raw);
  validateManifestHeader(manifest, releases);
  return {
    schemaVersion: 1,
    sourceRelease: releases.sourceRelease ?? SOURCE_RELEASE,
    targetRelease: releases.targetRelease ?? TARGET_RELEASE,
    completed: true,
    ...decodeManifestState(manifest),
  };
}

function requiredManifestRecord(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new Error('Checkpoint manifest is invalid');
  return raw;
}

function validateManifestHeader(
  manifest: Record<string, unknown>,
  releases: { readonly sourceRelease?: string; readonly targetRelease?: string },
): void {
  if (manifest.schemaVersion !== 1) throw new Error('Checkpoint manifest version is invalid');
  if (manifest.completed !== true) throw new Error('Checkpoint manifest is incomplete');
  if (manifest.sourceRelease !== (releases.sourceRelease ?? SOURCE_RELEASE)) {
    throw new Error('Checkpoint source release does not match');
  }
  if (manifest.targetRelease !== (releases.targetRelease ?? TARGET_RELEASE)) {
    throw new Error('Checkpoint target release does not match');
  }
}

function decodeManifestState(
  manifest: Record<string, unknown>,
): Pick<
  GenerationManifest,
  | 'activeFingerprint'
  | 'sourceAbsent'
  | 'upgradedFingerprint'
  | 'previousFingerprint'
  | 'previousPresent'
> {
  const activeFingerprint = requiredNonEmptyString(
    manifest.activeFingerprint,
    'Checkpoint active fingerprint is invalid',
  );
  const sourceAbsent = requiredBoolean(
    manifest.sourceAbsent,
    'Checkpoint source-absent marker is invalid',
  );
  const upgradedFingerprint = optionalNonEmptyString(
    manifest.upgradedFingerprint,
    'Checkpoint upgraded fingerprint is invalid',
  );
  const previousFingerprint = optionalNonEmptyString(
    manifest.previousFingerprint,
    'Checkpoint previous fingerprint is invalid',
  );
  const previousPresent = optionalBoolean(
    manifest.previousPresent,
    'Checkpoint previous-present marker is invalid',
  );
  if ((previousFingerprint === undefined) !== (previousPresent === undefined)) {
    throw new Error('Checkpoint current previous-generation state is incomplete');
  }
  return {
    activeFingerprint,
    sourceAbsent,
    ...(upgradedFingerprint ? { upgradedFingerprint } : {}),
    ...(previousFingerprint ? { previousFingerprint } : {}),
    ...(previousPresent !== undefined ? { previousPresent } : {}),
  };
}

export async function readJournal(path: string): Promise<SwapJournal | undefined> {
  const raw = await readOptionalText(path);
  if (raw === undefined) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error('Generation journal is invalid');
  if (
    parsed.schemaVersion !== 1 ||
    parsed.completed !== false ||
    (parsed.operation !== 'rollback' && parsed.operation !== 'reupgrade') ||
    !isJournalStage(parsed.stage)
  ) {
    throw new Error('Generation journal is invalid');
  }
  return {
    schemaVersion: 1,
    operation: parsed.operation,
    stage: parsed.stage,
    completed: false,
  };
}

export async function writeJournal(
  paths: GenerationPaths,
  input: Pick<SwapJournal, 'operation' | 'stage'>,
): Promise<void> {
  await writeJsonAtomically(paths.journal, {
    schemaVersion: 1,
    operation: input.operation,
    stage: input.stage,
    completed: false,
  } satisfies SwapJournal);
}

function isJournalStage(value: unknown): value is SwapJournal['stage'] {
  return value === 'prepared' || value === 'active-saved' || value === 'target-activated';
}

function requiredNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(message);
  return value;
}

function optionalNonEmptyString(value: unknown, message: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredNonEmptyString(value, message);
}

function requiredBoolean(value: unknown, message: string): boolean {
  if (typeof value !== 'boolean') throw new Error(message);
  return value;
}

function optionalBoolean(value: unknown, message: string): boolean | undefined {
  if (value === undefined) return undefined;
  return requiredBoolean(value, message);
}

export async function fingerprintGeneration(path: string, absent: boolean): Promise<string> {
  if (absent) {
    if (await pathExists(path)) throw new Error('Expected generation to be absent');
    return createHash('sha256').update('rootless-v2:source-absent\0').digest('hex');
  }
  const source = await lstat(path);
  if (!source.isDirectory() || source.isSymbolicLink()) {
    throw new Error('Generation root must be a physical directory');
  }
  const hash = createHash('sha256');
  await hashTree(path, '', hash);
  return hash.digest('hex');
}

async function hashTree(
  root: string,
  relativePath: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const path = relativePath ? join(root, relativePath) : root;
  const info = await lstat(path);
  const normalized = relativePath.split('\\').join('/');
  const kind = checkpointEntryKind(info);
  if (kind === 'directory') {
    hash.update(`d\0${normalized}\0${String(info.mode & 0o777)}\0`);
    const names = (await readdir(path)).sort((left, right) => left.localeCompare(right));
    for (const name of names) await hashTree(root, join(relativePath, name), hash);
    return;
  }
  if (kind === 'symlink') {
    hash.update(`l\0${normalized}\0${await readlink(path)}\0`);
    return;
  }
  if (kind === 'transient') return;
  hash.update(`f\0${normalized}\0${String(info.mode & 0o777)}\0${String(info.size)}\0`);
  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectStream);
    stream.on('end', resolveStream);
  });
}

export async function treeByteSize(root: string): Promise<number> {
  return entryByteSize(root, true);

  async function entryByteSize(path: string, isRoot = false): Promise<number> {
    const info = await lstat(path);
    const kind = checkpointEntryKind(info);
    if (kind === 'symlink') {
      if (isRoot) throw new Error('Checkpoint source cannot be a symlink');
      return Buffer.byteLength(await readlink(path));
    }
    if (kind === 'file') return info.size;
    if (kind === 'transient') return 0;
    let total = 0;
    for (const name of await readdir(path)) total += await entryByteSize(join(path, name));
    return total;
  }
}

export async function shouldCopyCheckpointEntry(path: string): Promise<boolean> {
  return checkpointEntryKind(await lstat(path)) !== 'transient';
}

/**
 * Copy-on-write clone of a whole tree via the platform `cp` binary:
 * `clonefile(2)` on APFS (macOS) and `FICLONE` reflink on btrfs/XFS (Linux).
 * Cloning 17G costs milliseconds and zero extra disk, versus minutes of
 * physical IO through the JS-level `fs.cp` walk.
 *
 * Returns true only when the clone subprocess fully succeeded. On any failure
 * (unsupported platform, sockets/FIFOs aborting `cp`, non-reflink filesystem
 * errors) the half-written destination is removed and false is returned so the
 * caller can fall back to the legacy `fs.cp` walk — fingerprint verification
 * downstream guards both paths equally.
 */
export async function tryCloneTree(
  source: string,
  destination: string,
): Promise<{ readonly cloned: boolean; readonly reason?: string }> {
  const argv = cloneArgsForPlatform(source, destination);
  if (!argv) return { cloned: false, reason: `unsupported platform ${process.platform}` };
  const [command, ...args] = argv;
  try {
    await execFileAsync(command, args);
    return { cloned: true };
  } catch (error) {
    await removeFailedCloneDestination(destination);
    return { cloned: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function cloneArgsForPlatform(
  source: string,
  destination: string,
): readonly [string, ...string[]] | undefined {
  if (process.platform === 'darwin') return ['/bin/cp', '-Rc', source, destination];
  if (process.platform === 'linux') return ['/bin/cp', '-a', '--reflink=auto', source, destination];
  return undefined;
}

async function removeFailedCloneDestination(destination: string): Promise<void> {
  try {
    await rm(destination, { recursive: true, force: true });
  } catch {
    // The fallback fs.cp path uses errorOnExist and will surface leftovers.
  }
}

/**
 * Removes FIFO/socket entries a platform `cp` clone may have materialized,
 * restoring the checkpoint contract that transient entries never enter the
 * copy (a rolled-back generation must not resurrect stale runtime sockets).
 * Metadata-only walk — cheap next to the content hashing that follows.
 */
export async function removeTransientEntries(root: string): Promise<void> {
  const info = await lstat(root);
  const kind = checkpointEntryKind(info);
  if (kind === 'transient') {
    await rm(root, { force: true });
    return;
  }
  if (kind !== 'directory') return;
  for (const name of await readdir(root)) {
    await removeTransientEntries(join(root, name));
  }
}

function checkpointEntryKind(info: Stats): 'directory' | 'file' | 'symlink' | 'transient' {
  if (info.isSymbolicLink()) return 'symlink';
  if (info.isDirectory()) return 'directory';
  if (info.isFile()) return 'file';
  if (info.isFIFO() || info.isSocket()) return 'transient';
  throw new Error('Checkpoint source contains an unsupported file type');
}

export async function assertFreeSpace(parent: string, requiredBytes: number): Promise<void> {
  const stats = await statfs(parent);
  const available = stats.bavail * stats.bsize;
  if (!Number.isSafeInteger(available) || available < requiredBytes + 4096) {
    throw new Error('Insufficient space for Rootless V2 checkpoint');
  }
}

export async function assertCheckpointSourceBoundary(dataDir: string): Promise<void> {
  const info = await lstat(dataDir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Checkpoint source must be a physical directory');
  }
}

export async function syncTree(root: string, absent: boolean): Promise<void> {
  if (absent) return;
  const info = await lstat(root);
  if (info.isDirectory()) {
    for (const name of await readdir(root)) await syncTree(join(root, name), false);
    await syncDirectoryBestEffort(root);
    return;
  }
  if (!info.isFile()) return;
  const handle = await open(root, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeNewJson(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let published = false;
  try {
    await writeNewJson(temporary, value);
    await rename(temporary, path);
    published = true;
    await syncDirectoryBestEffort(dirname(path));
  } finally {
    if (!published) await rm(temporary, { force: true });
  }
}

export async function syncSwapParents(paths: GenerationPaths): Promise<void> {
  await syncDirectoryBestEffort(dirname(paths.dataDir));
  await syncDirectoryBestEffort(paths.root);
}

export async function syncDirectoryBestEffort(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  }
  if (!handle) return;
  try {
    try {
      await handle.sync();
    } catch (error) {
      if (!isUnsupportedDirectorySync(error)) throw error;
    }
  } finally {
    await handle.close();
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EINVAL' || code === 'ENOTSUP' || code === 'EPERM' || code === 'EISDIR';
}

async function assertOwnerOnlyDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Rollback slot must be a physical directory');
  }
  if (process.platform === 'win32') return;
  if ((info.mode & 0o077) !== 0) throw new Error('Rollback slot permissions are not owner-only');
}

export async function chmodOwnerOnly(path: string): Promise<void> {
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

export async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

export function codedError(
  code: string,
  message: string,
  cause?: unknown,
): Error & { code: string } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
