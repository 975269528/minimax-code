import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import type { DatabaseLike } from '../db.js';
import {
  collectV2SessionArtifactDiagnostics,
  resolveV2SessionArtifactPathsSync,
} from '../layout/v2-session-artifacts.js';
import {
  ledgerFileSizeSync,
  needsJsonlLineBoundarySync,
  recoverFailedLedgerAppendSync,
} from '../../sessions/ledger/ledger-append-recovery.js';
import { compareLedgerEvents, scanLedgerEventsSync } from '../../sessions/ledger/ledger-read.js';
import type { AgentNameMapping } from './agent-name-conflict-migration-manifest.js';
import {
  isRecord,
  listTables,
  parseJsonOrThrow,
  quoteIdentifier,
  rewriteStructuredValue,
  tableColumns,
} from './agent-name-conflict-migration-files.js';

const JSON_COLUMNS = new Set([
  'record_json',
  'data_json',
  'items_json',
  'config_json',
  'request_json',
  'origin_channel_context_json',
  'payload_json',
  'value_json',
]);
const DIRECT_AGENT_TABLES = new Set([
  'local_runtime_crons',
  'local_runtime_cron_legacy_imports',
  'local_runtime_cron_session_history',
  'local_runtime_token_usage',
  'local_runtime_turn_diffs',
  'local_runtime_turn_diff_journal',
  'questionnaire_requests',
]);
const JSON_AGENT_TABLES = new Set([
  'local_runtime_agents',
  'local_runtime_sessions',
  'local_runtime_queues',
  'local_runtime_queue_items',
  'local_runtime_background_tasks',
  'local_runtime_background_task_events',
  'local_runtime_crons',
  'questionnaire_requests',
  'local_runtime_preferences',
]);
const AGENT_REFERENCE_PREFERENCE_KEYS = new Set(['starred-agents', 'pinned-items-order']);

export function rewriteRuntimeReferences(
  dataDir: string,
  db: DatabaseLike,
  mappings: AgentNameMapping[],
  nowMs: () => number,
): number {
  let updated = 0;
  const sessionRecords: Array<{ sessionId: string; record: Record<string, unknown> }> = [];
  const applyDbChanges = (): void => {
    const tables = listTables(db);
    for (const table of tables) {
      const columns = tableColumns(db, table);
      if (DIRECT_AGENT_TABLES.has(table) && columns.has('agent_name')) {
        for (const mapping of mappings) {
          const result = db
            .prepare(`UPDATE ${quoteIdentifier(table)} SET agent_name = ? WHERE agent_name = ?`)
            .run(mapping.to, mapping.from) as { changes?: number };
          updated += result.changes ?? 0;
        }
      }
      if (!JSON_AGENT_TABLES.has(table)) continue;
      for (const column of columns) {
        if (!JSON_COLUMNS.has(column)) continue;
        const preferenceKeySelect = table === 'local_runtime_preferences' ? ', key AS __key' : '';
        const rows = db
          .prepare(
            `SELECT rowid AS __rowid, ${quoteIdentifier(column)} AS __value${preferenceKeySelect} FROM ${quoteIdentifier(table)}`,
          )
          .all() as Array<{ __rowid?: unknown; __value?: unknown; __key?: unknown }>;
        for (const row of rows) {
          if (typeof row.__rowid !== 'number' || typeof row.__value !== 'string') continue;
          if (
            table === 'local_runtime_preferences' &&
            (typeof row.__key !== 'string' || !AGENT_REFERENCE_PREFERENCE_KEYS.has(row.__key))
          ) {
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.__value);
          } catch {
            throw new Error(`invalid_json:${table}.${column}`);
          }
          const value = rewriteStructuredValue(
            parsed,
            mappings,
            table === 'local_runtime_preferences' &&
              typeof row.__key === 'string' &&
              AGENT_REFERENCE_PREFERENCE_KEYS.has(row.__key),
          );
          if (!value.changed) {
            if (table === 'local_runtime_sessions' && column === 'record_json') {
              const record = value.value;
              if (
                isRecord(record) &&
                typeof record.sessionId === 'string' &&
                mappings.some((mapping) => record.agentName === mapping.to)
              ) {
                sessionRecords.push({ sessionId: record.sessionId, record });
              }
            }
            continue;
          }
          db.prepare(
            `UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(column)} = ? WHERE rowid = ?`,
          ).run(JSON.stringify(value.value), row.__rowid);
          updated += value.count;
          if (table === 'local_runtime_sessions' && column === 'record_json') {
            const record = value.value;
            if (
              isRecord(record) &&
              typeof record.sessionId === 'string' &&
              (value.changed || mappings.some((mapping) => record.agentName === mapping.to))
            ) {
              sessionRecords.push({ sessionId: record.sessionId, record });
            }
          }
        }
      }
    }

    // `local_runtime_agents.name` is the v2 projection's primary key.
    if (tables.includes('local_runtime_agents')) {
      for (const mapping of mappings) {
        const row = db
          .prepare('SELECT record_json FROM local_runtime_agents WHERE name = ?')
          .get(mapping.from) as { record_json?: unknown } | undefined;
        if (!row) continue;
        const record =
          typeof row.record_json === 'string'
            ? parseJsonOrThrow(row.record_json, 'local_runtime_agents.record_json')
            : {};
        const rewritten = rewriteStructuredValue(record, [mapping], false);
        if (isRecord(rewritten.value) && rewritten.value.name === mapping.from) {
          rewritten.value = { ...rewritten.value, name: mapping.to };
          rewritten.changed = true;
          rewritten.count += 1;
        }
        db.prepare(
          'UPDATE local_runtime_agents SET name = ?, record_json = ?, updated_at_ms = ? WHERE name = ?',
        ).run(mapping.to, JSON.stringify(rewritten.value), nowMs(), mapping.from);
        updated += 1 + rewritten.count;
      }
    }
  };
  const applyRuntimeTransaction = db.transaction?.(applyDbChanges as () => unknown);
  if (applyRuntimeTransaction) applyRuntimeTransaction();
  else applyDbChanges();

  const knownSessionIds = new Set(sessionRecords.map((session) => session.sessionId));
  for (const session of discoverAffectedLedgerSessions(dataDir, mappings)) {
    if (knownSessionIds.has(session.sessionId)) continue;
    const rewritten = rewriteStructuredValue(session.record, mappings, false);
    if (!isRecord(rewritten.value)) continue;
    sessionRecords.push({ sessionId: session.sessionId, record: rewritten.value });
    knownSessionIds.add(session.sessionId);
  }

  for (const session of sessionRecords) {
    if (appendSessionMetadataEvent(dataDir, db, session.sessionId, session.record, nowMs)) {
      updated += 1;
    }
  }
  return updated;
}

type AffectedLedgerSession = {
  sessionId: string;
  paths: ReturnType<typeof resolveV2SessionArtifactPathsSync>;
  record: Record<string, unknown>;
};

export function discoverAffectedLedgerSessions(
  dataDir: string,
  mappings: AgentNameMapping[],
): AffectedLedgerSession[] {
  const diagnostics = collectV2SessionArtifactDiagnostics(dataDir, {
    maxSessions: Number.MAX_SAFE_INTEGER,
  });
  const affected: AffectedLedgerSession[] = [];
  for (const diagnostic of diagnostics.sessions) {
    if (!diagnostic.files.ledger.exists) continue;
    const paths = resolveV2SessionArtifactPathsSync(dataDir, diagnostic.sessionId);
    if (!fs.existsSync(paths.ledger)) continue;
    const events = scanLedgerEventsSync(paths.ledger, diagnostic.sessionId).map(
      ({ event }) => event,
    );
    const latestSessionEvent = events
      .filter(
        (event) => event.kind === 'session.created' || event.kind === 'session.metadata_updated',
      )
      .reduce<
        (typeof events)[number] | undefined
      >((current, next) => (!current || compareLedgerEvents(next, current) > 0 ? next : current), undefined);
    const record = isRecord((latestSessionEvent as { record?: unknown } | undefined)?.record)
      ? (latestSessionEvent as unknown as { record: Record<string, unknown> }).record
      : undefined;
    if (!record || typeof record.agentName !== 'string') continue;
    if (
      !mappings.some(
        (mapping) => record.agentName === mapping.from || record.agentName === mapping.to,
      )
    ) {
      continue;
    }
    affected.push({ sessionId: diagnostic.sessionId, paths, record });
  }
  return affected;
}

function appendSessionMetadataEvent(
  dataDir: string,
  db: DatabaseLike,
  sessionId: string,
  record: Record<string, unknown>,
  nowMs: () => number,
): boolean {
  const paths = resolveV2SessionArtifactPathsSync(dataDir, sessionId);
  if (!fs.existsSync(paths.ledger)) return false;
  const events = scanLedgerEventsSync(paths.ledger, sessionId).map(({ event }) => event);
  const dbWatermark = db
    .prepare(
      'SELECT last_seq, last_event_id FROM local_runtime_ledger_watermarks WHERE session_id = ?',
    )
    .get(sessionId) as { last_seq?: unknown; last_event_id?: unknown } | undefined;
  const projectionWatermark = db
    .prepare(
      'SELECT last_seq, last_event_id FROM local_runtime_session_projection_watermarks WHERE session_id = ?',
    )
    .get(sessionId) as { last_seq?: unknown; last_event_id?: unknown } | undefined;
  const latestLedgerEvent = events.reduce<(typeof events)[number] | undefined>(
    (current, next) => (!current || compareLedgerEvents(next, current) > 0 ? next : current),
    undefined,
  );
  const lastSeq = Math.max(latestLedgerEvent?.seq ?? 0, Number(dbWatermark?.last_seq ?? 0), 0);
  const latestSessionEvent = events
    .filter(
      (event) => event.kind === 'session.created' || event.kind === 'session.metadata_updated',
    )
    .reduce<
      (typeof events)[number] | undefined
    >((current, next) => (!current || compareLedgerEvents(next, current) > 0 ? next : current), undefined);
  const latestSessionRecord = isRecord(
    (latestSessionEvent as { record?: unknown } | undefined)?.record,
  )
    ? (latestSessionEvent as unknown as { record: Record<string, unknown> }).record
    : undefined;
  if (
    latestSessionRecord &&
    latestSessionEvent &&
    latestSessionRecord.agentName === record.agentName
  ) {
    const previousLedgerTip = events
      .filter((event) => compareLedgerEvents(event, latestSessionEvent) < 0)
      .reduce<
        (typeof events)[number] | undefined
      >((current, next) => (!current || compareLedgerEvents(next, current) > 0 ? next : current), undefined);
    const projectionTarget =
      latestLedgerEvent && compareLedgerEvents(latestLedgerEvent, latestSessionEvent) > 0
        ? latestSessionEvent
        : (latestLedgerEvent ?? latestSessionEvent);
    const watermarkChanged = repairSessionWatermarks(
      db,
      sessionId,
      latestLedgerEvent ?? latestSessionEvent,
      projectionTarget,
      dbWatermark,
      projectionWatermark,
      previousLedgerTip,
      nowMs(),
    );
    fs.rmSync(paths.snapshot, { force: true });
    return watermarkChanged;
  }
  const createdAtMs = nowMs();
  const event = {
    schemaVersion: 1,
    eventId: `evt_${sessionId}_${lastSeq + 1}_${randomUUID().replace(/-/g, '')}`,
    sessionId,
    seq: lastSeq + 1,
    createdAtMs,
    kind: 'session.metadata_updated',
    record,
  };
  const contents = `${needsJsonlLineBoundarySync(paths.ledger) ? '\n' : ''}${JSON.stringify(event)}\n`;
  const preAppendSize = ledgerFileSizeSync(paths.ledger);
  try {
    fs.appendFileSync(paths.ledger, contents, 'utf8');
  } catch (error) {
    if (!recoverFailedLedgerAppendSync(paths.ledger, preAppendSize, contents, error)) throw error;
  }
  repairSessionWatermarks(
    db,
    sessionId,
    event,
    event,
    dbWatermark,
    projectionWatermark,
    latestLedgerEvent,
    createdAtMs,
  );
  fs.rmSync(paths.snapshot, { force: true });
  return true;
}

function repairSessionWatermarks(
  db: DatabaseLike,
  sessionId: string,
  ledgerTip: { seq: number; eventId: string },
  projectionTarget: { seq: number; eventId: string },
  previousLedgerWatermark: { last_seq?: unknown; last_event_id?: unknown } | undefined,
  previousProjectionWatermark: { last_seq?: unknown; last_event_id?: unknown } | undefined,
  directPreviousLedgerTip: { seq: number; eventId: string } | undefined,
  updatedAtMs: number,
): boolean {
  const ledgerChanged = !watermarkMatches(previousLedgerWatermark, ledgerTip);
  if (ledgerChanged) {
    db.prepare(
      `INSERT INTO local_runtime_ledger_watermarks (session_id, last_seq, last_event_id, updated_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_seq=excluded.last_seq,last_event_id=excluded.last_event_id,updated_at_ms=excluded.updated_at_ms`,
    ).run(sessionId, ledgerTip.seq, ledgerTip.eventId, updatedAtMs);
  }
  const projectionCanAdvance =
    watermarkMatches(previousProjectionWatermark, projectionTarget) ||
    (directPreviousLedgerTip !== undefined &&
      watermarkMatches(previousProjectionWatermark, directPreviousLedgerTip));
  const projectionChanged =
    projectionCanAdvance && !watermarkMatches(previousProjectionWatermark, projectionTarget);
  if (projectionChanged) {
    db.prepare(
      `INSERT INTO local_runtime_session_projection_watermarks (session_id, last_seq, last_event_id, updated_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_seq=excluded.last_seq,last_event_id=excluded.last_event_id,updated_at_ms=excluded.updated_at_ms`,
    ).run(sessionId, projectionTarget.seq, projectionTarget.eventId, updatedAtMs);
  }
  return ledgerChanged || projectionChanged;
}

function watermarkMatches(
  watermark: { last_seq?: unknown; last_event_id?: unknown } | undefined,
  event: { seq: number; eventId: string },
): boolean {
  return (
    Number(watermark?.last_seq ?? 0) === event.seq && watermark?.last_event_id === event.eventId
  );
}
