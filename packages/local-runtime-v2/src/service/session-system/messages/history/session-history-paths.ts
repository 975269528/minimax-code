import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, posix, relative, win32 } from 'node:path';

import type { SessionRecord } from '../../sessions/repo/contract.js';

export interface SessionHistoryPaths {
  readonly sessionDir: string;
  readonly manifest: string;
  readonly messages: string;
  readonly snapshots: string;
  readonly reports: string;
}

export function ensureResolvedSessionHistoryPaths(
  paths: SessionHistoryPaths,
  session: SessionRecord,
): SessionHistoryPaths {
  mkdirSync(paths.sessionDir, { recursive: true, mode: 0o700 });
  if (isRegularFile(paths.manifest)) {
    assertManifestIdentity(paths.manifest, session);
  } else {
    writeManifest(paths, session);
  }
  return paths;
}

export function deleteSessionHistory(
  dataDir: string,
  session: SessionRecord,
  resolvedPaths?: SessionHistoryPaths,
): void {
  const root = join(dataDir, 'v2', 'sessions');
  const { sessionDir } = resolvedPaths ?? resolveSessionHistoryPaths(dataDir, session);
  const target = relative(root, sessionDir);
  if (!target || target.startsWith('..') || isAbsolute(target)) {
    throw new Error(`Unsafe Session history delete target: ${sessionDir}`);
  }
  if (isRegularFile(join(sessionDir, 'manifest.json'))) {
    assertManifestIdentity(join(sessionDir, 'manifest.json'), session);
  }
  rmSync(sessionDir, { recursive: true, force: true });
}

export function safeHistoryPathSegment(value: string): string {
  return (
    value
      .replaceAll(/[<>:"/\\|?*\u0000-\u001F]/gu, '-')
      .replaceAll(/^\.+/gu, '')
      .slice(0, 180) || 'snapshot'
  );
}

export function resolveSessionHistoryPaths(
  dataDir: string,
  session: Pick<SessionRecord, 'sessionId' | 'createdAtMs' | 'historyRelativeDir'>,
): SessionHistoryPaths {
  const relativeDir =
    session.historyRelativeDir ??
    utcSessionHistoryRelativeDir(session.sessionId, session.createdAtMs);
  return resolveSessionHistoryPathsFromRelativeDir(dataDir, relativeDir);
}

export function resolveLegacyLocalSessionHistoryPaths(
  dataDir: string,
  session: Pick<SessionRecord, 'sessionId' | 'createdAtMs'>,
): SessionHistoryPaths {
  return resolveSessionHistoryPathsFromRelativeDir(
    dataDir,
    legacyLocalSessionHistoryRelativeDir(session.sessionId, session.createdAtMs),
  );
}

export function resolveSessionHistoryPathsFromRelativeDir(
  dataDir: string,
  relativeDir: string,
): SessionHistoryPaths {
  const root = join(dataDir, 'v2', 'sessions');
  const segments = validateRelativeDir(relativeDir);
  const sessionDir = join(root, ...segments);
  return {
    sessionDir,
    manifest: join(sessionDir, 'manifest.json'),
    messages: join(sessionDir, 'messages.jsonl'),
    snapshots: join(sessionDir, 'snapshots'),
    reports: join(sessionDir, 'reports'),
  };
}

export function utcSessionHistoryRelativeDir(sessionId: string, createdAtMs: number): string {
  return buildSessionRelativeDir(sessionId, createdAtMs, 'utc');
}

function legacyLocalSessionHistoryRelativeDir(sessionId: string, createdAtMs: number): string {
  return buildSessionRelativeDir(sessionId, createdAtMs, 'local');
}

function buildSessionRelativeDir(
  sessionId: string,
  createdAtMs: number,
  timezone: 'local' | 'utc',
): string {
  const date = new Date(createdAtMs);
  const utc = timezone === 'utc';
  const parts = [
    String(utc ? date.getUTCFullYear() : date.getFullYear()).padStart(4, '0'),
    String((utc ? date.getUTCMonth() : date.getMonth()) + 1).padStart(2, '0'),
    String(utc ? date.getUTCDate() : date.getDate()).padStart(2, '0'),
  ] as const;
  const time = [
    utc ? date.getUTCHours() : date.getHours(),
    utc ? date.getUTCMinutes() : date.getMinutes(),
    utc ? date.getUTCSeconds() : date.getSeconds(),
    utc ? date.getUTCMilliseconds() : date.getMilliseconds(),
  ]
    .map((part, index) => String(part).padStart(index === 3 ? 3 : 2, '0'))
    .join('-');
  return [...parts, `${time}-${encodedSessionId(sessionId)}`].join('/');
}

function validateRelativeDir(value: string): readonly [string, string, string, string] {
  if (
    !value ||
    value !== value.trim() ||
    value.includes('\\') ||
    isAbsolute(value) ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value)
  ) {
    throw new Error(`Unsafe Session history relative directory: ${value}`);
  }
  const segments = value.split('/');
  if (
    segments.length !== 4 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid Session history relative directory: ${value}`);
  }
  return segments as [string, string, string, string];
}

function writeManifest(paths: SessionHistoryPaths, session: SessionRecord): void {
  const value = {
    schemaVersion: 1,
    sessionId: session.sessionId,
    createdAtMs: session.createdAtMs,
    updatedAtMs: session.updatedAtMs,
    source: 'local-runtime',
    layout: 'v2-final-dated-session',
    paths: {
      sessionDir: paths.sessionDir,
      ledger: join(paths.sessionDir, 'ledger.jsonl'),
      display: join(paths.sessionDir, 'display.jsonl'),
      snapshot: join(paths.sessionDir, 'snapshot.json'),
      reports: paths.reports,
      messages: paths.messages,
    },
  };
  const temporary = `${paths.manifest}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporary, paths.manifest);
}

function assertManifestIdentity(path: string, session: SessionRecord): void {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Invalid Session history manifest: ${path}`, { cause: error });
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Reflect.get(value, 'sessionId') !== session.sessionId ||
    Reflect.get(value, 'createdAtMs') !== session.createdAtMs
  ) {
    throw new Error(`Session history manifest identity mismatch: ${path}`);
  }
}

function isRegularFile(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function encodedSessionId(sessionId: string): string {
  return `session_${Buffer.from(sessionId || 'unknown-session', 'utf8')
    .toString('base64url')
    .slice(0, 180)}`;
}
