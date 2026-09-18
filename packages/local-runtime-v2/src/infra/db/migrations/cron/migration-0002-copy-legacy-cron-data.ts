import { createHash } from 'node:crypto';

import { Cron } from 'croner';

import type { MigrationDatabase, MigrationEntry } from '../../migrate.js';

export const migration: MigrationEntry = {
  version: 2,
  name: 'copy-legacy-cron-data',
  up: copyLegacyCronData,
};

interface LegacyCronRow {
  readonly agent_name: string;
  readonly cron_name: string;
  readonly config_json: string;
  readonly updated_at_ms: number;
  readonly cron_id: string | null;
}

interface LegacyCronHistoryRow {
  readonly id: number;
  readonly agent_name: string;
  readonly cron_name: string;
  readonly session_id: string;
  readonly created_at_ms: number;
}

interface LegacySessionRow {
  readonly session_id: string;
  readonly record_json: string;
  readonly updated_at_ms: number;
}

interface PersistedCronRunRow {
  readonly run_id: string;
  readonly cron_id: string;
  readonly scheduler_trigger_id: string | null;
  readonly trigger_source: string;
  readonly session_id: string | null;
  readonly status: string;
  readonly created_at_ms: number;
  readonly execution_claimed_at_ms: number | null;
  readonly delivered_at_ms: number | null;
  readonly failed_at_ms: number | null;
  readonly error_code: string | null;
  readonly error: string | null;
}

interface LegacyConfig {
  readonly prompt: string;
  readonly disabled: boolean;
  readonly scheduleType: 'recurring' | 'once';
  readonly schedule?: string;
  readonly timezone?: string;
  readonly runAtMs?: number;
  readonly session?: { readonly mode?: string; readonly sessionId?: string };
}

type LegacySchedule =
  | { readonly kind: 'cron'; readonly expression: string; readonly timezone?: string }
  | { readonly kind: 'once'; readonly runAtMs: number };

type LegacyState = 'active' | 'expired' | 'cancelled';

interface CopyLegacyCronRunHistoryOptions {
  readonly warnOnOrphanedNativeRows?: boolean;
}

function copyLegacyCronData(database: MigrationDatabase): void {
  if (!tableExists(database, 'local_runtime_crons')) return;
  const appliedAtMs = Date.now();
  timestamp(appliedAtMs, 'migration nowMs');
  const rows = database
    .prepare(
      `SELECT agent_name, cron_name, config_json, updated_at_ms, cron_id
       FROM local_runtime_crons
       ORDER BY agent_name, cron_name`,
    )
    .all() as LegacyCronRow[];
  const insertJob = database.prepare(
    `INSERT INTO local_runtime_v2_scheduler_jobs
       (scheduler_id, handler_key, schedule_json, run_count, state, next_run_at_ms,
        created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertDefinition = database.prepare(
    `INSERT INTO local_runtime_v2_cron_definitions
       (cron_id, scheduler_id, agent_name, name, prompt, target_session_id,
        revision, deleted_at_ms, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const row of rows) {
    timestamp(row.updated_at_ms, 'legacy updatedAtMs');
    const config = parseLegacyConfig(row.config_json);
    const schedule = legacySchedule(config);
    const cronId =
      validCronId(row.cron_id) ?? stableLegacyId('cron', row.agent_name, row.cron_name);
    const schedulerId = stableLegacyId('scheduler', cronId);
    const state = legacySchedulerState(config, schedule, appliedAtMs);

    insertJob.run(
      schedulerId,
      'cron.run',
      JSON.stringify(schedule),
      0,
      state,
      legacyNextRunAtMs(schedule, state, appliedAtMs),
      row.updated_at_ms,
      row.updated_at_ms,
    );
    insertDefinition.run(
      cronId,
      schedulerId,
      row.agent_name,
      row.cron_name,
      config.prompt,
      legacyTargetSessionId(config) ?? null,
      0,
      null,
      row.updated_at_ms,
      row.updated_at_ms,
    );
  }

  copyLegacyCronRunHistory(database);
}

/** Frozen history projection shared by fresh version 2 and compatibility version 4. */
export function copyLegacyCronRunHistory(
  database: MigrationDatabase,
  options: CopyLegacyCronRunHistoryOptions = {},
): void {
  if (!tableExists(database, 'local_runtime_v2_cron_runs')) return;
  const cronIds = loadMigratedLegacyCronIds(database);
  const persistedRuns = loadPersistedCronRuns(database);
  const nativeHistory = copyNativeLegacyRunHistory(database, cronIds, persistedRuns);
  copyPurposeLegacyRunHistory(database, cronIds, nativeHistory.sessions, persistedRuns);
  if (options.warnOnOrphanedNativeRows) {
    warnAboutOrphanedLegacyHistory(nativeHistory.orphanedRowCount);
  }
}

function loadMigratedLegacyCronIds(database: MigrationDatabase): Map<string, string> {
  const cronIds = new Map<string, string>();
  if (!tableExists(database, 'local_runtime_crons')) return cronIds;
  const migratedCronIds = new Set(
    (
      database.prepare('SELECT cron_id FROM local_runtime_v2_cron_definitions').all() as Array<{
        cron_id: string;
      }>
    ).map((row) => row.cron_id),
  );
  const legacyRows = database
    .prepare(
      `SELECT agent_name, cron_name, config_json, updated_at_ms, cron_id
       FROM local_runtime_crons
       ORDER BY agent_name, cron_name`,
    )
    .all() as LegacyCronRow[];
  for (const row of legacyRows) {
    const cronId =
      validCronId(row.cron_id) ?? stableLegacyId('cron', row.agent_name, row.cron_name);
    if (!migratedCronIds.has(cronId)) {
      throw new Error(
        `Legacy Cron Definition was not migrated: ${row.agent_name}/${row.cron_name}`,
      );
    }
    cronIds.set(legacyCronKey(row.agent_name, row.cron_name), cronId);
  }
  return cronIds;
}

function loadPersistedCronRuns(database: MigrationDatabase): Map<string, PersistedCronRunRow> {
  const rows = database
    .prepare(
      `SELECT run_id, cron_id, scheduler_trigger_id, trigger_source, session_id, status,
              created_at_ms, execution_claimed_at_ms, delivered_at_ms, failed_at_ms,
              error_code, error
       FROM local_runtime_v2_cron_runs`,
    )
    .all() as PersistedCronRunRow[];
  return new Map(rows.map((row) => [row.run_id, row]));
}

function copyNativeLegacyRunHistory(
  database: MigrationDatabase,
  cronIds: ReadonlyMap<string, string>,
  persistedRuns: Map<string, PersistedCronRunRow>,
): { readonly sessions: ReadonlySet<string>; readonly orphanedRowCount: number } {
  const sessions = new Set<string>();
  let orphanedRowCount = 0;
  if (!tableExists(database, 'local_runtime_cron_session_history')) {
    return { sessions, orphanedRowCount };
  }
  const historyRows = database
    .prepare(
      `SELECT id, agent_name, cron_name, session_id, created_at_ms
       FROM local_runtime_cron_session_history
       ORDER BY created_at_ms, id`,
    )
    .all() as LegacyCronHistoryRow[];
  for (const row of historyRows) {
    const agentName = nonEmpty(row.agent_name, 'legacy history agentName');
    const cronName = nonEmpty(row.cron_name, 'legacy history cronName');
    const cronId = cronIds.get(legacyCronKey(agentName, cronName));
    if (!cronId) {
      orphanedRowCount += 1;
      continue;
    }
    const sourceId = String(requiredNumber(row.id, 'legacy history id'));
    const sessionId = nonEmpty(row.session_id, 'legacy history sessionId');
    const createdAtMs = requiredNumber(row.created_at_ms, 'legacy history createdAtMs');
    insertLegacyRun(database, persistedRuns, {
      cronId,
      sessionId,
      createdAtMs,
      sourceKind: 'history',
      sourceId,
    });
    sessions.add(legacyRunSessionKey(cronId, sessionId));
  }
  return { sessions, orphanedRowCount };
}

function warnAboutOrphanedLegacyHistory(rowCount: number): void {
  if (rowCount === 0) return;
  process.emitWarning(
    `Skipped ${rowCount} orphaned legacy Cron history ${rowCount === 1 ? 'row' : 'rows'}`,
    { code: 'MAVIS_CRON_MIGRATION_ORPHAN_HISTORY_SKIPPED' },
  );
}

function copyPurposeLegacyRunHistory(
  database: MigrationDatabase,
  cronIds: ReadonlyMap<string, string>,
  nativeSessions: ReadonlySet<string>,
  persistedRuns: Map<string, PersistedCronRunRow>,
): void {
  if (!tableExists(database, 'local_runtime_sessions')) return;
  const sessionRows = database
    .prepare(
      `SELECT session_id, record_json, updated_at_ms
       FROM local_runtime_sessions
       ORDER BY updated_at_ms, session_id`,
    )
    .all() as LegacySessionRow[];
  for (const row of sessionRows) {
    const record = parseLegacySessionRecord(row.record_json);
    if (!record) continue;
    const purpose = parseLegacyCronSessionPurpose(record.purpose);
    if (!purpose || purpose.cronName === 'memory-cleanup') continue;
    const cronId = cronIds.get(legacyCronKey(purpose.agentName, purpose.cronName));
    if (!cronId) continue;
    const sessionId = nonEmpty(row.session_id, 'legacy session sessionId');
    if (nativeSessions.has(legacyRunSessionKey(cronId, sessionId))) continue;
    insertLegacyRun(database, persistedRuns, {
      cronId,
      sessionId,
      createdAtMs: requiredNumber(record.createdAtMs, 'legacy session createdAtMs'),
      sourceKind: 'session',
      sourceId: sessionId,
    });
  }
}

interface LegacyRunInput {
  readonly cronId: string;
  readonly sessionId: string;
  readonly createdAtMs: number;
  readonly sourceKind: 'history' | 'session';
  readonly sourceId: string;
}

function insertLegacyRun(
  database: MigrationDatabase,
  persistedRuns: Map<string, PersistedCronRunRow>,
  input: LegacyRunInput,
): void {
  // V1 rows prove only that a Cron session existed. scheduled + delivered keeps
  // old sessions visible in the UI; it is not evidence of successful delivery.
  const digest = stableLegacyDigest(input.cronId, input.sourceKind, input.sourceId);
  const expected: PersistedCronRunRow = {
    run_id: `legacy-run-${digest}`,
    cron_id: input.cronId,
    scheduler_trigger_id: `legacy-trigger-${digest}`,
    trigger_source: 'scheduled',
    session_id: input.sessionId,
    status: 'delivered',
    created_at_ms: input.createdAtMs,
    execution_claimed_at_ms: input.createdAtMs,
    delivered_at_ms: input.createdAtMs,
    failed_at_ms: null,
    error_code: null,
    error: null,
  };
  const existing = persistedRuns.get(expected.run_id);
  if (existing) {
    if (legacyRunFingerprint(existing) !== legacyRunFingerprint(expected)) {
      throw new Error(`Legacy Cron run conflicts with existing data: ${expected.run_id}`);
    }
    return;
  }
  database
    .prepare(
      `INSERT INTO local_runtime_v2_cron_runs
         (run_id, cron_id, scheduler_trigger_id, trigger_source, session_id, status,
          created_at_ms, execution_claimed_at_ms, delivered_at_ms, failed_at_ms,
          error_code, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      expected.run_id,
      expected.cron_id,
      expected.scheduler_trigger_id,
      expected.trigger_source,
      expected.session_id,
      expected.status,
      expected.created_at_ms,
      expected.execution_claimed_at_ms,
      expected.delivered_at_ms,
      expected.failed_at_ms,
      expected.error_code,
      expected.error,
    );
  persistedRuns.set(expected.run_id, expected);
}

function legacyRunFingerprint(run: PersistedCronRunRow): string {
  return JSON.stringify([
    run.cron_id,
    run.scheduler_trigger_id,
    run.trigger_source,
    run.session_id,
    run.status,
    run.created_at_ms,
    run.execution_claimed_at_ms,
    run.delivered_at_ms,
    run.failed_at_ms,
    run.error_code,
    run.error,
  ]);
}

interface LegacySessionRecord {
  readonly purpose: string;
  readonly createdAtMs: unknown;
}

function parseLegacySessionRecord(raw: string): LegacySessionRecord | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.purpose !== 'string') return undefined;
    return { purpose: record.purpose, createdAtMs: record.createdAtMs };
  } catch {
    return undefined;
  }
}

function parseLegacyCronSessionPurpose(
  purpose: string,
): { agentName: string; cronName: string } | undefined {
  const prefix = 'cron:';
  if (!purpose.startsWith(prefix)) return undefined;
  const [agentName, ...cronNameParts] = purpose.slice(prefix.length).split(':');
  const cronName = cronNameParts.join(':');
  return agentName && cronName ? { agentName, cronName } : undefined;
}

function legacyCronKey(agentName: string, cronName: string): string {
  return `${agentName.length}:${agentName}${cronName}`;
}

function legacyRunSessionKey(cronId: string, sessionId: string): string {
  return `${cronId.length}:${cronId}${sessionId}`;
}

type LegacyTableName =
  | 'local_runtime_crons'
  | 'local_runtime_cron_session_history'
  | 'local_runtime_sessions'
  | 'local_runtime_v2_cron_runs';

function tableExists(database: MigrationDatabase, tableName: LegacyTableName): boolean {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name?: unknown }>;
  return rows.some((row) => row.name === tableName);
}

function parseLegacyConfig(raw: string): LegacyConfig {
  const parsed = asRecord(JSON.parse(raw) as unknown);
  const scheduleType = parsed.scheduleType === 'once' ? 'once' : 'recurring';
  return {
    prompt: nonEmpty(parsed.prompt, 'config.prompt'),
    disabled: parsed.disabled === true,
    scheduleType,
    ...(typeof parsed.schedule === 'string' ? { schedule: parsed.schedule } : {}),
    ...(typeof parsed.timezone === 'string' ? { timezone: parsed.timezone } : {}),
    ...(typeof parsed.runAtMs === 'number' ? { runAtMs: parsed.runAtMs } : {}),
    ...(typeof parsed.session === 'object' && parsed.session !== null
      ? { session: parsed.session as LegacyConfig['session'] }
      : {}),
  };
}

function legacySchedule(config: LegacyConfig): LegacySchedule {
  if (config.scheduleType === 'once') {
    return { kind: 'once', runAtMs: requiredNumber(config.runAtMs, 'config.runAtMs') };
  }
  return {
    kind: 'cron',
    expression: nonEmpty(config.schedule, 'config.schedule'),
    ...(config.timezone === undefined
      ? {}
      : { timezone: nonEmpty(config.timezone, 'config.timezone') }),
  };
}

function legacySchedulerState(
  config: LegacyConfig,
  schedule: LegacySchedule,
  nowMs: number,
): LegacyState {
  if (config.disabled) return 'cancelled';
  if (schedule.kind === 'once' && schedule.runAtMs <= nowMs) return 'expired';
  return 'active';
}

function legacyNextRunAtMs(
  schedule: LegacySchedule,
  state: LegacyState,
  nowMs: number,
): number | null {
  if (state !== 'active') return null;
  if (schedule.kind === 'once') return schedule.runAtMs;
  const timer = new Cron(schedule.expression, {
    timezone: schedule.timezone,
    paused: true,
    unref: true,
  });
  try {
    const nextRun = timer.nextRun(new Date(nowMs));
    if (!nextRun) throw new Error('Legacy Cron schedule has no future run');
    return nextRun.getTime();
  } finally {
    timer.stop();
  }
}

function legacyTargetSessionId(config: LegacyConfig): string | undefined {
  return config.session?.mode === 'sessionId' && config.session.sessionId
    ? nonEmpty(config.session.sessionId, 'config.session.sessionId')
    : undefined;
}

function validCronId(value: string | null): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stableLegacyId(kind: string, ...parts: string[]): string {
  return `legacy-${kind}-${stableLegacyDigest(...parts)}`;
}

function stableLegacyDigest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('Legacy Cron config is invalid');
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} is invalid`);
  return value as number;
}

function timestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a Unix millisecond integer`);
  }
}
