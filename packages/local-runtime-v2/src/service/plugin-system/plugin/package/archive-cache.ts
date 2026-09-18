import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parsePluginArchive, PluginArchiveError } from './archive-format.js';
import {
  computePluginDirectoryDigest,
  PLUGIN_PACKAGE_V1_LIMITS,
  pluginDigestCacheKey,
} from './package-contract.js';

export interface MaterializeOfficialPluginArchiveInput {
  readonly archivePath: string;
  readonly cacheRoot: string;
  readonly expectedArchiveSha256: string;
  readonly expectedContentDigest: string;
  readonly signal?: AbortSignal;
}

export interface MaterializedOfficialPluginArchive {
  readonly cacheKey: string;
  readonly packageRoot: string;
  readonly reused: boolean;
}

export async function materializeOfficialPluginArchive(
  input: MaterializeOfficialPluginArchiveInput,
): Promise<MaterializedOfficialPluginArchive> {
  assertSha256(input.expectedArchiveSha256);
  const cacheKey = pluginDigestCacheKey(input.expectedContentDigest);
  await mkdir(input.cacheRoot, { recursive: true });
  assertNotAborted(input.signal);
  const archive = await readRegularArchive(input.archivePath, input.signal);
  assertNotAborted(input.signal);
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  if (archiveSha256 !== input.expectedArchiveSha256) {
    throw new PluginArchiveError(
      'ARCHIVE_DIGEST_MISMATCH',
      'archive SHA-256 does not match the package reference',
    );
  }
  const parsed = parsePluginArchive(archive);
  if (parsed.digest.contentDigest !== input.expectedContentDigest) {
    throw new PluginArchiveError(
      'CONTENT_DIGEST_MISMATCH',
      'archive content tree does not match the package reference',
    );
  }

  const packageRoot = join(input.cacheRoot, cacheKey);
  if (await isExistingValidCache(packageRoot, input.expectedContentDigest)) {
    return { cacheKey, packageRoot, reused: true };
  }

  const stagingRoot = await mkdtemp(join(input.cacheRoot, `.${cacheKey}.tmp-`));
  let published = false;
  try {
    for (const entry of parsed.entries) {
      assertNotAborted(input.signal);
      const target = join(stagingRoot, ...entry.path.split('/'));
      if (entry.kind === 'directory') {
        await mkdir(target, { recursive: true });
      } else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, entry.content, { flag: 'wx', mode: 0o600 });
      }
    }
    const stagedDigest = await computePluginDirectoryDigest(stagingRoot);
    if (stagedDigest.contentDigest !== input.expectedContentDigest) {
      throw new PluginArchiveError(
        'CONTENT_DIGEST_MISMATCH',
        'staged package content changed during extraction',
      );
    }
    assertNotAborted(input.signal);
    try {
      await rename(stagingRoot, packageRoot);
      published = true;
      return { cacheKey, packageRoot, reused: false };
    } catch (error) {
      if (!(await isExistingValidCache(packageRoot, input.expectedContentDigest))) throw error;
      return { cacheKey, packageRoot, reused: true };
    }
  } finally {
    if (!published) await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function readRegularArchive(
  archivePath: string,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const initial = await inspectArchivePath(archivePath);
  const handle = await openArchive(archivePath);
  try {
    const before = await handle.stat();
    assertArchiveSnapshot(initial, before);
    const archive = await readArchiveBytes(handle, before.size, signal);
    assertArchiveUnchanged(before, await handle.stat());
    return archive;
  } finally {
    await handle.close();
  }
}

async function inspectArchivePath(archivePath: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    const initial = await lstat(archivePath);
    if (initial.isSymbolicLink() || !initial.isFile()) throw new Error('not a regular file');
    return initial;
  } catch {
    throw new PluginArchiveError('ARCHIVE_NOT_REGULAR_FILE', 'archive must be a regular file');
  }
}

async function openArchive(archivePath: string): Promise<Awaited<ReturnType<typeof open>>> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  try {
    return await open(archivePath, flags);
  } catch {
    throw new PluginArchiveError('ARCHIVE_NOT_REGULAR_FILE', 'archive must be a regular file');
  }
}

function assertArchiveSnapshot(
  initial: Awaited<ReturnType<typeof lstat>>,
  before: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
): void {
  if (
    !before.isFile() ||
    before.dev !== initial.dev ||
    before.ino !== initial.ino ||
    !Number.isSafeInteger(before.size) ||
    before.size < 0
  ) {
    throw new PluginArchiveError('ARCHIVE_CHANGED_DURING_READ', 'archive changed before read');
  }
  if (before.size > PLUGIN_PACKAGE_V1_LIMITS.maxArchiveBytes) {
    throw new PluginArchiveError('ARCHIVE_TOO_LARGE', 'archive exceeds the V1 byte limit');
  }
}

async function readArchiveBytes(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const archive = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < archive.length) {
    assertNotAborted(signal);
    const { bytesRead } = await handle.read(
      archive,
      offset,
      Math.min(64 * 1024, archive.length - offset),
      offset,
    );
    if (bytesRead === 0) {
      throw new PluginArchiveError('ARCHIVE_CHANGED_DURING_READ', 'archive was truncated');
    }
    offset += bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0) {
    throw new PluginArchiveError('ARCHIVE_CHANGED_DURING_READ', 'archive grew during read');
  }
  return archive;
}

function assertArchiveUnchanged(
  before: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
  after: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new PluginArchiveError('ARCHIVE_CHANGED_DURING_READ', 'archive changed during read');
  }
}

async function isExistingValidCache(
  packageRoot: string,
  expectedContentDigest: string,
): Promise<boolean> {
  try {
    const stat = await lstat(packageRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new PluginArchiveError('CACHE_CORRUPT', 'digest cache path is not a directory');
    }
    const digest = await computePluginDirectoryDigest(packageRoot);
    if (digest.contentDigest !== expectedContentDigest) {
      throw new PluginArchiveError('CACHE_CORRUPT', 'existing digest cache content is invalid');
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    if (error instanceof PluginArchiveError) throw error;
    throw new PluginArchiveError('CACHE_CORRUPT', 'existing digest cache cannot be validated');
  }
}

function assertSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new PluginArchiveError('INVALID_ARCHIVE_DIGEST', 'archive SHA-256 format is invalid');
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new PluginArchiveError('ARCHIVE_ABORTED', 'archive materialization was aborted');
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
