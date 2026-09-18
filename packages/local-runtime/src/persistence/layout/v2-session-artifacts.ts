import { Buffer } from 'node:buffer';
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  formatV2TimestampParts,
  resolveV2DirectoryContract,
  type DataDirInput,
} from './v2-paths.js';

export const V2_SESSION_ARTIFACT_MANIFEST_SCHEMA_VERSION = 1;
export const V2_DISPLAY_TRANSCRIPT_SCHEMA_VERSION = 1;

export type V2SessionArtifactLayout = 'final-dated' | 'legacy-draft';

export interface V2SessionArtifactPaths {
  layout: V2SessionArtifactLayout;
  sessionId: string;
  sessionDir: string;
  manifest?: string;
  ledger: string;
  display: string;
  snapshot: string;
  reports: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  legacyDraftPaths?: V2LegacyDraftSessionArtifactPaths;
}

export interface V2LegacyDraftSessionArtifactPaths {
  ledger?: string;
  snapshot?: string;
}

export interface V2SessionArtifactManifest {
  schemaVersion: typeof V2_SESSION_ARTIFACT_MANIFEST_SCHEMA_VERSION;
  sessionId: string;
  createdAtMs: number;
  updatedAtMs: number;
  source: 'local-runtime' | 'legacy-migration' | 'dev-draft-migration' | 'unknown';
  layout: 'v2-final-dated-session';
  paths: {
    sessionDir: string;
    ledger: string;
    display: string;
    snapshot: string;
    reports: string;
  };
  legacyDraftPaths?: V2LegacyDraftSessionArtifactPaths;
  warnings?: string[];
}

export interface V2SessionArtifactDiagnosticSummary {
  schemaVersion: 1;
  contract: {
    sessionsRoot: string;
    sqliteRoot: string;
    runtimeStateDb: string;
    legacyDraftChats: string;
    finalSessionLayout: string;
    files: string[];
  };
  scannedSessionCount: number;
  sessions: V2SessionArtifactDiagnostic[];
  warnings: string[];
}

export interface V2SessionArtifactDiagnostic {
  sessionId: string;
  layout: V2SessionArtifactLayout | 'missing';
  sessionDir?: string;
  manifest?: unknown;
  files: {
    manifest?: V2FileDiagnostic;
    ledger: V2FileDiagnostic;
    display: V2FileDiagnostic;
    snapshot: V2FileDiagnostic;
  };
  legacyDraftPaths?: V2LegacyDraftSessionArtifactPaths;
  warnings: string[];
}

export interface V2FileDiagnostic {
  path: string;
  exists: boolean;
  sizeBytes?: number;
  mtimeMs?: number;
}

interface ResolveOptions {
  nowMs?: () => number;
  createdAtMs?: number;
  preferFinal?: boolean;
}

interface EnsureOptions extends ResolveOptions {
  updatedAtMs?: number;
  source?: V2SessionArtifactManifest['source'];
  legacyDraftPaths?: V2LegacyDraftSessionArtifactPaths;
  warnings?: string[];
}

interface DisplayTranscriptRecord {
  schemaVersion: typeof V2_DISPLAY_TRANSCRIPT_SCHEMA_VERSION;
  kind: 'message.display_upserted';
  sessionId: string;
  seq: number;
  eventId: string;
  createdAtMs: number;
  turnId?: string;
  msgId?: string;
  role?: string;
  message: unknown;
}

const artifactCache = new Map<string, V2SessionArtifactPaths>();

export function resolveV2SessionArtifactPathsSync(
  dataDir: DataDirInput,
  sessionId: string,
  options: ResolveOptions = {},
): V2SessionArtifactPaths {
  const key = cacheKey(dataDir, sessionId);
  const cached = artifactCache.get(key);
  if (cached && artifactPathsStillExist(cached)) return cached;

  const final = readExistingFinalSessionArtifactPaths(dataDir, sessionId);
  if (final) {
    artifactCache.set(key, final);
    return final;
  }

  const legacy = resolveLegacyDraftSessionArtifactPaths(dataDir, sessionId);
  if (!options.preferFinal && legacyArtifactExists(legacy)) {
    artifactCache.set(key, legacy);
    return legacy;
  }

  return buildFinalSessionArtifactPaths(
    dataDir,
    sessionId,
    options.createdAtMs ?? options.nowMs?.() ?? Date.now(),
  );
}

export function ensureV2SessionArtifactManifestSync(
  dataDir: DataDirInput,
  sessionId: string,
  options: EnsureOptions = {},
): V2SessionArtifactPaths {
  const existing = resolveV2SessionArtifactPathsSync(dataDir, sessionId, options);
  if (existing.layout === 'legacy-draft') return existing;

  const updatedAtMs = options.updatedAtMs ?? options.nowMs?.() ?? Date.now();
  const manifestPath = existing.manifest!;
  const previous = readManifest(manifestPath);
  const contract = resolveV2DirectoryContract(dataDir);
  const legacyDraftPaths = sanitizeLegacyDraftPaths(
    options.legacyDraftPaths ?? previous?.legacyDraftPaths,
    contract,
  );
  const manifest: V2SessionArtifactManifest = {
    schemaVersion: V2_SESSION_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    sessionId,
    createdAtMs: previous?.createdAtMs ?? existing.createdAtMs ?? updatedAtMs,
    updatedAtMs: Math.max(previous?.updatedAtMs ?? 0, updatedAtMs),
    source: previous?.source ?? options.source ?? 'local-runtime',
    layout: 'v2-final-dated-session',
    paths: {
      sessionDir: existing.sessionDir,
      ledger: existing.ledger,
      display: existing.display,
      snapshot: existing.snapshot,
      reports: existing.reports,
    },
    ...(legacyDraftPaths ? { legacyDraftPaths } : {}),
    ...(options.warnings?.length || previous?.warnings?.length
      ? { warnings: mergeWarnings(previous?.warnings, options.warnings) }
      : {}),
  };
  ensureV2ArtifactDirectorySync(existing.reports, existing.sessionDir, contract.root);
  ensureV2ArtifactParentDirSync(manifestPath, existing.sessionDir, contract.root);
  if (previous) {
    // Updating an existing manifest — best-effort: the old manifest on disk
    // is still valid and discoverable, only updatedAtMs will be stale.
    try {
      writeJsonAtomicSync(manifestPath, manifest);
    } catch {
      // Swallow: transient EPERM/EACCES must not abort the ledger transaction.
    }
  } else {
    // First-ever manifest for this session directory — must succeed, otherwise
    // the session directory becomes undiscoverable after process restart
    // (findFinalManifestPath scans manifest.json to locate sessions).
    writeJsonAtomicSync(manifestPath, manifest);
  }
  artifactCache.set(cacheKey(dataDir, sessionId), {
    ...existing,
    createdAtMs: manifest.createdAtMs,
    updatedAtMs: manifest.updatedAtMs,
  });
  return {
    ...existing,
    createdAtMs: manifest.createdAtMs,
    updatedAtMs: manifest.updatedAtMs,
  };
}

export function appendV2SessionDisplayTranscriptSync(
  paths: V2SessionArtifactPaths,
  events: readonly {
    sessionId: string;
    seq: number;
    eventId: string;
    createdAtMs: number;
    turnId?: string;
    message?: unknown;
  }[],
  options: { managedRoot?: string } = {},
): void {
  const records = events.flatMap((event): DisplayTranscriptRecord[] => {
    if (!event.message || event.sessionId !== paths.sessionId) return [];
    const message = event.message as { msg_id?: unknown; role?: unknown };
    return [
      {
        schemaVersion: V2_DISPLAY_TRANSCRIPT_SCHEMA_VERSION,
        kind: 'message.display_upserted',
        sessionId: event.sessionId,
        seq: event.seq,
        eventId: event.eventId,
        createdAtMs: event.createdAtMs,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(typeof message.msg_id === 'string' ? { msgId: message.msg_id } : {}),
        ...(typeof message.role === 'string' ? { role: message.role } : {}),
        message: event.message,
      },
    ];
  });
  if (records.length === 0) return;
  ensureV2ArtifactParentDirSync(paths.display, paths.sessionDir, options.managedRoot);
  const boundary = needsJsonlLineBoundarySync(paths.display) ? '\n' : '';
  appendFileSync(
    paths.display,
    `${boundary}${records.map((row) => JSON.stringify(row)).join('\n')}\n`,
    {
      encoding: 'utf-8',
    },
  );
}

export function deleteV2SessionArtifactsSync(dataDir: DataDirInput, sessionId: string): void {
  const paths = resolveV2SessionArtifactPathsSync(dataDir, sessionId);
  const contract = resolveV2DirectoryContract(dataDir);
  artifactCache.delete(cacheKey(dataDir, sessionId));
  if (paths.layout === 'final-dated') {
    assertV2ArtifactDeleteTargetSync(paths.sessionDir, paths.sessionDir, contract.root);
    rmSync(paths.sessionDir, { recursive: true, force: true });
    return;
  }
  if (path.dirname(paths.ledger) === contract.legacyDraftLedgers) {
    assertV2ArtifactDeleteTargetSync(paths.ledger, contract.legacyDraftLedgers, contract.root);
    assertV2ArtifactDeleteTargetSync(paths.display, contract.legacyDraftLedgers, contract.root);
    assertV2ArtifactDeleteTargetSync(paths.reports, contract.legacyDraftLedgers, contract.root);
    rmSync(paths.ledger, { force: true });
    rmSync(paths.display, { force: true });
    rmSync(paths.reports, { recursive: true, force: true });
  } else {
    const ledgerDir = path.dirname(paths.ledger);
    assertV2ArtifactDeleteTargetSync(ledgerDir, ledgerDir, contract.root);
    rmSync(ledgerDir, { recursive: true, force: true });
  }
  if (paths.legacyDraftPaths?.snapshot) {
    const snapshotDir = path.dirname(paths.legacyDraftPaths.snapshot);
    assertV2ArtifactDeleteTargetSync(snapshotDir, snapshotDir, contract.root);
    rmSync(snapshotDir, { recursive: true, force: true });
  }
}

export function deleteV2SessionSnapshotSync(dataDir: DataDirInput, sessionId: string): void {
  const paths = resolveV2SessionArtifactPathsSync(dataDir, sessionId);
  const contract = resolveV2DirectoryContract(dataDir);
  const snapshotSessionDir =
    paths.layout === 'legacy-draft' ? path.dirname(paths.snapshot) : paths.sessionDir;
  assertV2ArtifactDeleteTargetSync(paths.snapshot, snapshotSessionDir, contract.root);
  rmSync(paths.snapshot, { force: true });
}

function assertV2ArtifactDeleteTargetSync(
  targetPath: string,
  sessionDir: string,
  managedRoot = sessionDir,
): void {
  const resolvedSessionDir = path.resolve(sessionDir);
  const resolvedManagedRoot = path.resolve(managedRoot);
  const resolvedTargetPath = path.resolve(targetPath);
  if (!isPathInside(resolvedSessionDir, resolvedManagedRoot)) {
    throw new Error(
      `Unsafe v2 session artifact delete directory outside managed root: ${sessionDir}`,
    );
  }
  if (!isPathInside(resolvedTargetPath, resolvedSessionDir)) {
    throw new Error(
      `Unsafe v2 session artifact delete path outside session directory: ${targetPath}`,
    );
  }
  assertExistingV2ArtifactPathWithoutSymlinkSync(resolvedManagedRoot, resolvedTargetPath);
}

export function ensureV2ArtifactParentDirSync(
  filePath: string,
  sessionDir: string,
  managedRoot = sessionDir,
): void {
  const resolvedSessionDir = path.resolve(sessionDir);
  const resolvedFilePath = path.resolve(filePath);
  if (!isPathInside(resolvedFilePath, resolvedSessionDir)) {
    throw new Error(`Unsafe v2 session artifact path outside session directory: ${filePath}`);
  }
  ensureV2ArtifactDirectorySync(path.dirname(resolvedFilePath), resolvedSessionDir, managedRoot);
  assertV2ArtifactWriteTargetSync(resolvedFilePath, resolvedSessionDir);
}

export function ensureV2ArtifactDirectorySync(
  dirPath: string,
  sessionDir: string,
  managedRoot = sessionDir,
): void {
  const resolvedSessionDir = path.resolve(sessionDir);
  const resolvedManagedRoot = path.resolve(managedRoot);
  const resolvedDirPath = path.resolve(dirPath);
  if (!isPathInside(resolvedSessionDir, resolvedManagedRoot)) {
    throw new Error(`Unsafe v2 session artifact directory outside managed root: ${sessionDir}`);
  }
  if (!isPathInside(resolvedDirPath, resolvedSessionDir)) {
    throw new Error(`Unsafe v2 session artifact directory outside session directory: ${dirPath}`);
  }
  mkdirSync(resolvedManagedRoot, { recursive: true });
  ensureDirectoryEntryNotSymlinkSync(resolvedManagedRoot);

  let current = resolvedManagedRoot;
  for (const segment of path
    .relative(resolvedManagedRoot, resolvedDirPath)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    ensureDirectoryEntryNotSymlinkSync(current);
  }
}

export function assertV2ArtifactWriteTargetSync(filePath: string, sessionDir: string): void {
  const resolvedSessionDir = path.resolve(sessionDir);
  const resolvedFilePath = path.resolve(filePath);
  if (!isPathInside(resolvedFilePath, resolvedSessionDir)) {
    throw new Error(`Unsafe v2 session artifact path outside session directory: ${filePath}`);
  }
  try {
    const info = lstatSync(resolvedFilePath);
    if (info.isSymbolicLink()) {
      throw new Error(`Unsafe v2 session artifact symlink target: ${filePath}`);
    }
    if (info.isDirectory()) {
      throw new Error(`Unsafe v2 session artifact directory target: ${filePath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

export function collectV2SessionArtifactDiagnostics(
  dataDir: DataDirInput,
  options: { sessionIds?: string[]; maxSessions?: number } = {},
): V2SessionArtifactDiagnosticSummary {
  const contract = resolveV2DirectoryContract(dataDir);
  const warnings: string[] = [];
  const discovered = options.sessionIds ?? discoverV2SessionArtifactIds(dataDir, warnings);
  const uniqueIds = [...new Set(discovered)].slice(0, options.maxSessions ?? 200);
  return {
    schemaVersion: 1,
    contract: {
      sessionsRoot: contract.sessions,
      sqliteRoot: contract.sqlite,
      runtimeStateDb: contract.runtimeStateDb,
      legacyDraftChats: contract.legacyDraftChats,
      finalSessionLayout: 'v2/sessions/YYYY/MM/DD/HH-mm-ss-SSS-session_<base64url-session-id>/',
      files: ['manifest.json', 'ledger.jsonl', 'display.jsonl', 'snapshot.json', 'reports/'],
    },
    scannedSessionCount: uniqueIds.length,
    sessions: uniqueIds.map((sessionId) => inspectV2SessionArtifacts(dataDir, sessionId)),
    warnings,
  };
}

export function inspectV2SessionArtifacts(
  dataDir: DataDirInput,
  sessionId: string,
): V2SessionArtifactDiagnostic {
  const warnings: string[] = [];
  const paths = resolveV2SessionArtifactPathsSync(dataDir, sessionId);
  const manifest = paths.manifest ? readManifest(paths.manifest) : undefined;
  const files = {
    ...(paths.manifest ? { manifest: fileDiagnostic(paths.manifest) } : {}),
    ledger: fileDiagnostic(paths.ledger),
    display: fileDiagnostic(paths.display),
    snapshot: fileDiagnostic(paths.snapshot),
  };
  if (paths.layout === 'final-dated' && !manifest) warnings.push('session_manifest_missing');
  if (!files.ledger.exists) warnings.push('session_ledger_missing');
  return {
    sessionId,
    layout:
      paths.layout === 'final-dated' || legacyArtifactExists(paths) ? paths.layout : 'missing',
    sessionDir: paths.sessionDir,
    ...(manifest ? { manifest } : {}),
    files,
    ...(paths.legacyDraftPaths ? { legacyDraftPaths: paths.legacyDraftPaths } : {}),
    warnings,
  };
}

function readExistingFinalSessionArtifactPaths(
  dataDir: DataDirInput,
  sessionId: string,
): V2SessionArtifactPaths | undefined {
  const manifestPath = findFinalManifestPath(dataDir, sessionId);
  if (!manifestPath) return undefined;
  const manifest = readManifest(manifestPath);
  const sessionDir = path.dirname(manifestPath);
  const contract = resolveV2DirectoryContract(dataDir);
  const legacyDraftPaths = sanitizeLegacyDraftPaths(manifest?.legacyDraftPaths, contract);
  return {
    layout: 'final-dated',
    sessionId,
    sessionDir,
    manifest: manifestPath,
    ledger: resolveTrustedArtifactPath(
      manifest?.paths.ledger,
      sessionDir,
      contract.sessions,
      'ledger.jsonl',
    ),
    display: resolveTrustedArtifactPath(
      manifest?.paths.display,
      sessionDir,
      contract.sessions,
      'display.jsonl',
    ),
    snapshot: resolveTrustedArtifactPath(
      manifest?.paths.snapshot,
      sessionDir,
      contract.sessions,
      'snapshot.json',
    ),
    reports: resolveTrustedArtifactPath(
      manifest?.paths.reports,
      sessionDir,
      contract.sessions,
      'reports',
    ),
    ...(manifest?.createdAtMs ? { createdAtMs: manifest.createdAtMs } : {}),
    ...(manifest?.updatedAtMs ? { updatedAtMs: manifest.updatedAtMs } : {}),
    ...(legacyDraftPaths ? { legacyDraftPaths } : {}),
  };
}

function resolveTrustedArtifactPath(
  manifestPath: unknown,
  sessionDir: string,
  trustedRoot: string,
  fallbackName: string,
): string {
  const fallback = path.join(sessionDir, fallbackName);
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) return fallback;
  const candidate = path.resolve(sessionDir, manifestPath);
  return isPathInside(candidate, sessionDir) && isPathInside(candidate, trustedRoot)
    ? candidate
    : fallback;
}

function sanitizeLegacyDraftPaths(
  legacyDraftPaths: unknown,
  contract: ReturnType<typeof resolveV2DirectoryContract>,
): V2LegacyDraftSessionArtifactPaths | undefined {
  if (
    !legacyDraftPaths ||
    typeof legacyDraftPaths !== 'object' ||
    Array.isArray(legacyDraftPaths)
  ) {
    return undefined;
  }
  const draftPaths = legacyDraftPaths as Partial<V2LegacyDraftSessionArtifactPaths>;
  const sanitized: V2LegacyDraftSessionArtifactPaths = {};
  if (typeof draftPaths.ledger === 'string' && draftPaths.ledger.length > 0) {
    const ledger = path.resolve(draftPaths.ledger);
    if (isPathInside(ledger, contract.legacyDraftLedgers)) sanitized.ledger = ledger;
  }
  if (typeof draftPaths.snapshot === 'string' && draftPaths.snapshot.length > 0) {
    const snapshot = path.resolve(draftPaths.snapshot);
    if (isPathInside(snapshot, contract.legacyDraftSnapshots)) sanitized.snapshot = snapshot;
  }
  return sanitized.ledger || sanitized.snapshot ? sanitized : undefined;
}

function ensureDirectoryEntryNotSymlinkSync(dirPath: string): void {
  try {
    const info = lstatSync(dirPath);
    if (info.isSymbolicLink()) {
      throw new Error(`Unsafe v2 session artifact directory symlink: ${dirPath}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`Unsafe v2 session artifact directory target: ${dirPath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    mkdirSync(dirPath);
  }
}

function assertExistingV2ArtifactPathWithoutSymlinkSync(
  managedRoot: string,
  targetPath: string,
): void {
  const resolvedManagedRoot = path.resolve(managedRoot);
  const resolvedTargetPath = path.resolve(targetPath);
  let current = resolvedManagedRoot;
  for (const segment of [
    '',
    ...path.relative(resolvedManagedRoot, resolvedTargetPath).split(path.sep).filter(Boolean),
  ]) {
    if (segment) current = path.join(current, segment);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) {
        throw new Error(`Unsafe v2 session artifact delete symlink: ${current}`);
      }
      if (current !== resolvedTargetPath && !info.isDirectory()) {
        throw new Error(`Unsafe v2 session artifact delete ancestor target: ${current}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function buildFinalSessionArtifactPaths(
  dataDir: DataDirInput,
  sessionId: string,
  createdAtMs: number,
): V2SessionArtifactPaths {
  const contract = resolveV2DirectoryContract(dataDir);
  const stamp = formatV2TimestampParts(createdAtMs);
  const sessionDir = path.join(
    contract.sessions,
    stamp.year,
    stamp.month,
    stamp.day,
    `${stamp.time}-${encodeSessionPathSegment(sessionId)}`,
  );
  return {
    layout: 'final-dated',
    sessionId,
    sessionDir,
    manifest: path.join(sessionDir, 'manifest.json'),
    ledger: path.join(sessionDir, 'ledger.jsonl'),
    display: path.join(sessionDir, 'display.jsonl'),
    snapshot: path.join(sessionDir, 'snapshot.json'),
    reports: path.join(sessionDir, 'reports'),
    createdAtMs,
  };
}

function resolveLegacyDraftSessionArtifactPaths(
  dataDir: DataDirInput,
  sessionId: string,
): V2SessionArtifactPaths {
  const contract = resolveV2DirectoryContract(dataDir);
  const segment = encodeSessionPathSegment(sessionId);
  const ledgerDir = path.join(contract.legacyDraftLedgers, segment);
  const flatLedgerPath = path.join(
    contract.legacyDraftLedgers,
    `${safeLegacyFlatFileName(sessionId)}.jsonl`,
  );
  const hasFlatLedger = existsSync(flatLedgerPath);
  const ledgerPath = hasFlatLedger ? flatLedgerPath : path.join(ledgerDir, 'ledger.jsonl');
  const displayPath = hasFlatLedger
    ? path.join(contract.legacyDraftLedgers, `${safeLegacyFlatFileName(sessionId)}.display.jsonl`)
    : path.join(ledgerDir, 'display.jsonl');
  const reportsPath = hasFlatLedger
    ? path.join(contract.legacyDraftLedgers, `${safeLegacyFlatFileName(sessionId)}.reports`)
    : path.join(ledgerDir, 'reports');
  const snapshotPath = path.join(contract.legacyDraftSnapshots, segment, 'latest.json');
  return {
    layout: 'legacy-draft',
    sessionId,
    sessionDir: hasFlatLedger ? contract.legacyDraftLedgers : ledgerDir,
    ledger: ledgerPath,
    display: displayPath,
    snapshot: snapshotPath,
    reports: reportsPath,
    legacyDraftPaths: {
      ledger: ledgerPath,
      snapshot: snapshotPath,
    },
  };
}

function legacyArtifactExists(paths: V2SessionArtifactPaths): boolean {
  return (
    paths.layout === 'legacy-draft' &&
    (existsSync(paths.ledger) || existsSync(paths.snapshot) || existsSync(paths.display))
  );
}

function artifactPathsStillExist(paths: V2SessionArtifactPaths): boolean {
  if (paths.layout === 'final-dated') return Boolean(paths.manifest && existsSync(paths.manifest));
  return legacyArtifactExists(paths);
}

function findFinalManifestPath(dataDir: DataDirInput, sessionId: string): string | undefined {
  const root = resolveV2DirectoryContract(dataDir).sessions;
  if (!existsSync(root)) return undefined;
  const matches: Array<{ path: string; createdAtMs: number }> = [];
  for (const manifestPath of listFinalManifestPaths(root)) {
    const manifest = readManifest(manifestPath);
    if (manifest?.sessionId !== sessionId) continue;
    matches.push({ path: manifestPath, createdAtMs: manifest.createdAtMs });
  }
  matches.sort(
    (left, right) => left.createdAtMs - right.createdAtMs || left.path.localeCompare(right.path),
  );
  return matches[0]?.path;
}

function listFinalManifestPaths(root: string): string[] {
  const manifests: string[] = [];
  for (const year of safeReadDirs(root)) {
    for (const month of safeReadDirs(path.join(root, year))) {
      for (const day of safeReadDirs(path.join(root, year, month))) {
        for (const sessionDir of safeReadDirs(path.join(root, year, month, day))) {
          const manifestPath = path.join(root, year, month, day, sessionDir, 'manifest.json');
          if (existsSync(manifestPath)) manifests.push(manifestPath);
        }
      }
    }
  }
  return manifests;
}

function discoverV2SessionArtifactIds(dataDir: DataDirInput, warnings: string[]): string[] {
  const contract = resolveV2DirectoryContract(dataDir);
  const ids: string[] = [];
  for (const manifestPath of listFinalManifestPaths(contract.sessions)) {
    const manifest = readManifest(manifestPath);
    if (manifest?.sessionId) ids.push(manifest.sessionId);
    else warnings.push(`unreadable_session_manifest:${manifestPath}`);
  }
  for (const segment of safeReadDirs(contract.legacyDraftLedgers)) {
    const decoded = decodeSessionPathSegment(segment);
    if (decoded) ids.push(decoded);
  }
  for (const file of safeReadFiles(contract.legacyDraftLedgers)) {
    if (!file.endsWith('.jsonl') || file.endsWith('.display.jsonl')) continue;
    ids.push(file.slice(0, -'.jsonl'.length));
  }
  return ids;
}

function readManifest(filePath: string): V2SessionArtifactManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const manifest = parsed as Partial<V2SessionArtifactManifest>;
    if (
      manifest.schemaVersion !== V2_SESSION_ARTIFACT_MANIFEST_SCHEMA_VERSION ||
      typeof manifest.sessionId !== 'string' ||
      typeof manifest.createdAtMs !== 'number' ||
      typeof manifest.updatedAtMs !== 'number' ||
      !manifest.paths ||
      typeof manifest.paths.ledger !== 'string'
    ) {
      return undefined;
    }
    return manifest as V2SessionArtifactManifest;
  } catch {
    return undefined;
  }
}

function writeJsonAtomicSync(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  try {
    renameSyncWithRetry(tmpPath, filePath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

/**
 * On Windows, `renameSync` can transiently fail with EPERM / EACCES when
 * another process (antivirus, search indexer, or a concurrent read within
 * the same Electron app) holds a handle on the target file.  Retry a few
 * times with a short back-off to ride out the lock.
 */
function renameSyncWithRetry(src: string, dest: string, maxRetries = 3): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(src, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EACCES') && attempt < maxRetries) {
        // Busy-wait; the lock is typically released within milliseconds.
        const deadline = Date.now() + 50 * (attempt + 1);
        while (Date.now() < deadline) {
          /* spin */
        }
        continue;
      }
      throw err;
    }
  }
}

function safeReadDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function safeReadFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function fileDiagnostic(filePath: string): V2FileDiagnostic {
  try {
    const info = statSync(filePath);
    return {
      path: filePath,
      exists: true,
      sizeBytes: info.size,
      mtimeMs: Math.floor(info.mtimeMs),
    };
  } catch {
    return { path: filePath, exists: false };
  }
}

function mergeWarnings(left?: string[], right?: string[]): string[] {
  return [...new Set([...(left ?? []), ...(right ?? [])])];
}

function cacheKey(dataDir: DataDirInput, sessionId: string): string {
  return `${resolveDataDir(dataDir)}\u0000${sessionId}`;
}

function resolveDataDir(dataDir: DataDirInput): string {
  return typeof dataDir === 'function' ? dataDir() : dataDir;
}

function encodeSessionPathSegment(sessionId: string): string {
  return `session_${Buffer.from(sessionId || 'unknown-session', 'utf-8')
    .toString('base64url')
    .slice(0, 180)}`;
}

function safeLegacyFlatFileName(sessionId: string): string {
  return (
    (sessionId || 'unknown-session')
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
      .replace(/^\.+/g, '')
      .slice(0, 180)
      .trim() || 'unknown-session'
  );
}

function decodeSessionPathSegment(segment: string): string | undefined {
  if (!segment.startsWith('session_')) return undefined;
  try {
    return Buffer.from(segment.slice('session_'.length), 'base64url').toString('utf-8');
  } catch {
    return undefined;
  }
}

function needsJsonlLineBoundarySync(filePath: string): boolean {
  let handle: number | undefined;
  try {
    handle = openSync(filePath, 'r');
    const fileStat = statSync(filePath);
    if (fileStat.size === 0) return false;
    const lastByte = Buffer.alloc(1);
    readSync(handle, lastByte, 0, 1, fileStat.size - 1);
    return lastByte[0] !== 0x0a;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}
