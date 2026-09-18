import { mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import type { WorkspaceFileContent } from '../contracts.js';

const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
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

interface WorkspaceFileReadOutcome {
  value: WorkspaceFileContent;
  readSucceeded: boolean;
}

export async function readWorkspaceFile(
  workspace: string,
  filePath: string,
): Promise<WorkspaceFileContent> {
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
    return { value: { type: 'text', content: bytes.toString('utf8') }, readSucceeded: true };
  } catch {
    return { value: { type: 'text', content: '' }, readSucceeded: false };
  }
}

export async function resolveWorkspacePath(
  workspace: string,
  child: string,
): Promise<string | undefined> {
  const root = resolve(workspace);
  const target = resolveInside(root, child);
  if (!target) return undefined;
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    return isPathInside(realRoot, realTarget) ? realTarget : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveWorkspaceWritePath(
  workspace: string,
  child: string,
): Promise<string | undefined> {
  const lexicalRoot = resolve(workspace);
  const lexicalTarget = resolveInside(lexicalRoot, child);
  if (!lexicalTarget) return undefined;
  try {
    const realRoot = await realpath(lexicalRoot);
    const realParent = await createValidatedParent(realRoot, dirname(lexicalTarget));
    if (!realParent) return undefined;
    const target = join(realParent, basename(lexicalTarget));
    const existing = await realpathOrFallback(target);
    return isPathInside(realRoot, existing) ? target : undefined;
  } catch {
    return undefined;
  }
}

async function createValidatedParent(
  realRoot: string,
  requestedParent: string,
): Promise<string | undefined> {
  const ancestor = await findExistingAncestor(requestedParent);
  if (!ancestor || !isPathInside(realRoot, ancestor.realPath)) return undefined;
  let safeParent = ancestor.realPath;
  for (const segment of ancestor.missingSegments) {
    const next = join(safeParent, segment);
    try {
      await mkdir(next);
    } catch (error) {
      if (!isAlreadyExistsError(error)) return undefined;
    }
    let realNext: string | undefined;
    try {
      realNext = await realpath(next);
    } catch {
      return undefined;
    }
    if (!isPathInside(realRoot, realNext)) return undefined;
    safeParent = realNext;
  }
  return safeParent;
}

async function findExistingAncestor(
  requestedParent: string,
): Promise<{ realPath: string; missingSegments: string[] } | undefined> {
  const missingSegments: string[] = [];
  let existingAncestor = requestedParent;

  for (;;) {
    try {
      return { realPath: await realpath(existingAncestor), missingSegments };
    } catch {
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) return undefined;
      missingSegments.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}

async function realpathOrFallback(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return target;
  }
}

export function isKnownBinaryExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(ext);
}

export function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveInside(root: string, child: string): string | undefined {
  const target = isAbsolute(child) ? resolve(child) : resolve(root, child);
  return isPathInside(root, target) ? target : undefined;
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
    const byte = bytes[index] as number;
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
