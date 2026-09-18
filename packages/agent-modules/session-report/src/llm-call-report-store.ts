import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type {
  ReportLocations,
  SessionLlmCallEnvelope,
  SessionLlmCallReportCapability,
} from './contracts.js';

const CURRENT_FILE_NAME = 'llm-call.json';
const REPORT_TEMP_PREFIX = '.llm-call-report-';
const MAX_ENVELOPE_BYTES = 4 * 1_024 * 1_024;
const MAX_FINGERPRINTS = 256;
const SNAPSHOT_FILE = /^g(\d{12})--([A-Za-z0-9][A-Za-z0-9._-]*)\.jsonl$/u;
const SNAPSHOT_ENVELOPE_FILE = /^env-(g\d{12}--[A-Za-z0-9][A-Za-z0-9._-]*)\.json$/u;

export interface SessionLlmCallReportStoreOptions {
  readonly locations: ReportLocations;
  readonly maxEnvelopeBytes?: number;
  readonly maxFingerprints?: number;
}

interface ReportPaths {
  readonly currentFile: string;
  readonly snapshotsDir: string;
}

/**
 * Session-owned report projection for the non-message portion of an Agent LLM
 * call. The current envelope lives at the Session root; compaction freezes it
 * beside the canonical snapshot it describes.
 */
export class SessionLlmCallReportStore implements SessionLlmCallReportCapability {
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly fingerprints = new Map<string, string>();

  constructor(private readonly options: SessionLlmCallReportStoreOptions) {}

  writeCurrent(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly envelope: SessionLlmCallEnvelope;
  }): Promise<void> {
    return this.inLane(input.sessionId, async () => {
      const content = serializeCanonicalJson(input.envelope);
      this.assertEnvelopeSize(content);
      const fingerprint = sha256(content);
      if (this.fingerprints.get(input.sessionId) === fingerprint) return;
      const paths = await this.paths(input.sessionId);
      await replaceFileAtomic(paths.currentFile, content);
      this.rememberFingerprint(input.sessionId, fingerprint);
    });
  }

  freezeCompletedCompaction(input: {
    readonly sessionId: string;
    readonly compactionId: string;
  }): Promise<void> {
    return this.inLane(input.sessionId, async () => {
      const paths = await this.paths(input.sessionId);
      const snapshot = await findSnapshot(paths.snapshotsDir, input.compactionId);
      if (!snapshot) return;
      const frozenPath = join(paths.snapshotsDir, envelopeFileForSnapshot(snapshot.fileName));
      const content = await readOptionalFile(paths.currentFile);
      if (content === undefined) return;
      this.assertEnvelopeSize(content);
      const existing = await readOptionalFile(frozenPath);
      if (existing !== undefined && existing !== content) return;
      if (existing === undefined) await replaceFileAtomic(frozenPath, content);
      await rm(paths.currentFile, { force: true });
      this.fingerprints.delete(input.sessionId);
    });
  }

  pruneAfterRewind(input: { readonly sessionId: string }): Promise<void> {
    return this.inLane(input.sessionId, async () => {
      // A committed Rewind invalidates the last call's evidence, not Runtime
      // configuration. The next prepared call rebuilds it from live inputs.
      this.fingerprints.delete(input.sessionId);
      const paths = await this.paths(input.sessionId);
      await rm(paths.currentFile, { force: true });
      const entries = await readDirectory(paths.snapshotsDir);
      const snapshots = new Set(
        entries
          .filter(
            (entry) => entry.isFile() && !entry.isSymbolicLink() && SNAPSHOT_FILE.test(entry.name),
          )
          .map((entry) => entry.name),
      );
      await Promise.all(
        entries.flatMap((entry) => {
          if (!entry.isFile() || entry.isSymbolicLink()) return [];
          const match = SNAPSHOT_ENVELOPE_FILE.exec(entry.name);
          if (!match || snapshots.has(`${match[1]}.jsonl`)) return [];
          return [rm(join(paths.snapshotsDir, entry.name), { force: true })];
        }),
      );
    });
  }

  copySnapshotCompanions(input: {
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly snapshotFiles: readonly string[];
  }): Promise<void> {
    return this.inLane(input.targetSessionId, async () => {
      const source = await this.paths(input.sourceSessionId);
      const target = await this.paths(input.targetSessionId);
      await mkdir(target.snapshotsDir, { recursive: true, mode: 0o700 });
      for (const snapshotFile of input.snapshotFiles) {
        if (!SNAPSHOT_FILE.test(snapshotFile)) continue;
        const envelopeFile = envelopeFileForSnapshot(snapshotFile);
        const content = await readOptionalFile(join(source.snapshotsDir, envelopeFile));
        if (content === undefined) continue;
        this.assertEnvelopeSize(content);
        await replaceFileAtomic(join(target.snapshotsDir, envelopeFile), content);
      }
    });
  }

  private assertEnvelopeSize(content: string): void {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > (this.options.maxEnvelopeBytes ?? MAX_ENVELOPE_BYTES)) {
      throw new Error(`session_llm_call_envelope_too_large:${bytes}`);
    }
  }

  private async paths(sessionId: string): Promise<ReportPaths> {
    const located = await this.options.locations.inspectSession(sessionId);
    if (!located) throw new Error(`session_llm_call_session_missing:${sessionId}`);
    return {
      currentFile: join(located.paths.sessionDir, CURRENT_FILE_NAME),
      snapshotsDir: located.paths.snapshots,
    };
  }

  private rememberFingerprint(sessionId: string, fingerprint: string): void {
    this.fingerprints.delete(sessionId);
    this.fingerprints.set(sessionId, fingerprint);
    const maximum = Math.max(1, this.options.maxFingerprints ?? MAX_FINGERPRINTS);
    while (this.fingerprints.size > maximum) {
      const oldest = this.fingerprints.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.fingerprints.delete(oldest);
    }
  }

  private async inLane(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.lanes.get(sessionId);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.lanes.set(sessionId, gate);
    if (previous) await previous;
    try {
      await operation();
    } finally {
      release();
      if (this.lanes.get(sessionId) === gate) this.lanes.delete(sessionId);
    }
  }
}

async function replaceFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `${REPORT_TEMP_PREFIX}${basename(path)}-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function findSnapshot(
  snapshotsDir: string,
  compactionId: string,
): Promise<{ readonly fileName: string } | undefined> {
  const safeId = safeCompactionId(compactionId);
  const matches = (await readDirectory(snapshotsDir)).filter((entry) => {
    const match = entry.isFile() && !entry.isSymbolicLink() ? SNAPSHOT_FILE.exec(entry.name) : null;
    return match?.[2] === safeId;
  });
  if (matches.length > 1) throw new Error(`session_llm_call_snapshot_ambiguous:${compactionId}`);
  return matches[0] ? { fileName: matches[0].name } : undefined;
}

function envelopeFileForSnapshot(snapshotFile: string): string {
  return `env-${snapshotFile.slice(0, -'.jsonl'.length)}.json`;
}

function safeCompactionId(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]/gu, '-');
  if (!sanitized) throw new TypeError('Compaction id is required.');
  return (/^[A-Za-z0-9]/u.test(sanitized) ? sanitized : `c${sanitized}`).slice(0, 120);
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function readDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return [];
    throw error;
  }
}

function serializeCanonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value, new Set()))}\n`;
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value !== 'object') return canonicalizeScalar(value);
  if (ancestors.has(value)) throw new TypeError('session_llm_call_envelope_cycle');
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? value.map((entry) => canonicalize(entry, ancestors))
      : canonicalizeRecord(value as Record<string, unknown>, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function canonicalizeScalar(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  return undefined;
}

function canonicalizeRecord(
  record: Record<string, unknown>,
  ancestors: Set<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const normalized = canonicalize(record[key], ancestors);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code;
}
