import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { Dirent } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import path from 'node:path';

import { isMiniAppRuntimePayloadExcludedPath, isPathCoveredByRoots } from './miniapp/path.js';

export const PLUGIN_PACKAGE_V1_LIMITS = {
  maxArchiveBytes: 64 * 1024 * 1024,
  maxArchiveEntries: 2_048,
  maxFiles: 1_024,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxPathBytes: 512,
  maxSegmentBytes: 128,
  maxPathSegments: 16,
} as const;

const CONTENT_MAGIC = Buffer.from('MINIMAX-PLUGIN-CONTENT-DIGEST\0', 'ascii');
const CONTENT_DIGEST_PATTERN = /^sha256-tree-v1:([0-9a-f]{64})$/u;
const PORTABLE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_value, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_value, index) => `lpt${index + 1}`),
]);

type PluginContractEntryKind =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'hardlink'
  | 'socket'
  | 'fifo'
  | 'device'
  | 'special';

type PluginPackagePathPolicy = 'minimax-portable' | 'agent-plugin' | 'unrestricted';

export interface PluginPackageDigestOptions {
  readonly pathPolicy?: PluginPackagePathPolicy;
  readonly rejectHardlinks?: boolean;
}

export interface MiniAppArtifactRoots {
  readonly client: readonly string[];
  readonly node: readonly string[];
}

export interface MiniAppPackageDigests {
  readonly contentDigest: string;
  readonly clientDigest: string;
  readonly nodeDigest: string;
  readonly ordinaryContentDigest?: string;
}

export interface MiniAppPackageDigestOptions {
  readonly includeOrdinaryContentDigest?: boolean;
  readonly rejectHardlinks?: boolean;
}

export interface PluginContractEntry {
  readonly path: string;
  readonly kind: PluginContractEntryKind;
  readonly content?: Buffer;
  readonly declaredSize?: number;
  readonly compression?: string;
}

export interface PluginContentDigestResult {
  readonly contentDigest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly PluginContractEntry[];
}

export class PluginPackageContractError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'PluginPackageContractError';
  }
}

export function validatePluginPortablePath(relativePath: string): void {
  assertPortablePathShape(relativePath);
  const segments = relativePath.split('/');
  if (segments.length > PLUGIN_PACKAGE_V1_LIMITS.maxPathSegments) {
    fail('PATH_TOO_DEEP', `${JSON.stringify(relativePath)} has too many segments`);
  }
  for (const segment of segments) assertPortablePathSegment(segment, relativePath);
}

/**
 * Agent Plugins only require package paths to remain inside the Plugin root.
 * Keep the MiniMax marketplace's stricter cross-platform naming contract separate
 * so standards-compliant GitHub Plugins may contain ordinary names such as
 * `docs/(redirects)/guide.md` or non-ASCII assets.
 */
function validateAgentPluginPath(relativePath: string): void {
  assertContainedPathShape(relativePath);
  const segments = relativePath.split('/');
  if (segments.length > PLUGIN_PACKAGE_V1_LIMITS.maxPathSegments) {
    fail('PATH_TOO_DEEP', `${JSON.stringify(relativePath)} has too many segments`);
  }
  for (const segment of segments) assertContainedPathSegment(segment, relativePath);
}

function assertPortablePathShape(relativePath: string): void {
  if (!relativePath) fail('INVALID_PATH', 'path is empty');
  if (!/^[\x00-\x7f]*$/u.test(relativePath)) {
    fail('NON_PORTABLE_PATH', `${JSON.stringify(relativePath)} is not ASCII`);
  }
  if (
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/u.test(relativePath)
  ) {
    fail('ABSOLUTE_PATH', `${JSON.stringify(relativePath)} is absolute`);
  }
  if (relativePath.includes('\\')) {
    fail('BACKSLASH_PATH', `${JSON.stringify(relativePath)} contains a backslash`);
  }
  if (relativePath.endsWith('/')) {
    fail('INVALID_PATH', `${JSON.stringify(relativePath)} has a trailing slash`);
  }
  if (/[\x00-\x1f\x7f]/u.test(relativePath)) {
    fail('CONTROL_CHARACTER', `${JSON.stringify(relativePath)} contains a control character`);
  }
  if (Buffer.byteLength(relativePath, 'ascii') > PLUGIN_PACKAGE_V1_LIMITS.maxPathBytes) {
    fail('PATH_TOO_LONG', `${JSON.stringify(relativePath)} exceeds the path limit`);
  }
}

function assertPortablePathSegment(segment: string, relativePath: string): void {
  if (!segment || segment === '.' || segment === '..') {
    fail('PATH_TRAVERSAL', `${JSON.stringify(relativePath)} has an empty/dot segment`);
  }
  if (Buffer.byteLength(segment, 'ascii') > PLUGIN_PACKAGE_V1_LIMITS.maxSegmentBytes) {
    fail('SEGMENT_TOO_LONG', `${JSON.stringify(segment)} exceeds the segment limit`);
  }
  if (!PORTABLE_SEGMENT_PATTERN.test(segment) || segment.endsWith('.')) {
    fail('NON_PORTABLE_PATH', `${JSON.stringify(segment)} is not portable`);
  }
  const [basename = ''] = segment.split('.', 1);
  if (WINDOWS_RESERVED.has(basename.toLowerCase())) {
    fail('WINDOWS_RESERVED_PATH', `${JSON.stringify(segment)} is reserved on Windows`);
  }
}

function assertContainedPathShape(relativePath: string): void {
  if (!relativePath) fail('INVALID_PATH', 'path is empty');
  if (
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/u.test(relativePath)
  ) {
    fail('ABSOLUTE_PATH', `${JSON.stringify(relativePath)} is absolute`);
  }
  if (relativePath.includes('\\')) {
    fail('BACKSLASH_PATH', `${JSON.stringify(relativePath)} contains a backslash`);
  }
  if (relativePath.endsWith('/')) {
    fail('INVALID_PATH', `${JSON.stringify(relativePath)} has a trailing slash`);
  }
  if (/[\x00-\x1f\x7f]/u.test(relativePath)) {
    fail('CONTROL_CHARACTER', `${JSON.stringify(relativePath)} contains a control character`);
  }
  if (Buffer.byteLength(relativePath, 'utf8') > PLUGIN_PACKAGE_V1_LIMITS.maxPathBytes) {
    fail('PATH_TOO_LONG', `${JSON.stringify(relativePath)} exceeds the path limit`);
  }
}

function assertContainedPathSegment(segment: string, relativePath: string): void {
  if (!segment || segment === '.' || segment === '..') {
    fail('PATH_TRAVERSAL', `${JSON.stringify(relativePath)} has an empty/dot segment`);
  }
  if (Buffer.byteLength(segment, 'utf8') > PLUGIN_PACKAGE_V1_LIMITS.maxSegmentBytes) {
    fail('SEGMENT_TOO_LONG', `${JSON.stringify(segment)} exceeds the segment limit`);
  }
  if (process.platform !== 'win32') return;
  if (/[<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment)) {
    fail('HOST_PATH_UNSUPPORTED', `${JSON.stringify(segment)} is not supported on Windows`);
  }
  const [basename = ''] = segment.split('.', 1);
  if (WINDOWS_RESERVED.has(basename.toLowerCase())) {
    fail('WINDOWS_RESERVED_PATH', `${JSON.stringify(segment)} is reserved on Windows`);
  }
}

export function computePluginContentDigest(
  entries: readonly PluginContractEntry[],
  options: PluginPackageDigestOptions = {},
): PluginContentDigestResult {
  const files = validateEntries(entries, true, options.pathPolicy ?? 'minimax-portable');
  for (const file of files) {
    if ((file.compression ?? 'store') !== 'store') {
      fail('UNSUPPORTED_COMPRESSION', `${JSON.stringify(file.path)} is not STORE`);
    }
  }
  const hash = createContentHash(files.length);
  let totalBytes = 0;
  for (const file of files) {
    const content = file.content;
    if (content === undefined) {
      fail('VECTOR_CONTENT_MISSING', `${file.path} has no content`);
    }
    updateFileHeader(hash, file.path, content.length);
    hash.update(content);
    totalBytes += content.length;
  }
  return {
    contentDigest: `sha256-tree-v1:${hash.digest('hex')}`,
    fileCount: files.length,
    totalBytes,
    files,
  };
}

export async function computePluginDirectoryDigest(
  root: string,
  options: PluginPackageDigestOptions = {},
): Promise<Omit<PluginContentDigestResult, 'files'>> {
  const pathPolicy = options.pathPolicy ?? 'minimax-portable';
  const entries: PluginContractEntry[] = [];
  await collectDirectoryEntries(root, '', entries, {
    entryCount: 0,
    fileCount: 0,
    totalBytes: 0,
    pathPolicy,
    rejectHardlinks: options.rejectHardlinks === true,
  });
  const files = validateEntries(entries, false, pathPolicy);
  const hash = createContentHash(files.length);
  let totalBytes = 0;
  for (const file of files) {
    const size = entrySize(file);
    updateFileHeader(hash, file.path, size);
    await hashStableRegularFile(root, file.path, size, {
      hashes: [hash],
      rejectHardlinks: options.rejectHardlinks === true,
    });
    totalBytes += size;
  }
  return {
    contentDigest: `sha256-tree-v1:${hash.digest('hex')}`,
    fileCount: files.length,
    totalBytes,
  };
}

export async function computeMiniAppPackageDigests(
  root: string,
  artifacts: MiniAppArtifactRoots,
  options: MiniAppPackageDigestOptions = {},
): Promise<MiniAppPackageDigests> {
  const includeOrdinaryContentDigest = options.includeOrdinaryContentDigest === true;
  const files = await collectMiniAppFiles(root, artifacts, options);
  const miniAppFiles = includeOrdinaryContentDigest
    ? files.filter((file) => !isMiniAppRuntimePayloadExcludedPath(file.path))
    : files;
  const clientFiles = miniAppFiles.filter((file) =>
    isPathCoveredByRoots(file.path, artifacts.client),
  );
  const nodeFiles = miniAppFiles.filter((file) => isPathCoveredByRoots(file.path, artifacts.node));
  const ordinaryHash = includeOrdinaryContentDigest ? createContentHash(files.length) : undefined;
  const contentHash = createContentHash(miniAppFiles.length);
  const clientHash = createContentHash(clientFiles.length);
  const nodeHash = createContentHash(nodeFiles.length);
  for (const file of files) {
    const size = entrySize(file);
    const hashes: ReturnType<typeof createHash>[] = [];
    if (ordinaryHash) {
      updateFileHeader(ordinaryHash, file.path, size);
      hashes.push(ordinaryHash);
    }
    if (!isMiniAppRuntimePayloadExcludedPath(file.path)) {
      updateFileHeader(contentHash, file.path, size);
      hashes.push(contentHash);
      if (isPathCoveredByRoots(file.path, artifacts.client)) {
        updateFileHeader(clientHash, file.path, size);
        hashes.push(clientHash);
      }
      if (isPathCoveredByRoots(file.path, artifacts.node)) {
        updateFileHeader(nodeHash, file.path, size);
        hashes.push(nodeHash);
      }
    }
    await hashStableRegularFile(root, file.path, size, {
      hashes,
      rejectHardlinks: options.rejectHardlinks === true,
    });
  }
  return {
    contentDigest: `sha256-tree-v1:${contentHash.digest('hex')}`,
    clientDigest: `sha256-tree-v1:${clientHash.digest('hex')}`,
    nodeDigest: `sha256-tree-v1:${nodeHash.digest('hex')}`,
    ...(ordinaryHash
      ? { ordinaryContentDigest: `sha256-tree-v1:${ordinaryHash.digest('hex')}` }
      : {}),
  };
}

async function collectMiniAppFiles(
  root: string,
  artifacts: MiniAppArtifactRoots,
  options: MiniAppPackageDigestOptions = {},
): Promise<PluginContractEntry[]> {
  const entries: PluginContractEntry[] = [];
  const artifactRoots = [...artifacts.client, ...artifacts.node];
  await collectDirectoryEntries(root, '', entries, {
    entryCount: 0,
    fileCount: 0,
    totalBytes: 0,
    pathPolicy: 'minimax-portable',
    rejectHardlinks: options.rejectHardlinks === true,
    skip: (relativePath) => {
      if (!isMiniAppRuntimePayloadExcludedPath(relativePath)) return false;
      if (isPathCoveredByRoots(relativePath, artifactRoots)) {
        fail(
          'MINIAPP_ARTIFACTS_EXCLUDED',
          `${relativePath} is excluded inside a declared runtime artifact`,
        );
      }
      return options.includeOrdinaryContentDigest !== true;
    },
  });
  return validateEntries(entries, false, 'minimax-portable');
}

export function pluginDigestCacheKey(contentDigest: string): string {
  const match = CONTENT_DIGEST_PATTERN.exec(contentDigest);
  if (!match) fail('INVALID_CONTENT_DIGEST', 'content digest has an unsupported format');
  return `sha256-tree-v1-${match[1]}`;
}

function validateEntries(
  entries: readonly PluginContractEntry[],
  requireContent: boolean,
  pathPolicy: PluginPackagePathPolicy,
): PluginContractEntry[] {
  if (entries.length > PLUGIN_PACKAGE_V1_LIMITS.maxArchiveEntries) {
    fail('TOO_MANY_ENTRIES', `${entries.length} entries exceed the limit`);
  }
  const state = createEntryValidationState();
  for (const entry of entries) validateEntry(entry, state, pathPolicy);

  if (state.files.length > PLUGIN_PACKAGE_V1_LIMITS.maxFiles) {
    fail('TOO_MANY_FILES', `${state.files.length} files exceed the limit`);
  }
  if (state.totalBytes > PLUGIN_PACKAGE_V1_LIMITS.maxTotalBytes) {
    fail('TOTAL_SIZE_LIMIT', `${state.totalBytes} bytes exceed the package limit`);
  }
  assertNoPathTypeConflicts(state.kindsByPath);
  if (requireContent) assertRequiredContent(state.files);
  return state.files.sort((left, right) =>
    Buffer.from(left.path.normalize('NFC'), 'utf8').compare(
      Buffer.from(right.path.normalize('NFC'), 'utf8'),
    ),
  );
}

interface EntryValidationState {
  readonly exactPaths: Set<string>;
  readonly portablePrefixes: Map<string, string>;
  readonly kindsByPath: Map<string, PluginContractEntryKind>;
  readonly files: PluginContractEntry[];
  totalBytes: number;
}

function createEntryValidationState(): EntryValidationState {
  return {
    exactPaths: new Set(),
    portablePrefixes: new Map(),
    kindsByPath: new Map(),
    files: [],
    totalBytes: 0,
  };
}

function validateEntry(
  entry: PluginContractEntry,
  state: EntryValidationState,
  pathPolicy: PluginPackagePathPolicy,
): void {
  validatePackagePath(entry.path, pathPolicy);
  if (state.exactPaths.has(entry.path)) fail('DUPLICATE_PATH', `duplicate ${entry.path}`);
  state.exactPaths.add(entry.path);
  registerPortablePrefixes(entry.path, state.portablePrefixes);
  state.kindsByPath.set(entry.path, entry.kind);
  assertSupportedEntryKind(entry);
  if (entry.kind === 'directory') return;
  const size = entrySize(entry);
  assertEntrySize(entry.path, size);
  state.files.push(entry);
  state.totalBytes += size;
}

function registerPortablePrefixes(relativePath: string, prefixes: Map<string, string>): void {
  const segments = relativePath.split('/');
  for (let index = 1; index <= segments.length; index += 1) {
    const prefix = segments.slice(0, index).join('/');
    const key = prefix.normalize('NFC').toLocaleLowerCase('en-US');
    const prior = prefixes.get(key);
    if (prior !== undefined && prior !== prefix) {
      fail('CASE_COLLISION', `${prior} and ${prefix} collide`);
    }
    prefixes.set(key, prefix);
  }
}

function assertSupportedEntryKind(entry: PluginContractEntry): void {
  if (entry.kind === 'symlink') fail('SYMLINK_NOT_ALLOWED', `${entry.path} is a symlink`);
  if (entry.kind === 'hardlink') fail('HARDLINK_NOT_ALLOWED', `${entry.path} is a hardlink`);
  if (entry.kind !== 'file' && entry.kind !== 'directory') {
    fail('SPECIAL_ENTRY_NOT_ALLOWED', `${entry.path} has kind ${entry.kind}`);
  }
}

function assertEntrySize(relativePath: string, size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    fail('INVALID_SIZE', `${relativePath} has an invalid size`);
  }
  if (size > PLUGIN_PACKAGE_V1_LIMITS.maxFileBytes) {
    fail('FILE_TOO_LARGE', `${relativePath} exceeds the file limit`);
  }
}

function assertNoPathTypeConflicts(kindsByPath: ReadonlyMap<string, PluginContractEntryKind>) {
  for (const [relativePath] of kindsByPath) {
    const segments = relativePath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join('/');
      if (kindsByPath.get(parent) === 'file') {
        fail('PATH_TYPE_CONFLICT', `${parent} is a file parent of ${relativePath}`);
      }
    }
  }
}

function assertRequiredContent(files: readonly PluginContractEntry[]): void {
  for (const file of files) {
    if (file.content === undefined) {
      fail('VECTOR_CONTENT_MISSING', `${file.path} has no content`);
    }
    if (file.declaredSize !== undefined && file.declaredSize !== file.content.length) {
      fail('SIZE_MISMATCH', `${file.path} declared and actual sizes differ`);
    }
  }
}

function createContentHash(fileCount: number) {
  const hash = createHash('sha256');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(fileCount, 4);
  hash.update(CONTENT_MAGIC);
  hash.update(header);
  return hash;
}

function updateFileHeader(
  hash: ReturnType<typeof createHash>,
  relativePath: string,
  size: number,
): void {
  const pathBytes = Buffer.from(relativePath.normalize('NFC'), 'utf8');
  const header = Buffer.alloc(13);
  header.writeUInt8(0x46, 0);
  header.writeUInt32BE(pathBytes.length, 1);
  header.writeBigUInt64BE(BigInt(size), 5);
  hash.update(header.subarray(0, 5));
  hash.update(pathBytes);
  hash.update(header.subarray(5));
}

async function collectDirectoryEntries(
  root: string,
  relativeDirectory: string,
  output: PluginContractEntry[],
  limits: DirectoryTraversalState,
): Promise<void> {
  const directory = relativeDirectory ? path.join(root, ...relativeDirectory.split('/')) : root;
  const handle = await opendir(directory);
  for await (const child of handle) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
    if (limits.skip?.(relativePath)) continue;
    const entry = await inspectDirectoryEntry(root, relativePath, child, limits);
    output.push(entry);
    if (entry.kind === 'directory') {
      await collectDirectoryEntries(root, relativePath, output, limits);
    }
  }
}

async function inspectDirectoryEntry(
  root: string,
  relativePath: string,
  child: Dirent,
  limits: DirectoryTraversalState,
): Promise<PluginContractEntry> {
  validatePackagePath(relativePath, limits.pathPolicy);
  limits.entryCount += 1;
  if (limits.entryCount > PLUGIN_PACKAGE_V1_LIMITS.maxArchiveEntries) {
    fail('TOO_MANY_ENTRIES', `${limits.entryCount} entries exceed the limit`);
  }
  if (child.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', `${relativePath} is a symlink`);
  if (child.isDirectory()) return { path: relativePath, kind: 'directory' };
  if (!child.isFile()) {
    fail('SPECIAL_ENTRY_NOT_ALLOWED', `${relativePath} has an unsupported kind`);
  }
  return inspectDirectoryFile(root, relativePath, limits);
}

function validatePackagePath(relativePath: string, policy: PluginPackagePathPolicy): void {
  if (policy === 'unrestricted') {
    assertContainedPathShape(relativePath);
    return;
  }
  if (policy === 'agent-plugin') validateAgentPluginPath(relativePath);
  else validatePluginPortablePath(relativePath);
}

async function inspectDirectoryFile(
  root: string,
  relativePath: string,
  limits: DirectoryTraversalState,
): Promise<PluginContractEntry> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const fileHandle = await open(path.join(root, ...relativePath.split('/')), flags);
  try {
    const stat = await fileHandle.stat();
    if (!stat.isFile()) fail('SPECIAL_ENTRY_NOT_ALLOWED', `${relativePath} is not a file`);
    if (stat.nlink > 1) fail('HARDLINK_NOT_ALLOWED', `${relativePath} is a hardlink`);
    assertEntrySize(relativePath, stat.size);
    limits.fileCount += 1;
    if (limits.fileCount > PLUGIN_PACKAGE_V1_LIMITS.maxFiles) {
      fail('TOO_MANY_FILES', `${limits.fileCount} files exceed the limit`);
    }
    limits.totalBytes += stat.size;
    if (limits.totalBytes > PLUGIN_PACKAGE_V1_LIMITS.maxTotalBytes) {
      fail('TOTAL_SIZE_LIMIT', `${limits.totalBytes} bytes exceed the package limit`);
    }
    return { path: relativePath, kind: 'file', declaredSize: stat.size };
  } finally {
    await fileHandle.close();
  }
}

interface DirectoryTraversalState {
  entryCount: number;
  fileCount: number;
  totalBytes: number;
  readonly pathPolicy: PluginPackagePathPolicy;
  readonly rejectHardlinks?: boolean;
  readonly skip?: (relativePath: string) => boolean;
}

async function hashStableRegularFile(
  root: string,
  relativePath: string,
  expectedSize: number,
  options: {
    readonly hashes: readonly ReturnType<typeof createHash>[];
    readonly rejectHardlinks?: boolean;
  },
): Promise<void> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path.join(root, ...relativePath.split('/')), flags);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size !== expectedSize ||
      (options.rejectHardlinks && before.nlink !== 1)
    ) {
      fail('FILE_CHANGED_DURING_READ', `${relativePath} changed during digest`);
    }
    await hashFileBytes(handle, relativePath, expectedSize, options.hashes);
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, expectedSize)).bytesRead !== 0) {
      fail('FILE_CHANGED_DURING_READ', `${relativePath} grew during digest`);
    }
    const after = await handle.stat();
    if (options.rejectHardlinks && after.nlink !== 1) {
      fail('HARDLINK_NOT_ALLOWED', `${relativePath} is a hardlink`);
    }
    if (!sameFileSnapshot(before, after)) {
      fail('FILE_CHANGED_DURING_READ', `${relativePath} changed during digest`);
    }
  } finally {
    await handle.close();
  }
}

async function hashFileBytes(
  handle: Awaited<ReturnType<typeof open>>,
  relativePath: string,
  expectedSize: number,
  hashes: readonly ReturnType<typeof createHash>[],
): Promise<void> {
  let offset = 0;
  const chunk = Buffer.allocUnsafe(64 * 1024);
  while (offset < expectedSize) {
    const { bytesRead } = await handle.read(
      chunk,
      0,
      Math.min(chunk.length, expectedSize - offset),
      offset,
    );
    if (bytesRead === 0) fail('FILE_CHANGED_DURING_READ', `${relativePath} was truncated`);
    for (const hash of hashes) hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
}

function sameFileSnapshot(
  before: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
  after: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function entrySize(entry: PluginContractEntry): number {
  return entry.declaredSize ?? entry.content?.length ?? 0;
}

function fail(code: string, detail: string): never {
  throw new PluginPackageContractError(code, detail);
}
