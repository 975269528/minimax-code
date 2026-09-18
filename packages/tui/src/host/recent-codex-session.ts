import { lstat, open, readdir, realpath } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_RECENT_WINDOW_MS = 10 * 60 * 1000;
const MAX_CANDIDATES = 256;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_COMPRESSED_HEADER_BYTES = 256 * 1024;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface RecentCodexSession {
  readonly sessionId: string;
  readonly updatedAtMs: number;
  readonly source: 'cli' | 'vscode';
}

export type FindRecentCodexSession = (options: {
  readonly workspaceDir: string;
  readonly homeDir?: string;
  readonly codexHome?: string;
  readonly nowMs?: number;
  readonly recentWindowMs?: number;
}) => Promise<RecentCodexSession | undefined>;

interface RolloutCandidate {
  readonly filePath: string;
  readonly updatedAtMs: number;
}

export const findRecentCodexSession: FindRecentCodexSession = async (options) => {
  const nowMs = options.nowMs ?? Date.now();
  const recentWindowMs = options.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS;
  const oldestAllowedMs = nowMs - recentWindowMs;
  const codexHome = path.resolve(
    options.codexHome ??
      process.env.CODEX_HOME ??
      path.join(options.homeDir ?? homedir(), '.codex'),
  );
  const sessionsRoot = path.join(codexHome, 'sessions');
  let canonicalWorkspace: string;
  let canonicalSessionsRoot: string;
  try {
    [canonicalWorkspace, canonicalSessionsRoot] = await Promise.all([
      realpath(options.workspaceDir),
      realpath(sessionsRoot),
    ]);
  } catch {
    return undefined;
  }

  const candidates = await collectCandidates(canonicalSessionsRoot, oldestAllowedMs, nowMs);
  if (!candidates) return undefined;
  for (const candidate of candidates) {
    const metadata = await readCodexSessionMetadata(candidate.filePath);
    if (!metadata || (metadata.source !== 'cli' && metadata.source !== 'vscode')) continue;
    const candidateWorkspace = await canonicalizeExistingDirectory(metadata.cwd);
    if (candidateWorkspace !== canonicalWorkspace) continue;
    return {
      sessionId: metadata.sessionId,
      updatedAtMs: candidate.updatedAtMs,
      source: metadata.source,
    };
  }
  return undefined;
};

async function collectCandidates(
  sessionsRoot: string,
  oldestAllowedMs: number,
  nowMs: number,
): Promise<RolloutCandidate[] | undefined> {
  const dayDirectories = dateDirectoriesForWindow(oldestAllowedMs, nowMs);
  const candidates: RolloutCandidate[] = [];
  for (const segments of dayDirectories) {
    const directory = path.join(sessionsRoot, ...segments);
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^rollout-.+\.jsonl(?:\.zst)?$/u.test(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      try {
        const fileStat = await lstat(filePath);
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) continue;
        if (fileStat.mtimeMs < oldestAllowedMs || fileStat.mtimeMs > nowMs + MAX_FUTURE_SKEW_MS) {
          continue;
        }
        const canonicalFile = await realpath(filePath);
        if (!isPathInside(sessionsRoot, canonicalFile)) continue;
        candidates.push({
          filePath: canonicalFile,
          updatedAtMs: Math.min(fileStat.mtimeMs, nowMs),
        });
        if (candidates.length > MAX_CANDIDATES) return undefined;
      } catch {
        continue;
      }
    }
  }
  return candidates.sort(
    (left, right) =>
      right.updatedAtMs - left.updatedAtMs || left.filePath.localeCompare(right.filePath),
  );
}

function dateDirectoriesForWindow(oldestAllowedMs: number, nowMs: number): string[][] {
  const result = new Map<string, string[]>();
  for (const timestamp of [oldestAllowedMs, nowMs]) {
    const date = new Date(timestamp);
    const variants: [number, number, number][] = [
      [date.getFullYear(), date.getMonth() + 1, date.getDate()],
      [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()],
    ];
    for (const [year, month, day] of variants) {
      const segments = [String(year), padDatePart(month), padDatePart(day)];
      result.set(segments.join('/'), segments);
    }
  }
  return [...result.values()];
}

async function readCodexSessionMetadata(filePath: string): Promise<
  | {
      sessionId: string;
      cwd: string;
      source: string;
    }
  | undefined
> {
  let header: string;
  try {
    header = await readBoundedHeader(filePath);
  } catch {
    return undefined;
  }
  for (const line of header.split('\n').slice(0, 20)) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record) || record.type !== 'session_meta' || !isRecord(record.payload)) continue;
    const { id, cwd, source } = record.payload;
    if (typeof id !== 'string' || !id.trim() || typeof cwd !== 'string') return undefined;
    if (typeof source !== 'string') return undefined;
    if (!path.basename(filePath).includes(id)) return undefined;
    return { sessionId: id, cwd, source };
  }
  return undefined;
}

async function readBoundedHeader(filePath: string): Promise<string> {
  const compressed = filePath.endsWith('.zst');
  const byteLimit = compressed ? MAX_COMPRESSED_HEADER_BYTES : MAX_HEADER_BYTES;
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(byteLimit);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead);
    if (!compressed) return content.toString('utf8');
    const dynamicRequire = createRequire(import.meta.url);
    const zlib = dynamicRequire('node:zlib') as {
      zstdDecompressSync?: (input: Uint8Array, options: { maxOutputLength: number }) => Buffer;
    };
    if (!zlib.zstdDecompressSync) throw new Error('Zstandard is unavailable.');
    return zlib.zstdDecompressSync(content, { maxOutputLength: MAX_HEADER_BYTES }).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function canonicalizeExistingDirectory(directory: string): Promise<string | undefined> {
  try {
    return await realpath(directory);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function padDatePart(value: number): string {
  return String(value).padStart(2, '0');
}
