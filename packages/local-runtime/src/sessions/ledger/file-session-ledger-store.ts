import { Buffer } from 'node:buffer';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  LOCAL_SESSION_LEDGER_SCHEMA_VERSION,
  type AppendLocalSessionLedgerResult,
  type LocalSessionLedgerEvent,
  type LocalSessionLedgerEventDraft,
  type LocalSessionLedgerWatermark,
} from './ledger-event.js';
import {
  MAX_LEDGER_LINE_BYTES,
  assertLedgerCursorOffsetSync,
  compareLedgerEvents,
  readLedgerWatermarkSync,
  streamLedgerEvents,
  type ParsedLedgerEventWithOffset,
} from './ledger-read.js';
import type { MetricsClient } from '../../common/metrics.js';
import { logger } from '../../common/logger.js';
import { type DataDirInput, type DatabaseLike, withLocalRuntimeDb } from '../../persistence/db.js';
import { resolveV2DirectoryContract } from '../../persistence/layout/v2-paths.js';
import {
  appendV2SessionDisplayTranscriptSync,
  deleteV2SessionArtifactsSync,
  ensureV2SessionArtifactManifestSync,
  ensureV2ArtifactParentDirSync,
  resolveV2SessionArtifactPathsSync,
} from '../../persistence/layout/v2-session-artifacts.js';
import {
  ledgerFileSizeSync,
  logLedgerMetricFailure,
  needsJsonlLineBoundarySync,
  recoverFailedLedgerAppendSync,
  runInTransaction,
} from './ledger-append-recovery.js';

export { LocalSessionLedgerCommitUncertainError } from './ledger-append-recovery.js';

export interface LocalSessionLedgerStore {
  append(
    sessionId: string,
    events: readonly LocalSessionLedgerEventDraft[],
  ): Promise<AppendLocalSessionLedgerResult>;
  readEvents(sessionId: string): AsyncIterable<LocalSessionLedgerEvent>;
  readEventsAfter(
    sessionId: string,
    cursor: LocalSessionLedgerWatermark,
  ): AsyncIterable<LocalSessionLedgerEvent>;
  getWatermark(sessionId: string): Promise<LocalSessionLedgerWatermark | undefined>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface FileSessionLedgerStoreOptions {
  nowMs?: () => number;
  makeEventId?: (sessionId: string, kind: string, seq: number) => string;
  metricsClient?: MetricsClient;
}

export class FileSessionLedgerStore implements LocalSessionLedgerStore {
  private readonly nowMs: () => number;
  private readonly makeEventId: (sessionId: string, kind: string, seq: number) => string;
  private readonly metricsClient?: MetricsClient;
  private readonly appendChains = new Map<string, Promise<void>>();

  constructor(
    private readonly dataDir: DataDirInput,
    options: FileSessionLedgerStoreOptions = {},
  ) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.makeEventId = options.makeEventId ?? defaultEventId;
    this.metricsClient = options.metricsClient;
  }

  async append(
    sessionId: string,
    drafts: readonly LocalSessionLedgerEventDraft[],
  ): Promise<AppendLocalSessionLedgerResult> {
    if (drafts.length === 0) {
      const watermark = (await this.getWatermark(sessionId)) ?? {
        sessionId,
        lastSeq: 0,
        lastEventId: '',
        updatedAtMs: this.nowMs(),
      };
      return { events: [], watermark };
    }
    return this.withSessionAppendLock(sessionId, async () => {
      // Duration measured from inside the lock: actual write work, excluding lock wait.
      const startMs = this.nowMs();
      let committedResult: AppendLocalSessionLedgerResult | undefined;
      try {
        const result = withLocalRuntimeDb(this.dataDir, (db) =>
          runInTransaction(db, () => {
            const artifactPaths = ensureV2SessionArtifactManifestSync(this.dataDir, sessionId, {
              createdAtMs: inferArtifactCreatedAtMs(drafts, this.nowMs()),
              updatedAtMs: this.nowMs(),
              source: inferArtifactSource(drafts),
            });
            const ledgerPath = artifactPaths.ledger;
            const managedRoot = resolveV2DirectoryContract(this.dataDir).root;
            ensureV2ArtifactParentDirSync(ledgerPath, artifactPaths.sessionDir, managedRoot);
            const fileWatermark = readLedgerWatermarkSync(ledgerPath, sessionId);
            const events = this.allocateEvents(db, sessionId, drafts, fileWatermark);
            const boundary = needsJsonlLineBoundarySync(ledgerPath) ? '\n' : '';
            const contents = `${boundary}${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
            const preAppendSize = ledgerFileSizeSync(ledgerPath);
            const byteOffset = preAppendSize + Buffer.byteLength(contents, 'utf-8');
            const last = events[events.length - 1]!;
            const appendResult = {
              events,
              watermark: {
                sessionId,
                lastSeq: last.seq,
                lastEventId: last.eventId,
                updatedAtMs: last.createdAtMs,
                byteOffset,
              },
            };
            try {
              appendFileSync(ledgerPath, contents, { encoding: 'utf-8' });
            } catch (error) {
              if (!recoverFailedLedgerAppendSync(ledgerPath, preAppendSize, contents, error)) {
                throw error;
              }
            }
            committedResult = appendResult;
            appendDisplayTranscriptBestEffort(artifactPaths, events, managedRoot);
            return committedResult;
          }),
        );
        this.recordAppendMetrics(sessionId, 'ok', startMs);
        return result;
      } catch (err) {
        if (committedResult) {
          logger.warn(
            {
              session_id: sessionId,
              error_type: err instanceof Error ? err.name : typeof err,
            },
            '[file-session-ledger] allocator transaction completion failed after JSONL commit',
          );
          this.recordAppendMetrics(sessionId, 'ok', startMs);
          return committedResult;
        }
        this.recordAppendMetrics(sessionId, 'error', startMs);
        throw err;
      }
    });
  }

  async *readEvents(sessionId: string): AsyncIterable<LocalSessionLedgerEvent> {
    // Stream the ledger line-by-line instead of materializing the whole file
    // into a single JS string. A heavy session's ledger (many large tool
    // outputs / image / PPT dumps) can exceed V8's max string length
    // (0x1fffffe8, ~512MB); `readFile(..., 'utf-8')` on such a file throws
    // `RangeError: Cannot create a string longer than 0x1fffffe8`, which used
    // to turn one oversized session into a hard history-load failure.
    const events: LocalSessionLedgerEvent[] = [];
    for await (const { event } of streamLedgerEvents(
      resolveLocalSessionLedgerPath(this.dataDir, sessionId),
      sessionId,
    )) {
      events.push(event);
    }
    events.sort(compareLedgerEvents);
    for (const event of events) yield event;
  }

  async *readEventsAfter(
    sessionId: string,
    cursor: LocalSessionLedgerWatermark,
  ): AsyncIterable<LocalSessionLedgerEvent> {
    if (cursor.byteOffset !== undefined) {
      const ledgerPath = resolveLocalSessionLedgerPath(this.dataDir, sessionId);
      assertLedgerCursorOffsetSync(ledgerPath, sessionId, cursor);
      for await (const { event } of streamLedgerEvents(
        ledgerPath,
        sessionId,
        MAX_LEDGER_LINE_BYTES,
        cursor.byteOffset,
      )) {
        if (event.seq > cursor.lastSeq) yield event;
      }
      return;
    }
    for await (const event of this.readEvents(sessionId)) {
      if (event.seq > cursor.lastSeq) yield event;
    }
  }

  async getWatermark(sessionId: string): Promise<LocalSessionLedgerWatermark | undefined> {
    let last: ParsedLedgerEventWithOffset | undefined;
    for await (const parsed of streamLedgerEvents(
      resolveLocalSessionLedgerPath(this.dataDir, sessionId),
      sessionId,
    )) {
      if (!last || compareLedgerEvents(parsed.event, last.event) > 0) last = parsed;
    }
    if (!last) return undefined;
    return {
      sessionId,
      lastSeq: last.event.seq,
      lastEventId: last.event.eventId,
      updatedAtMs: last.event.createdAtMs,
      byteOffset: last.byteOffset,
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    await deleteLocalSessionLedger(this.dataDir, sessionId);
    withLocalRuntimeDb(this.dataDir, (db) => {
      db.prepare('DELETE FROM local_runtime_ledger_watermarks WHERE session_id = ?').run(sessionId);
    });
  }

  private allocateEvents(
    db: DatabaseLike,
    sessionId: string,
    drafts: readonly LocalSessionLedgerEventDraft[],
    fileWatermark?: LocalSessionLedgerWatermark,
  ): LocalSessionLedgerEvent[] {
    const row = db
      .prepare('SELECT last_seq FROM local_runtime_ledger_watermarks WHERE session_id = ?')
      .get(sessionId) as { last_seq?: unknown } | undefined;
    const lastSeq = row?.last_seq;
    const sqliteSeq = Number.isInteger(lastSeq) ? Number(lastSeq) : 0;
    let nextSeq = Math.max(sqliteSeq, fileWatermark?.lastSeq ?? 0) + 1;
    const events = drafts.map((draft) => {
      const seq = nextSeq++;
      return {
        ...draft,
        schemaVersion: LOCAL_SESSION_LEDGER_SCHEMA_VERSION,
        eventId: this.makeEventId(sessionId, draft.kind, seq),
        seq,
        createdAtMs: this.nowMs(),
      } as LocalSessionLedgerEvent;
    });
    const last = events[events.length - 1]!;
    db.prepare(
      `
      INSERT INTO local_runtime_ledger_watermarks (
        session_id,
        last_seq,
        last_event_id,
        updated_at_ms
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_seq = excluded.last_seq,
        last_event_id = excluded.last_event_id,
        updated_at_ms = excluded.updated_at_ms
    `,
    ).run(sessionId, last.seq, last.eventId, last.createdAtMs);
    return events;
  }

  private async withSessionAppendLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.appendChains.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(
      () => current,
      () => current,
    );
    this.appendChains.set(sessionId, chain);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.appendChains.get(sessionId) === chain) this.appendChains.delete(sessionId);
    }
  }

  private recordAppendMetrics(sessionId: string, status: 'ok' | 'error', startMs: number): void {
    try {
      this.metricsClient?.counter('session_ledger_append_total', 1, { status });
    } catch (error) {
      logLedgerMetricFailure(sessionId, 'session_ledger_append_total', error);
    }
    if (status === 'error') return;
    try {
      this.metricsClient?.histogram('session_ledger_append_duration_ms', this.nowMs() - startMs);
    } catch (error) {
      logLedgerMetricFailure(sessionId, 'session_ledger_append_duration_ms', error);
    }
  }
}

export function resolveLocalSessionLedgerPath(dataDir: DataDirInput, sessionId: string): string {
  return resolveV2SessionArtifactPathsSync(dataDir, sessionId).ledger;
}

export async function deleteLocalSessionLedger(
  dataDir: DataDirInput,
  sessionId: string,
): Promise<void> {
  deleteV2SessionArtifactsSync(dataDir, sessionId);
}

function appendDisplayTranscriptBestEffort(
  artifactPaths: ReturnType<typeof resolveV2SessionArtifactPathsSync>,
  events: readonly LocalSessionLedgerEvent[],
  managedRoot: string,
): void {
  try {
    appendV2SessionDisplayTranscriptSync(
      artifactPaths,
      events.flatMap((event) =>
        event.kind === 'message.display_upserted'
          ? [
              {
                sessionId: event.sessionId,
                seq: event.seq,
                eventId: event.eventId,
                createdAtMs: event.createdAtMs,
                ...(event.turnId ? { turnId: event.turnId } : {}),
                message: event.message,
              },
            ]
          : [],
      ),
      { managedRoot },
    );
  } catch {
    // The canonical event was already committed to the ledger. Display JSONL is a
    // human-readable mirror, so it must not turn a successful ledger append into
    // a retry that would duplicate canonical events.
  }
}

function inferArtifactCreatedAtMs(
  drafts: readonly LocalSessionLedgerEventDraft[],
  fallback: number,
): number {
  for (const draft of drafts) {
    if (
      (draft.kind === 'session.created' || draft.kind === 'session.metadata_updated') &&
      typeof draft.record.createdAtMs === 'number'
    ) {
      return draft.record.createdAtMs;
    }
  }
  return fallback;
}

function inferArtifactSource(
  drafts: readonly LocalSessionLedgerEventDraft[],
): 'local-runtime' | 'legacy-migration' {
  return drafts.some((draft) => draft.kind === 'session.metadata_updated')
    ? 'legacy-migration'
    : 'local-runtime';
}

function sanitizeLedgerPathSegment(value: string): string {
  return `session_${Buffer.from(value || 'unknown-session', 'utf-8').toString('base64url')}`;
}

function defaultEventId(sessionId: string, kind: string, seq: number): string {
  return `evt_${sanitizeLedgerPathSegment(sessionId)}_${sanitizeLedgerPathSegment(kind)}_${seq}_${randomSuffix()}`;
}

function randomSuffix(): string {
  return randomUUID().replace(/-/g, '');
}
