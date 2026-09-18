import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentMessage } from '@mavis/agent-core/protocol/agent-message';

import type { MetricsClient } from '../../common/metrics.js';
import type { DataDirInput } from '../../persistence/db.js';
import { resolveV2DirectoryContract } from '../../persistence/layout/v2-paths.js';
import type { LocalSessionRecord } from '../controller.js';
import {
  deleteV2SessionSnapshotSync,
  ensureV2ArtifactParentDirSync,
  ensureV2SessionArtifactManifestSync,
  resolveV2SessionArtifactPathsSync,
} from '../../persistence/layout/v2-session-artifacts.js';
import {
  replayLocalSessionLedger,
  type LocalFileApiUploadProjectionEntry,
  type LocalSessionProjectionReplayBase,
  type ReplayedLocalSessionProjection,
} from '../projection/index.js';
import type {
  LocalSessionLedgerEvent,
  LocalSessionLedgerStore,
  LocalSessionLedgerWatermark,
} from '../ledger/index.js';

export const LOCAL_SESSION_SNAPSHOT_SCHEMA_VERSION = 1;

export interface LocalSessionSnapshot {
  schemaVersion: typeof LOCAL_SESSION_SNAPSHOT_SCHEMA_VERSION;
  snapshotId: string;
  sessionId: string;
  createdAtMs: number;
  watermark: LocalSessionLedgerWatermark;
  record?: LocalSessionRecord;
  displayMessages: AgentMessage[];
  piHistory: PiAgentMessage[];
  fileApiUploads?: Record<string, LocalFileApiUploadProjectionEntry>;
  piHistoryFacts: boolean;
  deleted: boolean;
}

export interface LocalSessionSnapshotReadResult {
  projection: ReplayedLocalSessionProjection;
  source: 'snapshot-tail' | 'full-ledger' | 'empty';
  snapshot?: LocalSessionSnapshot;
  replayedEventCount: number;
  piHistoryFacts: boolean;
}

export interface LocalSessionSnapshotStore {
  getLatest(sessionId: string): Promise<LocalSessionSnapshot | undefined>;
  writeLatest(snapshot: LocalSessionSnapshot): Promise<void>;
  writeSnapshotFromLedger(
    sessionId: string,
    ledgerStore: LocalSessionLedgerStore,
    targetWatermark?: LocalSessionLedgerWatermark,
  ): Promise<LocalSessionSnapshot | undefined>;
  readResumeProjection(
    sessionId: string,
    ledgerStore: LocalSessionLedgerStore,
  ): Promise<LocalSessionSnapshotReadResult>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface FileSessionSnapshotStoreOptions {
  nowMs?: () => number;
  makeSnapshotId?: (sessionId: string, watermark: LocalSessionLedgerWatermark) => string;
  metricsClient?: MetricsClient;
}

const RESUME_SOURCE_LABELS: Record<LocalSessionSnapshotReadResult['source'], string> = {
  'snapshot-tail': 'snapshot_tail',
  'full-ledger': 'full_ledger',
  empty: 'empty',
};

export class FileSessionSnapshotStore implements LocalSessionSnapshotStore {
  private readonly nowMs: () => number;
  private readonly metricsClient?: MetricsClient;
  private readonly makeSnapshotId: (
    sessionId: string,
    watermark: LocalSessionLedgerWatermark,
  ) => string;

  constructor(
    private readonly dataDir: DataDirInput,
    options: FileSessionSnapshotStoreOptions = {},
  ) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.makeSnapshotId = options.makeSnapshotId ?? defaultSnapshotId;
    this.metricsClient = options.metricsClient;
  }

  async getLatest(sessionId: string): Promise<LocalSessionSnapshot | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(resolveLocalSessionSnapshotPath(this.dataDir, sessionId), 'utf-8'),
      ) as unknown;
      return isLocalSessionSnapshot(parsed, sessionId) ? parsed : undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return undefined;
    }
  }

  async writeLatest(snapshot: LocalSessionSnapshot): Promise<void> {
    const artifactPaths = ensureV2SessionArtifactManifestSync(this.dataDir, snapshot.sessionId, {
      createdAtMs: snapshot.createdAtMs,
      updatedAtMs: snapshot.createdAtMs,
      source: 'local-runtime',
    });
    const snapshotPath = artifactPaths.snapshot;
    const contract = resolveV2DirectoryContract(this.dataDir);
    const snapshotSessionDir =
      artifactPaths.layout === 'legacy-draft'
        ? path.dirname(snapshotPath)
        : artifactPaths.sessionDir;
    ensureV2ArtifactParentDirSync(snapshotPath, snapshotSessionDir, contract.root);
    const tmpPath = `${snapshotPath}.${process.pid}.${randomUUID()}.tmp`;
    let serialized: string;
    try {
      serialized = `${JSON.stringify(snapshot)}\n`;
    } catch (err) {
      // A heavy session's projection can serialize past V8's max string length
      // (0x1fffffe8, ~512MB), throwing `RangeError: Invalid string length`.
      // The snapshot cache is a best-effort read
      // accelerator — the ledger is the source of truth — so skip the write
      // instead of turning an oversized session into a hard failure. The next
      // read simply falls back to a full ledger replay.
      if (isStringLengthOverflowError(err)) {
        this.metricsClient?.counter('session_snapshot_write_total', 1, {
          status: 'skipped_oversize',
        });
        return;
      }
      throw err;
    }
    try {
      await writeFile(tmpPath, serialized, 'utf-8');
    } catch (err) {
      // Tmp-phase failures (ENOSPC/EACCES) keep throwing through, but must
      // still be visible as failed snapshot writes.
      this.metricsClient?.counter('session_snapshot_write_total', 1, { status: 'error' });
      throw err;
    }
    try {
      await renameWithRetry(tmpPath, snapshotPath);
      this.metricsClient?.counter('session_snapshot_write_total', 1, { status: 'ok' });
    } catch {
      await unlink(tmpPath).catch(() => undefined);
      // Snapshot write is best-effort — the ledger is the source of truth.
      this.metricsClient?.counter('session_snapshot_write_total', 1, { status: 'error' });
    }
  }

  async writeSnapshotFromLedger(
    sessionId: string,
    ledgerStore: LocalSessionLedgerStore,
    targetWatermark?: LocalSessionLedgerWatermark,
  ): Promise<LocalSessionSnapshot | undefined> {
    let existing = await this.getLatest(sessionId);
    let events: LocalSessionLedgerEvent[];
    try {
      events = await collectReplayEvents(sessionId, ledgerStore, existing, targetWatermark);
    } catch {
      existing = undefined;
      events = await collectReplayEvents(sessionId, ledgerStore, undefined, targetWatermark);
    }
    const projection = replayLocalSessionLedger(
      sessionId,
      events,
      existing ? snapshotToReplayBase(existing) : {},
    );
    if (!projection.watermark) {
      await this.deleteSession(sessionId);
      return undefined;
    }
    const currentWatermark = targetWatermark ?? (await ledgerStore.getWatermark(sessionId));
    const watermark =
      currentWatermark && sameLedgerPoint(currentWatermark, projection.watermark)
        ? currentWatermark
        : projection.watermark;
    const snapshot = projectionToSnapshot({
      projection: { ...projection, watermark },
      snapshotId: this.makeSnapshotId(sessionId, watermark),
      createdAtMs: this.nowMs(),
      piHistoryFacts: Boolean(existing?.piHistoryFacts) || events.some(isPiHistoryFactEvent),
    });
    await this.writeLatest(snapshot);
    return snapshot;
  }

  async readResumeProjection(
    sessionId: string,
    ledgerStore: LocalSessionLedgerStore,
  ): Promise<LocalSessionSnapshotReadResult> {
    const startMs = this.nowMs();
    try {
      const result = await this.readResumeProjectionInner(sessionId, ledgerStore);
      const source = RESUME_SOURCE_LABELS[result.source];
      this.metricsClient?.counter('session_resume_load_total', 1, { source, status: 'ok' });
      this.metricsClient?.histogram('session_resume_load_duration_ms', this.nowMs() - startMs, {
        source,
      });
      this.metricsClient?.histogram('session_resume_replayed_events', result.replayedEventCount, {
        source,
      });
      return result;
    } catch (err) {
      // The only path that can escape readResumeProjectionInner is the canonical full replay.
      this.metricsClient?.counter('session_resume_load_total', 1, {
        source: 'full_ledger',
        status: 'error',
      });
      throw err;
    }
  }

  private async readResumeProjectionInner(
    sessionId: string,
    ledgerStore: LocalSessionLedgerStore,
  ): Promise<LocalSessionSnapshotReadResult> {
    const snapshot = await this.getLatest(sessionId);
    if (snapshot) {
      try {
        const events = await collect(ledgerStore.readEventsAfter(sessionId, snapshot.watermark));
        const projection = replayLocalSessionLedger(
          sessionId,
          events,
          snapshotToReplayBase(snapshot),
        );
        return {
          projection,
          source: 'snapshot-tail',
          snapshot,
          replayedEventCount: events.length,
          piHistoryFacts: snapshot.piHistoryFacts || events.some(isPiHistoryFactEvent),
        };
      } catch {
        // Corrupt snapshot cursor or ledger tail: fall back to canonical full replay below.
        this.metricsClient?.counter('session_resume_snapshot_fallback_total', 1);
      }
    }

    const events = await collect(ledgerStore.readEvents(sessionId));
    const projection = replayLocalSessionLedger(sessionId, events);
    if (!projection.watermark) {
      await this.deleteSession(sessionId);
      return {
        projection,
        source: 'empty',
        replayedEventCount: events.length,
        piHistoryFacts: false,
      };
    }
    const currentWatermark = await ledgerStore.getWatermark(sessionId);
    const watermark =
      currentWatermark && sameLedgerPoint(currentWatermark, projection.watermark)
        ? currentWatermark
        : projection.watermark;
    const repairedProjection = { ...projection, watermark };
    const repairedSnapshot = projectionToSnapshot({
      projection: repairedProjection,
      snapshotId: this.makeSnapshotId(sessionId, watermark),
      createdAtMs: this.nowMs(),
      piHistoryFacts: events.some(isPiHistoryFactEvent),
    });
    await this.writeLatest(repairedSnapshot);
    return {
      projection: repairedProjection,
      source: 'full-ledger',
      snapshot: repairedSnapshot,
      replayedEventCount: events.length,
      piHistoryFacts: repairedSnapshot.piHistoryFacts,
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    deleteV2SessionSnapshotSync(this.dataDir, sessionId);
  }
}

export function resolveLocalSessionSnapshotPath(dataDir: DataDirInput, sessionId: string): string {
  return resolveV2SessionArtifactPathsSync(dataDir, sessionId).snapshot;
}

function projectionToSnapshot(input: {
  projection: ReplayedLocalSessionProjection;
  snapshotId: string;
  createdAtMs: number;
  piHistoryFacts: boolean;
}): LocalSessionSnapshot {
  return {
    schemaVersion: LOCAL_SESSION_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: input.snapshotId,
    sessionId: input.projection.sessionId,
    createdAtMs: input.createdAtMs,
    watermark: input.projection.watermark!,
    ...(input.projection.record ? { record: input.projection.record } : {}),
    displayMessages: input.projection.displayMessages,
    piHistory: input.projection.piHistory,
    ...(input.projection.fileApiUploads ? { fileApiUploads: input.projection.fileApiUploads } : {}),
    piHistoryFacts: input.piHistoryFacts,
    deleted: input.projection.deleted,
  };
}

async function collectReplayEvents(
  sessionId: string,
  ledgerStore: LocalSessionLedgerStore,
  existing: LocalSessionSnapshot | undefined,
  targetWatermark: LocalSessionLedgerWatermark | undefined,
): Promise<LocalSessionLedgerEvent[]> {
  const source = existing
    ? ledgerStore.readEventsAfter(sessionId, existing.watermark)
    : ledgerStore.readEvents(sessionId);
  const events = await collect(source);
  if (!targetWatermark) return events;
  return events.filter((event) => event.seq <= targetWatermark.lastSeq);
}

function snapshotToReplayBase(snapshot: LocalSessionSnapshot): LocalSessionProjectionReplayBase {
  return {
    ...(snapshot.record ? { record: snapshot.record } : {}),
    displayMessages: snapshot.displayMessages,
    piHistory: snapshot.piHistory,
    ...(snapshot.fileApiUploads ? { fileApiUploads: snapshot.fileApiUploads } : {}),
    deleted: snapshot.deleted,
    watermark: snapshot.watermark,
  };
}

function sameLedgerPoint(
  left: LocalSessionLedgerWatermark,
  right: LocalSessionLedgerWatermark,
): boolean {
  return left.lastSeq === right.lastSeq && left.lastEventId === right.lastEventId;
}

function isStringLengthOverflowError(err: unknown): boolean {
  return err instanceof RangeError && /invalid string length|string longer than/i.test(err.message);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function isLocalSessionSnapshot(
  value: unknown,
  expectedSessionId: string,
): value is LocalSessionSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<LocalSessionSnapshot>;
  return (
    snapshot.schemaVersion === LOCAL_SESSION_SNAPSHOT_SCHEMA_VERSION &&
    snapshot.sessionId === expectedSessionId &&
    typeof snapshot.snapshotId === 'string' &&
    typeof snapshot.createdAtMs === 'number' &&
    isLocalSessionSnapshotWatermark(snapshot.watermark, expectedSessionId) &&
    Array.isArray(snapshot.displayMessages) &&
    Array.isArray(snapshot.piHistory) &&
    isFileApiUploads(snapshot.fileApiUploads) &&
    typeof snapshot.piHistoryFacts === 'boolean' &&
    typeof snapshot.deleted === 'boolean'
  );
}

function isFileApiUploads(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const upload = entry as Partial<LocalFileApiUploadProjectionEntry>;
    return (
      typeof upload.contentHash === 'string' &&
      typeof upload.endpointHash === 'string' &&
      typeof upload.callerIdentityHash === 'string' &&
      typeof upload.ttlSec === 'number' &&
      typeof upload.fileId === 'string' &&
      typeof upload.createdAtMs === 'number' &&
      typeof upload.expiresAtMs === 'number'
    );
  });
}

function isLocalSessionSnapshotWatermark(
  value: unknown,
  expectedSessionId: string,
): value is LocalSessionLedgerWatermark {
  if (!value || typeof value !== 'object') return false;
  const watermark = value as Partial<LocalSessionLedgerWatermark>;
  const lastSeq = watermark.lastSeq;
  const byteOffset = watermark.byteOffset;
  return (
    watermark.sessionId === expectedSessionId &&
    typeof lastSeq === 'number' &&
    Number.isInteger(lastSeq) &&
    lastSeq >= 0 &&
    typeof watermark.lastEventId === 'string' &&
    typeof watermark.updatedAtMs === 'number' &&
    (byteOffset === undefined ||
      (typeof byteOffset === 'number' && Number.isInteger(byteOffset) && byteOffset >= 0))
  );
}

function isPiHistoryFactEvent(event: LocalSessionLedgerEvent): boolean {
  return (
    event.kind === 'message.pi_history_appended' ||
    event.kind === 'message.pi_history_replaced' ||
    event.kind === 'message.state_deleted' ||
    event.kind === 'session.deleted'
  );
}

function sanitizeSnapshotPathSegment(value: string): string {
  return `session_${Buffer.from(value || 'unknown-session', 'utf-8').toString('base64url')}`;
}

function defaultSnapshotId(sessionId: string, watermark: LocalSessionLedgerWatermark): string {
  return `snapshot_${sanitizeSnapshotPathSegment(sessionId)}_${watermark.lastSeq}_${randomUUID().replace(/-/g, '')}`;
}

/**
 * Async rename with retry for transient Windows EPERM / EACCES errors
 * caused by antivirus, search indexer, or concurrent file handle races.
 */
async function renameWithRetry(src: string, dest: string, maxRetries = 3): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(src, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EACCES') && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}
