import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import type {
  SessionHistoryIdentity,
  SessionRecord,
  SessionRepository,
} from '../../sessions/repo/contract.js';
import {
  ensureResolvedSessionHistoryPaths,
  resolveLegacyLocalSessionHistoryPaths,
  resolveSessionHistoryPaths,
  resolveSessionHistoryPathsFromRelativeDir,
  utcSessionHistoryRelativeDir,
  type SessionHistoryPaths,
} from './session-history-paths.js';

type SessionLocationRepository = Pick<SessionRepository, 'get'> &
  Partial<Pick<SessionRepository, 'bindHistoryRelativeDir'>>;

export interface SessionHistoryLocationResolver {
  resolve(session: SessionHistoryIdentity): Promise<SessionHistoryPaths>;
  /** Assigns the UTC location for a newly-created Session without scanning legacy data. */
  allocate(session: SessionRecord): Promise<SessionHistoryPaths>;
  ensure(session: SessionRecord): Promise<SessionHistoryPaths>;
  /** Locates history for an existing identity without binding or creating artifacts. */
  inspect(session: SessionHistoryIdentity): Promise<SessionHistoryPaths>;
  /** Locates existing history without binding a directory or creating history artifacts. */
  inspectSession(
    sessionId: string,
  ): Promise<{ readonly session: SessionRecord; readonly paths: SessionHistoryPaths } | undefined>;
  resolveSession(
    sessionId: string,
  ): Promise<{ readonly session: SessionRecord; readonly paths: SessionHistoryPaths } | undefined>;
}

export interface SessionHistoryLocationResolverOptions {
  readonly dataDir: string;
  readonly sessions: SessionLocationRepository;
}

interface ManifestCandidate {
  readonly sessionId: string;
  readonly createdAtMs: number;
  readonly relativeDir: string;
  readonly historyKind: 'canonical' | 'legacy' | 'manifest';
  readonly modifiedAtMs: number;
}

const MANIFEST_SCAN_CONCURRENCY = 16;
const HISTORY_KIND_PRIORITY = { canonical: 2, legacy: 1, manifest: 0 } as const;

/** Resolves legacy layouts once, then persists the selected relative directory. */
export function createSessionHistoryLocationResolver(
  options: SessionHistoryLocationResolverOptions,
): SessionHistoryLocationResolver {
  const inFlight = new Map<string, Promise<SessionHistoryPaths>>();
  let manifestIndex: Promise<ReadonlyMap<string, readonly ManifestCandidate[]>> | undefined;

  const resolve = async (session: SessionHistoryIdentity): Promise<SessionHistoryPaths> =>
    resolveBoundOrTrack(session, () => resolveUnbound(session));

  const allocate = async (session: SessionRecord): Promise<SessionHistoryPaths> =>
    ensureResolvedSessionHistoryPaths(
      await resolveBoundOrTrack(session, () =>
        bindRelativeDir(
          session,
          utcSessionHistoryRelativeDir(session.sessionId, session.createdAtMs),
        ),
      ),
      session,
    );

  const ensure = async (session: SessionRecord): Promise<SessionHistoryPaths> =>
    ensureResolvedSessionHistoryPaths(await resolve(session), session);

  const inspect = async (session: SessionHistoryIdentity): Promise<SessionHistoryPaths> =>
    session.historyRelativeDir
      ? resolveSessionHistoryPaths(options.dataDir, session)
      : resolveSessionHistoryPathsFromRelativeDir(
          options.dataDir,
          await selectUnboundRelativeDir(session),
        );

  const inspectSession = async (sessionId: string) => {
    const session = await options.sessions.get(sessionId);
    if (!session) return undefined;
    return { session, paths: await inspect(session) };
  };

  const resolveSession = async (sessionId: string) => {
    const session = await options.sessions.get(sessionId);
    if (!session) return undefined;
    return { session, paths: await resolve(session) };
  };

  function resolveBoundOrTrack(
    identity: SessionHistoryIdentity,
    operation: () => Promise<SessionHistoryPaths>,
  ): Promise<SessionHistoryPaths> {
    if (identity.historyRelativeDir) {
      return Promise.resolve(resolveSessionHistoryPaths(options.dataDir, identity));
    }
    const pending = inFlight.get(identity.sessionId);
    if (pending) return pending;
    const task = runTracked(identity.sessionId, operation);
    inFlight.set(identity.sessionId, task);
    return task;
  }

  async function runTracked(
    sessionId: string,
    operation: () => Promise<SessionHistoryPaths>,
  ): Promise<SessionHistoryPaths> {
    try {
      return await operation();
    } finally {
      inFlight.delete(sessionId);
    }
  }

  async function resolveUnbound(identity: SessionHistoryIdentity): Promise<SessionHistoryPaths> {
    const relativeDir = await selectUnboundRelativeDir(identity);
    return bindRelativeDir(identity, relativeDir);
  }

  async function selectUnboundRelativeDir(identity: SessionHistoryIdentity): Promise<string> {
    return (
      (await discoverLegacyRelativeDir(identity)) ??
      utcSessionHistoryRelativeDir(identity.sessionId, identity.createdAtMs)
    );
  }

  async function bindRelativeDir(
    identity: SessionHistoryIdentity,
    relativeDir: string,
  ): Promise<SessionHistoryPaths> {
    resolveSessionHistoryPathsFromRelativeDir(options.dataDir, relativeDir);
    const bound = options.sessions.bindHistoryRelativeDir
      ? await options.sessions.bindHistoryRelativeDir(identity.sessionId, relativeDir)
      : relativeDir;
    if (!bound) throw new Error(`Session not found while binding history: ${identity.sessionId}`);
    return resolveSessionHistoryPathsFromRelativeDir(options.dataDir, bound);
  }

  async function discoverLegacyRelativeDir(
    session: SessionHistoryIdentity,
  ): Promise<string | undefined> {
    const legacyPaths = resolveLegacyLocalSessionHistoryPaths(options.dataDir, session);
    const direct = await readManifestCandidate(options.dataDir, legacyPaths.manifest);
    const index = await loadManifestIndex();
    const indexed = index.get(manifestKey(session)) ?? [];
    const candidates = uniqueCandidates(
      direct && matchesSession(direct, session) ? [direct, ...indexed] : indexed,
    );
    return selectCandidate(candidates, session)?.relativeDir;
  }

  async function loadManifestIndex(): Promise<ReadonlyMap<string, readonly ManifestCandidate[]>> {
    manifestIndex ??= buildManifestIndex(options.dataDir);
    try {
      return await manifestIndex;
    } catch (error) {
      manifestIndex = undefined;
      throw error;
    }
  }

  return { resolve, allocate, ensure, inspect, inspectSession, resolveSession };
}

async function buildManifestIndex(
  dataDir: string,
): Promise<ReadonlyMap<string, readonly ManifestCandidate[]>> {
  const root = join(dataDir, 'v2', 'sessions');
  const manifests = await listManifestPaths(root);
  const candidates = (
    await mapWithConcurrency(manifests, MANIFEST_SCAN_CONCURRENCY, (path) =>
      readManifestCandidate(dataDir, path),
    )
  ).filter((candidate): candidate is ManifestCandidate => candidate !== undefined);
  return candidates.reduce<Map<string, ManifestCandidate[]>>((index, candidate) => {
    const key = manifestKey(candidate);
    index.set(key, [...(index.get(key) ?? []), candidate]);
    return index;
  }, new Map());
}

async function listManifestPaths(root: string): Promise<readonly string[]> {
  const years = await safeReadDirectories(root);
  const months = await pathsAtDepth(root, years);
  const days = await pathsAtDepth(root, months);
  const sessions = await pathsAtDepth(root, days);
  return sessions.map((sessionDir) => join(root, sessionDir, 'manifest.json'));
}

async function pathsAtDepth(root: string, parents: readonly string[]): Promise<readonly string[]> {
  const children = await mapWithConcurrency(parents, MANIFEST_SCAN_CONCURRENCY, async (parent) =>
    (await safeReadDirectories(join(root, parent))).map((child) => join(parent, child)),
  );
  return children.flat();
}

async function safeReadDirectories(path: string): Promise<readonly string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map(({ name }) => name);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return [];
    throw error;
  }
}

async function readManifestCandidate(
  dataDir: string,
  manifestPath: string,
): Promise<ManifestCandidate | undefined> {
  try {
    return await readExistingManifestCandidate(dataDir, manifestPath);
  } catch (error) {
    if (isIgnorableManifestError(error)) return undefined;
    throw error;
  }
}

async function readExistingManifestCandidate(
  dataDir: string,
  manifestPath: string,
): Promise<ManifestCandidate | undefined> {
  const info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink()) return undefined;
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  if (!isManifestIdentity(parsed)) return undefined;
  const sessionDir = dirname(manifestPath);
  const root = join(dataDir, 'v2', 'sessions');
  const relativeDir = relative(root, sessionDir).split(sep).join('/');
  const paths = resolveSessionHistoryPathsFromRelativeDir(dataDir, relativeDir);
  const [canonicalTargetModifiedAtMs, ledgerModifiedAtMs, snapshotModifiedAtMs] = await Promise.all(
    [
      regularFileModifiedAtMs(paths.messages),
      regularFileModifiedAtMs(join(paths.sessionDir, 'ledger.jsonl')),
      regularFileModifiedAtMs(join(paths.sessionDir, 'snapshot.json')),
    ],
  );
  const historyArtifactModifiedAtMs = latestModifiedAtMs([
    canonicalTargetModifiedAtMs,
    ledgerModifiedAtMs,
    snapshotModifiedAtMs,
  ]);
  return {
    sessionId: parsed.sessionId,
    createdAtMs: parsed.createdAtMs,
    relativeDir,
    historyKind: candidateHistoryKind(canonicalTargetModifiedAtMs, historyArtifactModifiedAtMs),
    modifiedAtMs: canonicalTargetModifiedAtMs ?? historyArtifactModifiedAtMs ?? info.mtimeMs,
  };
}

function candidateHistoryKind(
  canonicalTargetModifiedAtMs: number | undefined,
  historyArtifactModifiedAtMs: number | undefined,
): ManifestCandidate['historyKind'] {
  if (canonicalTargetModifiedAtMs !== undefined) return 'canonical';
  if (historyArtifactModifiedAtMs !== undefined) return 'legacy';
  return 'manifest';
}

function isIgnorableManifestError(error: unknown): boolean {
  return (
    hasCode(error, 'ENOENT') ||
    error instanceof SyntaxError ||
    (error instanceof Error && /Session history relative directory/u.test(error.message))
  );
}

function selectCandidate(
  candidates: readonly ManifestCandidate[],
  session: SessionHistoryIdentity,
): ManifestCandidate | undefined {
  if (candidates.length <= 1) return candidates[0];
  const first = candidates[0];
  if (!first) return undefined;
  const utcRelativeDir = utcSessionHistoryRelativeDir(session.sessionId, session.createdAtMs);
  // Duplicate manifests must not block a Turn: prefer stronger history, then recent activity.
  return candidates
    .slice(1)
    .reduce(
      (selected, candidate) =>
        compareCandidates(candidate, selected, utcRelativeDir) < 0 ? candidate : selected,
      first,
    );
}

function compareCandidates(
  left: ManifestCandidate,
  right: ManifestCandidate,
  utcRelativeDir: string,
): number {
  const leftPriority = HISTORY_KIND_PRIORITY[left.historyKind];
  const rightPriority = HISTORY_KIND_PRIORITY[right.historyKind];
  if (leftPriority !== rightPriority) {
    return leftPriority > rightPriority ? -1 : 1;
  }
  if (left.modifiedAtMs !== right.modifiedAtMs) {
    return left.modifiedAtMs > right.modifiedAtMs ? -1 : 1;
  }
  const leftIsUtc = left.relativeDir === utcRelativeDir;
  const rightIsUtc = right.relativeDir === utcRelativeDir;
  if (leftIsUtc !== rightIsUtc) return leftIsUtc ? -1 : 1;
  if (left.relativeDir === right.relativeDir) return 0;
  return left.relativeDir < right.relativeDir ? -1 : 1;
}

function uniqueCandidates(candidates: readonly ManifestCandidate[]): readonly ManifestCandidate[] {
  return [...new Map(candidates.map((candidate) => [candidate.relativeDir, candidate])).values()];
}

function matchesSession(
  candidate: ManifestCandidate | undefined,
  session: SessionHistoryIdentity,
): candidate is ManifestCandidate {
  return (
    candidate?.sessionId === session.sessionId && candidate.createdAtMs === session.createdAtMs
  );
}

function manifestKey(identity: Pick<SessionHistoryIdentity, 'sessionId' | 'createdAtMs'>): string {
  return `${identity.sessionId}\u0000${String(identity.createdAtMs)}`;
}

function isManifestIdentity(value: unknown): value is { sessionId: string; createdAtMs: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'sessionId') === 'string' &&
    typeof Reflect.get(value, 'createdAtMs') === 'number' &&
    Number.isSafeInteger(Reflect.get(value, 'createdAtMs'))
  );
}

async function regularFileModifiedAtMs(path: string): Promise<number | undefined> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() ? info.mtimeMs : undefined;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function latestModifiedAtMs(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? Math.max(...present) : undefined;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await mapper(value);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => worker()),
  );
  return results;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code;
}
