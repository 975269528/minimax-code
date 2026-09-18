import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../common/logger.js';
import type {
  LocalTurnDiffRewindFilePlan,
  LocalTurnDiffSnapshotEntry,
} from '../persistence/ports.js';

export type LocalTurnDiffRewindPreflightErrorCode =
  | 'partial-turn'
  | 'not-undoable'
  | 'unsafe-path'
  | 'snapshot-incomplete'
  | 'chain-conflict'
  | 'workspace-conflict'
  | 'request-conflict';

export class LocalTurnDiffRewindPreflightError extends Error {
  constructor(
    readonly code: LocalTurnDiffRewindPreflightErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LocalTurnDiffRewindPreflightError';
  }
}

export type FileApplyResult =
  | { readonly status: 'applied'; readonly turnIds: readonly string[] }
  | {
      readonly status: 'skipped';
      readonly reason:
        | 'workspace-file-missing'
        | 'workspace-file-unexpected'
        | 'workspace-content-changed'
        | 'workspace-read-failed'
        | 'workspace-write-failed';
      readonly errorCode?: string;
    };

export async function applyFileIfSafe(file: LocalTurnDiffRewindFilePlan): Promise<FileApplyResult> {
  let current: LocalTurnDiffSnapshotEntry;
  try {
    current = await snapshotFile(file);
  } catch (error) {
    return skippedFile('workspace-read-failed', error);
  }
  const conflict = workspaceConflictReason(current, file.expected);
  if (conflict) return { status: 'skipped', reason: conflict };
  try {
    await writeTarget(file);
    return { status: 'applied', turnIds: file.turnIds ?? [] };
  } catch (error) {
    return skippedFile('workspace-write-failed', error);
  }
}

export async function fileMatches(file: LocalTurnDiffRewindFilePlan): Promise<boolean> {
  try {
    return sameSnapshot(await snapshotFile(file), file.expected);
  } catch {
    return false;
  }
}

export function logSkippedFile(
  input: { readonly operationId: string; readonly sessionId: string },
  file: LocalTurnDiffRewindFilePlan,
  result: Extract<FileApplyResult, { readonly status: 'skipped' }>,
): void {
  logFileSkip({
    operationId: input.operationId,
    sessionId: input.sessionId,
    file: file.file,
    turnIds: file.turnIds ?? [],
    reason: result.reason,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  });
}

export function logFileSkip(fields: {
  readonly operationId: string;
  readonly sessionId: string;
  readonly file: string;
  readonly turnIds: readonly string[];
  readonly reason: string;
  readonly errorCode?: string;
}): void {
  try {
    logger.warn(fields, 'Turn diff rewind file skipped');
  } catch {
    // Engineering logging is best-effort and cannot affect Rewind.
  }
}

export function planKey(plan: Pick<LocalTurnDiffRewindFilePlan, 'workspaceDir' | 'file'>): string {
  return `${path.resolve(plan.workspaceDir)}\0${plan.file}`;
}

export function requireSafeRelativePath(file: string): string {
  const portable = file.replaceAll('\\', '/');
  const segments = portable.split('/');
  if (
    !portable ||
    portable.includes('\0') ||
    path.isAbsolute(file) ||
    path.win32.isAbsolute(file) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    preflightError('unsafe-path', `Unsafe Turn diff path: ${file}`);
  }
  return segments.join('/');
}

export function assertSnapshotComplete(
  snapshot: LocalTurnDiffSnapshotEntry,
  file: string,
  requireContent: boolean,
): void {
  if (snapshot.file !== file || snapshot.binary || snapshot.oversized) {
    preflightError('snapshot-incomplete', `Turn diff snapshot is incomplete: ${file}`);
  }
  if (
    snapshot.exists &&
    snapshot.content === undefined &&
    (requireContent || snapshot.hash === undefined)
  ) {
    preflightError('snapshot-incomplete', `Turn diff snapshot content is missing: ${file}`);
  }
}

export function sameSnapshot(
  left: LocalTurnDiffSnapshotEntry,
  right: LocalTurnDiffSnapshotEntry,
): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists) return true;
  return snapshotDigest(left) === snapshotDigest(right);
}

function workspaceConflictReason(
  current: LocalTurnDiffSnapshotEntry,
  expected: LocalTurnDiffSnapshotEntry,
): Extract<FileApplyResult, { readonly status: 'skipped' }>['reason'] | undefined {
  if (current.exists !== expected.exists) {
    return current.exists ? 'workspace-file-unexpected' : 'workspace-file-missing';
  }
  if (!current.exists) return undefined;
  return snapshotDigest(current) === snapshotDigest(expected)
    ? undefined
    : 'workspace-content-changed';
}

function skippedFile(
  reason: Extract<FileApplyResult, { readonly status: 'skipped' }>['reason'],
  error: unknown,
): FileApplyResult {
  const errorCode = readErrorCode(error);
  return { status: 'skipped', reason, ...(errorCode ? { errorCode } : {}) };
}

async function writeTarget(file: LocalTurnDiffRewindFilePlan): Promise<void> {
  const target = resolvePlanPath(file);
  if (!file.target.exists) {
    await rm(target, { force: true });
    return;
  }
  if (file.target.content === undefined) {
    preflightError('snapshot-incomplete', `Turn diff target content is missing: ${file.file}`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, file.target.content, 'utf8');
}

async function snapshotFile(
  plan: LocalTurnDiffRewindFilePlan,
): Promise<LocalTurnDiffSnapshotEntry> {
  const target = resolvePlanPath(plan);
  try {
    const content = await readFile(target);
    return {
      file: plan.file,
      exists: true,
      hash: createHash('sha256').update(content).digest('hex'),
      sizeBytes: content.byteLength,
      content: content.toString('utf8'),
    };
  } catch (error) {
    if (isMissing(error)) return { file: plan.file, exists: false };
    throw error;
  }
}

function resolvePlanPath(plan: LocalTurnDiffRewindFilePlan): string {
  const file = requireSafeRelativePath(plan.file);
  const root = path.resolve(plan.workspaceDir);
  const absolute = path.resolve(root, file);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!absolute.startsWith(prefix)) preflightError('unsafe-path', `Unsafe Turn diff path: ${file}`);
  return absolute;
}

function snapshotDigest(snapshot: LocalTurnDiffSnapshotEntry): string | undefined {
  return (
    snapshot.hash ??
    (snapshot.content === undefined
      ? undefined
      : createHash('sha256').update(snapshot.content).digest('hex'))
  );
}

function preflightError(code: LocalTurnDiffRewindPreflightErrorCode, message: string): never {
  throw new LocalTurnDiffRewindPreflightError(code, message);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function readErrorCode(error: unknown): string | undefined {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === 'string' ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
