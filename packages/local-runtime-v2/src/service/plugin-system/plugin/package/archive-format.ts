import {
  computePluginContentDigest,
  PLUGIN_PACKAGE_V1_LIMITS,
  PluginPackageContractError,
  type PluginContentDigestResult,
  type PluginContractEntry,
} from './package-contract.js';

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_SYMLINK = 0o120000;

export interface ParsedPluginArchive {
  readonly entries: readonly ParsedArchiveEntry[];
  readonly digest: PluginContentDigestResult;
}

interface ParsedArchiveEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly content: Buffer;
}

export class PluginArchiveError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'PluginArchiveError';
  }
}

interface CentralEntry {
  readonly path: string;
  readonly rawName: Buffer;
  readonly kind: 'file' | 'directory' | 'symlink' | 'special';
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

interface CentralDirectoryRecord {
  readonly endOffset: number;
  readonly entryCount: number;
  readonly centralOffset: number;
}

interface CentralHeader {
  readonly versionMadeBy: number;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly nameLength: number;
  readonly extraLength: number;
  readonly commentLength: number;
  readonly diskStart: number;
  readonly externalAttributes: number;
  readonly localOffset: number;
}

export function parsePluginArchive(archive: Buffer): ParsedPluginArchive {
  try {
    return parseArchiveUnchecked(archive);
  } catch (error) {
    if (error instanceof PluginArchiveError) throw error;
    if (error instanceof PluginPackageContractError) {
      throw new PluginArchiveError(error.code, error.detail);
    }
    throw error;
  }
}

function parseArchiveUnchecked(archive: Buffer): ParsedPluginArchive {
  if (archive.length > PLUGIN_PACKAGE_V1_LIMITS.maxArchiveBytes) {
    fail('ARCHIVE_TOO_LARGE', `${archive.length} bytes exceed the archive limit`);
  }
  if (archive.length < 22) fail('INVALID_ZIP', 'end-of-central-directory record is missing');
  const directory = readCentralDirectoryRecord(archive);
  const centralEntries = readCentralEntries(archive, directory);
  return parseArchiveEntries(archive, centralEntries, directory.centralOffset);
}

function readCentralDirectoryRecord(archive: Buffer): CentralDirectoryRecord {
  const endOffset = archive.length - 22;
  expectSignature(archive, endOffset, END_SIGNATURE, 'end-of-central-directory');
  const disk = readU16(archive, endOffset + 4);
  const centralDisk = readU16(archive, endOffset + 6);
  const entriesOnDisk = readU16(archive, endOffset + 8);
  const entryCount = readU16(archive, endOffset + 10);
  const centralSize = readU32(archive, endOffset + 12);
  const centralOffset = readU32(archive, endOffset + 16);
  const commentLength = readU16(archive, endOffset + 20);
  if (commentLength !== 0) fail('ARCHIVE_COMMENT_NOT_ALLOWED', 'ZIP comment must be empty');
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    fail('MULTI_DISK_NOT_ALLOWED', 'multi-disk ZIP is not supported');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    fail('ZIP64_NOT_ALLOWED', 'ZIP64 sentinel values are not supported');
  }
  if (entryCount > PLUGIN_PACKAGE_V1_LIMITS.maxArchiveEntries) {
    fail('TOO_MANY_ENTRIES', `${entryCount} entries exceed the limit`);
  }
  if (centralOffset + centralSize !== endOffset) {
    fail('INVALID_ZIP', 'central directory bounds do not match the archive');
  }
  return { endOffset, entryCount, centralOffset };
}

function readCentralEntries(archive: Buffer, directory: CentralDirectoryRecord): CentralEntry[] {
  const centralEntries: CentralEntry[] = [];
  let cursor = directory.centralOffset;
  for (let index = 0; index < directory.entryCount; index += 1) {
    const parsed = parseCentralEntry(archive, cursor, directory.endOffset);
    centralEntries.push(parsed.entry);
    cursor = parsed.nextOffset;
  }
  if (cursor !== directory.endOffset) {
    fail('INVALID_ZIP', 'central directory entry count is inconsistent');
  }
  return centralEntries;
}

function parseArchiveEntries(
  archive: Buffer,
  centralEntries: readonly CentralEntry[],
  centralOffset: number,
): ParsedPluginArchive {
  const parsedEntries: ParsedArchiveEntry[] = [];
  const localRanges: Array<{ start: number; end: number }> = [];
  const contractEntries: PluginContractEntry[] = [];
  for (const entry of centralEntries) {
    const local = parseLocalEntry(archive, entry, centralOffset);
    localRanges.push({ start: entry.localOffset, end: local.endOffset });
    const content = archive.subarray(local.dataOffset, local.endOffset);
    if (crc32(content) !== entry.crc) fail('CRC_MISMATCH', `${entry.path} has an invalid CRC`);
    contractEntries.push({
      path: entry.path,
      kind: entry.kind,
      content,
      declaredSize: entry.uncompressedSize,
      compression: entry.method === 0 ? 'store' : `method-${entry.method}`,
    });
    if (entry.kind === 'file' || entry.kind === 'directory') {
      parsedEntries.push({ path: entry.path, kind: entry.kind, content });
    }
  }
  assertLocalRangesDoNotOverlap(localRanges);
  const digest = computePluginContentDigest(contractEntries);
  return { entries: parsedEntries, digest };
}

function parseCentralEntry(
  archive: Buffer,
  offset: number,
  centralEnd: number,
): { entry: CentralEntry; nextOffset: number } {
  ensureRange(archive, offset, 46, 'central directory header');
  expectSignature(archive, offset, CENTRAL_HEADER_SIGNATURE, 'central directory');
  const header = readCentralHeader(archive, offset);
  assertCentralHeader(header);
  const namedEntry = readCentralEntryName(archive, offset, centralEnd, header);
  return {
    entry: {
      path: namedEntry.path,
      rawName: namedEntry.rawName,
      kind: namedEntry.kind,
      flags: header.flags,
      method: header.method,
      crc: header.crc,
      compressedSize: header.compressedSize,
      uncompressedSize: header.uncompressedSize,
      localOffset: header.localOffset,
    },
    nextOffset: namedEntry.nextOffset,
  };
}

function readCentralHeader(archive: Buffer, offset: number): CentralHeader {
  return {
    versionMadeBy: readU16(archive, offset + 4),
    flags: readU16(archive, offset + 8),
    method: readU16(archive, offset + 10),
    crc: readU32(archive, offset + 16),
    compressedSize: readU32(archive, offset + 20),
    uncompressedSize: readU32(archive, offset + 24),
    nameLength: readU16(archive, offset + 28),
    extraLength: readU16(archive, offset + 30),
    commentLength: readU16(archive, offset + 32),
    diskStart: readU16(archive, offset + 34),
    externalAttributes: readU32(archive, offset + 38),
    localOffset: readU32(archive, offset + 42),
  };
}

function assertCentralHeader(header: CentralHeader): void {
  assertFlags(header.flags);
  if (header.method !== 0) {
    fail('UNSUPPORTED_COMPRESSION', `ZIP method ${header.method} is not STORE`);
  }
  if (
    header.compressedSize === 0xffffffff ||
    header.uncompressedSize === 0xffffffff ||
    header.localOffset === 0xffffffff
  ) {
    fail('ZIP64_NOT_ALLOWED', 'ZIP64 entry values are not supported');
  }
  if (header.extraLength !== 0) {
    fail('EXTRA_FIELD_NOT_ALLOWED', 'ZIP extra fields are not supported');
  }
  if (header.commentLength !== 0) {
    fail('ENTRY_COMMENT_NOT_ALLOWED', 'ZIP entry comments are not supported');
  }
  if (header.diskStart !== 0) {
    fail('MULTI_DISK_NOT_ALLOWED', 'entry belongs to a non-zero disk');
  }
  if (header.compressedSize !== header.uncompressedSize) {
    fail('SIZE_MISMATCH', 'STORE entry compressed and uncompressed sizes differ');
  }
}

function readCentralEntryName(
  archive: Buffer,
  offset: number,
  centralEnd: number,
  header: CentralHeader,
): Pick<CentralEntry, 'path' | 'rawName' | 'kind'> & { nextOffset: number } {
  const nextOffset = offset + 46 + header.nameLength;
  ensureRange(archive, offset + 46, header.nameLength, 'central entry name');
  if (nextOffset > centralEnd) {
    fail('INVALID_ZIP', 'central entry exceeds the central directory');
  }
  const rawName = archive.subarray(offset + 46, nextOffset);
  const renderedName = decodeAsciiName(rawName);
  const hasDirectorySuffix = renderedName.endsWith('/');
  const path = hasDirectorySuffix ? renderedName.slice(0, -1) : renderedName;
  const kind = classifyEntry(header.versionMadeBy, header.externalAttributes, hasDirectorySuffix);
  if (kind === 'directory' && !hasDirectorySuffix) {
    fail('INVALID_DIRECTORY_ENTRY', `${path} is a directory without a trailing slash`);
  }
  if (kind !== 'directory' && hasDirectorySuffix) {
    fail('INVALID_DIRECTORY_ENTRY', `${path} has a directory suffix but is not a directory`);
  }
  if (kind === 'directory' && (header.compressedSize !== 0 || header.uncompressedSize !== 0)) {
    fail('INVALID_DIRECTORY_ENTRY', `${path} directory entry is not empty`);
  }
  return { path, rawName, kind, nextOffset };
}

function parseLocalEntry(
  archive: Buffer,
  central: CentralEntry,
  centralOffset: number,
): { dataOffset: number; endOffset: number } {
  const offset = central.localOffset;
  ensureRange(archive, offset, 30, 'local file header');
  expectSignature(archive, offset, LOCAL_HEADER_SIGNATURE, 'local file');
  const flags = readU16(archive, offset + 6);
  const method = readU16(archive, offset + 8);
  const crc = readU32(archive, offset + 14);
  const compressedSize = readU32(archive, offset + 18);
  const uncompressedSize = readU32(archive, offset + 22);
  const nameLength = readU16(archive, offset + 26);
  const extraLength = readU16(archive, offset + 28);
  assertFlags(flags);
  if (extraLength !== 0) fail('EXTRA_FIELD_NOT_ALLOWED', 'local ZIP extra field is not empty');
  if (
    flags !== central.flags ||
    method !== central.method ||
    crc !== central.crc ||
    compressedSize !== central.compressedSize ||
    uncompressedSize !== central.uncompressedSize
  ) {
    fail('LOCAL_HEADER_MISMATCH', `${central.path} local and central headers differ`);
  }
  ensureRange(archive, offset + 30, nameLength, 'local entry name');
  const localName = archive.subarray(offset + 30, offset + 30 + nameLength);
  if (!localName.equals(central.rawName)) {
    fail('LOCAL_HEADER_MISMATCH', `${central.path} local and central names differ`);
  }
  const dataOffset = offset + 30 + nameLength;
  const endOffset = dataOffset + compressedSize;
  if (endOffset > centralOffset) {
    fail('INVALID_ZIP', `${central.path} data overlaps the central directory`);
  }
  return { dataOffset, endOffset };
}

function classifyEntry(
  versionMadeBy: number,
  externalAttributes: number,
  directorySuffix: boolean,
): CentralEntry['kind'] {
  const createSystem = versionMadeBy >>> 8;
  if (createSystem === 3) {
    const type = (externalAttributes >>> 16) & UNIX_FILE_TYPE_MASK;
    if (type === UNIX_SYMLINK) return 'symlink';
    if (type === UNIX_DIRECTORY) return 'directory';
    if (type === UNIX_REGULAR_FILE || type === 0) return directorySuffix ? 'directory' : 'file';
    return 'special';
  }
  const dosDirectory = (externalAttributes & 0x10) !== 0;
  return dosDirectory || directorySuffix ? 'directory' : 'file';
}

function assertFlags(flags: number): void {
  if ((flags & 0x0001) !== 0) fail('ENCRYPTION_NOT_ALLOWED', 'encrypted ZIP entry');
  if ((flags & 0x0008) !== 0) fail('DATA_DESCRIPTOR_NOT_ALLOWED', 'data descriptor ZIP entry');
  if (flags !== 0) fail('UNSUPPORTED_ZIP_FLAGS', `unsupported ZIP flags 0x${flags.toString(16)}`);
}

function assertLocalRangesDoNotOverlap(ranges: Array<{ start: number; end: number }>): void {
  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    const current = ranges[index];
    const previous = ranges[index - 1];
    if (current !== undefined && previous !== undefined && current.start < previous.end) {
      fail('OVERLAPPING_ENTRIES', 'local ZIP entries overlap');
    }
  }
}

function decodeAsciiName(rawName: Buffer): string {
  if (rawName.length === 0) fail('INVALID_PATH', 'ZIP entry name is empty');
  if (rawName.some((byte) => byte > 0x7f)) {
    fail('NON_PORTABLE_PATH', 'ZIP entry name is not ASCII');
  }
  return rawName.toString('ascii');
}

function expectSignature(archive: Buffer, offset: number, signature: number, label: string): void {
  ensureRange(archive, offset, 4, `${label} signature`);
  if (readU32(archive, offset) !== signature) fail('INVALID_ZIP', `${label} signature is invalid`);
}

function ensureRange(archive: Buffer, offset: number, length: number, label: string): void {
  if (offset < 0 || length < 0 || offset + length > archive.length) {
    fail('INVALID_ZIP', `${label} exceeds archive bounds`);
  }
}

function readU16(archive: Buffer, offset: number): number {
  ensureRange(archive, offset, 2, 'uint16');
  return archive.readUInt16LE(offset);
}

function readU32(archive: Buffer, offset: number): number {
  ensureRange(archive, offset, 4, 'uint32');
  return archive.readUInt32LE(offset);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    const tableValue = CRC32_TABLE[(crc ^ byte) & 0xff];
    if (tableValue === undefined) fail('INVALID_ZIP', 'CRC lookup failed');
    crc = tableValue ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_value, index) => {
  let current = index;
  for (let bit = 0; bit < 8; bit += 1) {
    current = (current & 1) === 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  }
  return current >>> 0;
});

function fail(code: string, detail: string): never {
  throw new PluginArchiveError(code, detail);
}
