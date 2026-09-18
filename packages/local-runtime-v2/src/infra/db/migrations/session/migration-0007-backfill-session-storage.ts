import type { MigrationEntry } from '../../migrate.js';
import {
  assertFrozenBackfillPostconditions,
  canonicalFrozenProjectWorkspaceDir as canonicalProjectWorkspaceDir,
  FROZEN_PROJECT_AGGREGATE_REBUILD_SQL,
  FROZEN_PROJECT_INDEXES_SQL,
  FROZEN_PROJECT_TRIGGER_NAMES,
  FROZEN_PROJECT_TRIGGERS_SQL,
  isFrozenSessionDefaultWorkspaceDir,
  rebuildFrozenSessionSearchIndex,
} from './migration-0007-session-storage-backfill-frozen.js';
import {
  isPlainObject,
  parseJsonObject,
  readCount,
  readField,
  readInteger,
  readLegacySessionType,
  readNullableInteger,
  readNullableString,
  readOptionalBoolean,
  readOptionalEnum,
  readOptionalNullableString,
  readOptionalObject,
  readOptionalSafeInteger,
  readOptionalString,
  readPositiveSafeInteger,
  readString,
  requireBit,
  requireCompatibleSessionType,
  requireEnum,
  requireItem,
  requireNullableEnum,
} from './migration-0007-session-storage-readers.js';

type Database = Parameters<Exclude<MigrationEntry['up'], string>>[0];

export const migration: MigrationEntry = {
  version: 7,
  name: 'backfill_session_storage',
  up: backfillSessionStorage,
};

/**
 * Frozen Session/Project/FTS convergence.
 *
 * The global runner owns the surrounding transaction. This migration deliberately keeps its
 * codecs, path rules, SQL, and postconditions local so later service/schema changes cannot alter
 * the one-time data transformation.
 */
function backfillSessionStorage(database: Database): void {
  const preferencePlan = readProjectPreferencePlan(database);
  dropProjectTriggers(database);
  backfillSessions(database);
  rebuildProjects(database, preferencePlan);
  assertSessionFtsAllocatorHasSafeHeadroom(database);
  rebuildFrozenSessionSearchIndex(database, {
    readEligibleRowId: readEligibleFtsRowId,
    readNullableString,
    readPositiveSafeInteger,
    readString,
  });
  assertSessionFtsAllocatorHasSafeHeadroom(database);
  assertFrozenBackfillPostconditions(database, { readCount, readInteger, readString });
}

const CURRENT_COLUMNAR_VERSION = 3;
const DEFAULT_PROJECT_ORDER_INDEX = 2_147_483_647;
const CURRENT_STATUSES = ['idle', 'started', 'error', 'aborted', 'interrupted'] as const;
const LEGACY_STATUSES = [...CURRENT_STATUSES, 'finished'] as const;
const SESSION_KINDS = ['conversation', 'task', 'peek', 'channel', 'cron', 'unknown'] as const;
const RUNTIMES = ['pi-agent', 'opencode'] as const;
const SESSION_TYPES = ['root', 'branch'] as const;
const VISIBILITIES = ['visible', 'hidden'] as const;
const RUN_LOCATION_MODES = ['current', 'new-worktree', 'existing-worktree'] as const;

type SessionStatus = (typeof CURRENT_STATUSES)[number];
type LegacySessionStatus = (typeof LEGACY_STATUSES)[number];
type SessionKind = (typeof SESSION_KINDS)[number];
type SessionRuntime = (typeof RUNTIMES)[number];
type SessionType = (typeof SESSION_TYPES)[number];
type SessionVisibility = (typeof VISIBILITIES)[number];
type RunLocationMode = (typeof RUN_LOCATION_MODES)[number];

interface StoredSessionRow {
  readonly sessionId: string;
  readonly recordJson: string;
  readonly updatedAtMs: number;
  readonly columnarVersion: number;
  readonly agentName: string | null;
  readonly runtime: string | null;
  readonly sessionType: string | null;
  readonly status: string | null;
  readonly archived: number;
  readonly visibility: string;
  readonly sessionKind: string;
  readonly purpose: string | null;
  readonly purposeKind: string;
  readonly originCronId: string | null;
  readonly parentSessionId: string | null;
  readonly workspaceDir: string | null;
  readonly isDefaultWorkspace: number;
  readonly title: string | null;
  readonly createdAtMs: number | null;
  readonly errorMessage: string | null;
  readonly errorCode: number | null;
  readonly extraDataJson: string;
}

interface SessionColumns {
  readonly agentName: string | null;
  readonly runtime: SessionRuntime;
  readonly sessionType: SessionType;
  readonly status: SessionStatus;
  readonly archived: 0 | 1;
  readonly visibility: SessionVisibility;
  readonly sessionKind: SessionKind;
  readonly purpose: string | null;
  readonly purposeKind: string;
  readonly originCronId: string | null;
  readonly parentSessionId: string | null;
  readonly workspaceDir: string | null;
  readonly projectWorkspaceDir: string | null;
  readonly isDefaultWorkspace: 0 | 1;
  readonly title: string | null;
  readonly createdAtMs: number | null;
  readonly errorMessage: string | null;
  readonly errorCode: number | null;
  readonly extraDataJson: string;
}

interface RunLocationData {
  readonly mode: RunLocationMode;
  readonly resolvedDir: string;
  readonly resolvedBranch?: string;
  readonly parentRepoDir?: string;
  readonly createdAt: number;
}

interface LegacyRunLocationData {
  readonly mode?: RunLocationMode;
  readonly resolvedDir?: string;
  readonly resolvedBranch?: string;
  readonly parentRepoDir?: string;
  readonly createdAt?: number;
}

interface SessionExtraData {
  readonly isDefaultWorkspace?: boolean;
  readonly runLocation?: RunLocationData;
  readonly appMode?: 'coding' | 'work';
  readonly errorSource?: string;
  readonly errorDetail?: string;
  readonly errorProviderId?: string;
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
  readonly scratchpadPath?: string;
  readonly origin?: 'user' | 'root-repair';
  readonly sessionDataVersion?: number;
  readonly sessionOrigin?: 'local-runtime' | 'legacy-opencode' | 'unknown';
}

interface LegacySessionRecord {
  readonly sessionId?: string;
  readonly agentName?: string;
  readonly workspaceDir?: string;
  readonly isDefaultWorkspace?: boolean;
  readonly runtime?: SessionRuntime;
  readonly sessionType?: SessionType;
  readonly sessionKind?: SessionKind;
  readonly archived?: boolean;
  readonly title?: string | null;
  readonly parentSessionId?: string | null;
  readonly visibility?: SessionVisibility;
  readonly purpose?: string;
  readonly originCronId?: string;
  readonly runLocation?: LegacyRunLocationData;
  readonly appMode?: 'coding' | 'work';
  readonly status?: LegacySessionStatus;
  readonly errorMessage?: string;
  readonly errorCode?: number;
  readonly errorSource?: string;
  readonly errorDetail?: string;
  readonly errorProviderId?: string;
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
  readonly scratchpadPath?: string;
  readonly origin?: 'user' | 'root-repair';
  readonly sessionDataVersion?: number;
  readonly sessionOrigin?: 'local-runtime' | 'legacy-opencode' | 'unknown';
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
}

function backfillSessions(database: Database): void {
  const rows = database
    .prepare(
      `SELECT session_id, record_json, updated_at_ms, columnar_version, agent_name, runtime,
              session_type, status, archived, visibility, session_kind, purpose, purpose_kind,
              origin_cron_id, parent_session_id, workspace_dir, is_default_workspace,
              title, created_at_ms, error_message, error_code,
              extra_data_json
       FROM local_runtime_sessions
       ORDER BY rowid ASC`,
    )
    .all()
    .map(readStoredSessionRow);
  const update = database.prepare(
    `UPDATE local_runtime_sessions
     SET agent_name = ?, runtime = ?, session_type = ?, status = ?, archived = ?,
         visibility = ?, session_kind = ?, purpose = ?, purpose_kind = ?, origin_cron_id = ?,
         parent_session_id = ?, workspace_dir = ?, project_workspace_dir = ?,
         is_default_workspace = ?, title = ?, created_at_ms = ?, error_message = ?,
         error_code = ?, extra_data_json = ?, columnar_version = 3
     WHERE session_id = ?`,
  );

  for (const row of rows) {
    const columns = sessionColumns(row);
    update.run(
      columns.agentName,
      columns.runtime,
      columns.sessionType,
      columns.status,
      columns.archived,
      columns.visibility,
      columns.sessionKind,
      columns.purpose,
      columns.purposeKind,
      columns.originCronId,
      columns.parentSessionId,
      columns.workspaceDir,
      columns.projectWorkspaceDir,
      columns.isDefaultWorkspace,
      columns.title,
      columns.createdAtMs,
      columns.errorMessage,
      columns.errorCode,
      columns.extraDataJson,
      row.sessionId,
    );
  }
}

function readStoredSessionRow(value: unknown): StoredSessionRow {
  return {
    sessionId: readString(value, 'session_id', 'local_runtime_sessions'),
    recordJson: readString(value, 'record_json', 'local_runtime_sessions'),
    updatedAtMs: readInteger(value, 'updated_at_ms', 'local_runtime_sessions'),
    columnarVersion: readInteger(value, 'columnar_version', 'local_runtime_sessions'),
    agentName: readNullableString(value, 'agent_name', 'local_runtime_sessions'),
    runtime: readNullableString(value, 'runtime', 'local_runtime_sessions'),
    sessionType: readNullableString(value, 'session_type', 'local_runtime_sessions'),
    status: readNullableString(value, 'status', 'local_runtime_sessions'),
    archived: readInteger(value, 'archived', 'local_runtime_sessions'),
    visibility: readString(value, 'visibility', 'local_runtime_sessions'),
    sessionKind: readString(value, 'session_kind', 'local_runtime_sessions'),
    purpose: readNullableString(value, 'purpose', 'local_runtime_sessions'),
    purposeKind: readString(value, 'purpose_kind', 'local_runtime_sessions'),
    originCronId: readNullableString(value, 'origin_cron_id', 'local_runtime_sessions'),
    parentSessionId: readNullableString(value, 'parent_session_id', 'local_runtime_sessions'),
    workspaceDir: readNullableString(value, 'workspace_dir', 'local_runtime_sessions'),
    isDefaultWorkspace: readInteger(value, 'is_default_workspace', 'local_runtime_sessions'),
    title: readNullableString(value, 'title', 'local_runtime_sessions'),
    createdAtMs: readNullableInteger(value, 'created_at_ms', 'local_runtime_sessions'),
    errorMessage: readNullableString(value, 'error_message', 'local_runtime_sessions'),
    errorCode: readNullableInteger(value, 'error_code', 'local_runtime_sessions'),
    extraDataJson: readString(value, 'extra_data_json', 'local_runtime_sessions'),
  };
}

function sessionColumns(row: StoredSessionRow): SessionColumns {
  if (row.columnarVersion < 0 || row.columnarVersion > CURRENT_COLUMNAR_VERSION) {
    throw new Error(
      `Session ${row.sessionId} has unsupported columnar_version ${String(row.columnarVersion)}`,
    );
  }
  if (row.columnarVersion < 2) return legacySessionColumns(row);
  return typedSessionColumns(row);
}

function legacySessionColumns(row: StoredSessionRow): SessionColumns {
  const record = parseLegacySessionRecord(row.recordJson);
  assertLegacySessionIdentity(record, row.sessionId);
  const runLocation = currentRunLocationFromLegacy(record);
  const extraData = compactExtraData({
    runLocation,
    appMode: record.appMode,
    errorSource: record.errorSource,
    errorDetail: record.errorDetail,
    errorProviderId: record.errorProviderId,
    effectiveModel: record.effectiveModel,
    effectiveModelVariant: record.effectiveModelVariant,
    scratchpadPath: record.scratchpadPath,
    origin: record.origin,
    sessionDataVersion: record.sessionDataVersion,
    sessionOrigin: record.sessionOrigin,
  });
  const sessionType = valueOr(record.sessionType, 'branch');
  const sessionKind = legacySessionKind(record, sessionType);
  const visibility = migratedVisibility(sessionKind, valueOr(record.visibility, 'visible'));
  const workspaceDir = nullable(record.workspaceDir);
  const createdAtMs = firstDefinedNumber([record.createdAtMs, record.updatedAtMs], row.updatedAtMs);
  const projectIdentity = sessionProjectIdentityColumns({
    sessionId: row.sessionId,
    workspaceDir,
    runLocation,
    persistedDefault: record.isDefaultWorkspace === true,
  });

  return {
    agentName: nullable(record.agentName),
    runtime: valueOr(record.runtime, 'pi-agent'),
    sessionType,
    status: normalizeStatus(record.status),
    archived: booleanBit(record.archived),
    visibility,
    sessionKind,
    purpose: nullable(record.purpose),
    purposeKind: '',
    originCronId: nullable(record.originCronId),
    parentSessionId: nullable(record.parentSessionId),
    workspaceDir,
    ...projectIdentity,
    title: nullable(record.title),
    createdAtMs,
    errorMessage: nullable(record.errorMessage),
    errorCode: nullable(record.errorCode),
    extraDataJson: JSON.stringify(extraData),
  };
}

function assertLegacySessionIdentity(record: LegacySessionRecord, sessionId: string): void {
  if (record.sessionId === undefined || record.sessionId === sessionId) return;
  throw new Error(
    `record_json.sessionId ${record.sessionId} does not match row session_id ${sessionId}`,
  );
}

function legacySessionKind(record: LegacySessionRecord, sessionType: SessionType): SessionKind {
  if (record.sessionKind !== undefined) return record.sessionKind;
  return deriveSessionKind({
    purpose: record.purpose,
    sessionType,
    parentSessionId: record.parentSessionId,
    originCronId: record.originCronId,
  });
}

function booleanBit(value: boolean | undefined): 0 | 1 {
  return value === true ? 1 : 0;
}

function sessionProjectIdentityColumns(input: {
  readonly sessionId: string;
  readonly workspaceDir: string | null;
  readonly runLocation?: RunLocationData;
  readonly persistedDefault: boolean;
}): Pick<SessionColumns, 'projectWorkspaceDir' | 'isDefaultWorkspace'> {
  const isDefaultWorkspace =
    input.runLocation === undefined &&
    (input.persistedDefault ||
      isFrozenSessionDefaultWorkspaceDir(input.workspaceDir, input.sessionId));
  return {
    projectWorkspaceDir: isDefaultWorkspace
      ? null
      : nullable(canonicalProjectWorkspaceDir(input.workspaceDir, input.runLocation)),
    isDefaultWorkspace: booleanBit(isDefaultWorkspace),
  };
}

function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

function valueOr<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

function firstDefinedNumber(values: readonly (number | undefined)[], fallback: number): number {
  return values.find((value): value is number => value !== undefined) ?? fallback;
}

function typedSessionColumns(row: StoredSessionRow): SessionColumns {
  const runtime = requireEnum(row.runtime, RUNTIMES, `Session ${row.sessionId}.runtime`);
  const sessionType = requireCompatibleSessionType(
    row.sessionType,
    `Session ${row.sessionId}.session_type`,
  );
  const archived = requireBit(row.archived, `Session ${row.sessionId}.archived`);
  const currentVisibility = requireEnum(
    row.visibility,
    VISIBILITIES,
    `Session ${row.sessionId}.visibility`,
  );
  const currentKind = requireEnum(
    row.sessionKind,
    SESSION_KINDS,
    `Session ${row.sessionId}.session_kind`,
  );
  const currentDefault = requireBit(
    row.isDefaultWorkspace,
    `Session ${row.sessionId}.is_default_workspace`,
  );
  const parsedExtra = parseCurrentExtraData(row.extraDataJson);
  const { isDefaultWorkspace: legacyDefault, ...extraData } = parsedExtra;
  const projectIdentity = sessionProjectIdentityColumns({
    sessionId: row.sessionId,
    workspaceDir: row.workspaceDir,
    runLocation: extraData.runLocation,
    persistedDefault: legacyDefault === true || currentDefault === 1,
  });

  if (row.columnarVersion === CURRENT_COLUMNAR_VERSION) {
    const status = requireEnum(row.status, CURRENT_STATUSES, `Session ${row.sessionId}.status`);
    return {
      agentName: row.agentName,
      runtime,
      sessionType,
      status,
      archived,
      visibility: currentVisibility,
      sessionKind: currentKind,
      purpose: row.purpose,
      purposeKind: row.purposeKind,
      originCronId: row.originCronId,
      parentSessionId: row.parentSessionId,
      workspaceDir: row.workspaceDir,
      ...projectIdentity,
      title: row.title,
      createdAtMs: row.createdAtMs,
      errorMessage: row.errorMessage,
      errorCode: row.errorCode,
      extraDataJson: JSON.stringify(extraData),
    };
  }

  const legacyStatus = requireNullableEnum(
    row.status,
    LEGACY_STATUSES,
    `Session ${row.sessionId}.status`,
  );
  const sessionKind = deriveSessionKind({
    purpose: row.purpose,
    sessionType,
    parentSessionId: row.parentSessionId,
    originCronId: row.originCronId,
  });
  return {
    agentName: row.agentName,
    runtime,
    sessionType,
    status: normalizeStatus(legacyStatus),
    archived,
    visibility: migratedVisibility(sessionKind, currentVisibility),
    sessionKind,
    purpose: row.purpose,
    purposeKind: '',
    originCronId: row.originCronId,
    parentSessionId: row.parentSessionId,
    workspaceDir: row.workspaceDir,
    ...projectIdentity,
    title: row.title,
    createdAtMs: row.createdAtMs ?? row.updatedAtMs,
    errorMessage: row.errorMessage,
    errorCode: row.errorCode,
    extraDataJson: JSON.stringify(extraData),
  };
}

function parseLegacySessionRecord(raw: string): LegacySessionRecord {
  const record = parseJsonObject(raw, 'record_json');
  return {
    sessionId: readOptionalString(record, 'sessionId', 'record_json'),
    agentName: readOptionalString(record, 'agentName', 'record_json'),
    workspaceDir: readOptionalString(record, 'workspaceDir', 'record_json'),
    isDefaultWorkspace: readOptionalBoolean(record, 'isDefaultWorkspace', 'record_json'),
    runtime: readOptionalEnum(record, 'runtime', RUNTIMES, 'record_json'),
    sessionType: readLegacySessionType(record),
    sessionKind: readOptionalEnum(record, 'sessionKind', SESSION_KINDS, 'record_json'),
    archived: readOptionalBoolean(record, 'archived', 'record_json'),
    title: readOptionalNullableString(record, 'title', 'record_json'),
    parentSessionId: readOptionalNullableString(record, 'parentSessionId', 'record_json'),
    visibility: readOptionalEnum(record, 'visibility', VISIBILITIES, 'record_json'),
    purpose: readOptionalString(record, 'purpose', 'record_json'),
    originCronId: readOptionalString(record, 'originCronId', 'record_json'),
    runLocation: readLegacyRunLocation(record, 'runLocation', 'record_json'),
    appMode: readOptionalEnum(record, 'appMode', ['coding', 'work'], 'record_json'),
    status: readOptionalEnum(record, 'status', LEGACY_STATUSES, 'record_json'),
    errorMessage: readOptionalString(record, 'errorMessage', 'record_json'),
    errorCode: readOptionalSafeInteger(record, 'errorCode', 'record_json'),
    errorSource: readOptionalString(record, 'errorSource', 'record_json'),
    errorDetail: readOptionalString(record, 'errorDetail', 'record_json'),
    errorProviderId: readOptionalString(record, 'errorProviderId', 'record_json'),
    effectiveModel: readOptionalNullableString(record, 'effectiveModel', 'record_json'),
    effectiveModelVariant: readOptionalNullableString(
      record,
      'effectiveModelVariant',
      'record_json',
    ),
    scratchpadPath: readOptionalString(record, 'scratchpadPath', 'record_json'),
    origin: readOptionalEnum(record, 'origin', ['user', 'root-repair'], 'record_json'),
    sessionDataVersion: readOptionalSafeInteger(record, 'sessionDataVersion', 'record_json'),
    sessionOrigin: readOptionalEnum(
      record,
      'sessionOrigin',
      ['local-runtime', 'legacy-opencode', 'unknown'],
      'record_json',
    ),
    createdAtMs: readOptionalSafeInteger(record, 'createdAtMs', 'record_json'),
    updatedAtMs: readOptionalSafeInteger(record, 'updatedAtMs', 'record_json'),
  };
}

function parseCurrentExtraData(raw: string): SessionExtraData {
  const record = parseJsonObject(raw, 'extra_data_json');
  return compactExtraData({
    isDefaultWorkspace: readOptionalBoolean(record, 'isDefaultWorkspace', 'extra_data_json'),
    runLocation: readCurrentRunLocation(record, 'runLocation', 'extra_data_json'),
    appMode: readOptionalEnum(record, 'appMode', ['coding', 'work'], 'extra_data_json'),
    errorSource: readOptionalString(record, 'errorSource', 'extra_data_json'),
    errorDetail: readOptionalString(record, 'errorDetail', 'extra_data_json'),
    errorProviderId: readOptionalString(record, 'errorProviderId', 'extra_data_json'),
    effectiveModel: readOptionalNullableString(record, 'effectiveModel', 'extra_data_json'),
    effectiveModelVariant: readOptionalNullableString(
      record,
      'effectiveModelVariant',
      'extra_data_json',
    ),
    scratchpadPath: readOptionalString(record, 'scratchpadPath', 'extra_data_json'),
    origin: readOptionalEnum(record, 'origin', ['user', 'root-repair'], 'extra_data_json'),
    sessionDataVersion: readOptionalSafeInteger(record, 'sessionDataVersion', 'extra_data_json'),
    sessionOrigin: readOptionalEnum(
      record,
      'sessionOrigin',
      ['local-runtime', 'legacy-opencode', 'unknown'],
      'extra_data_json',
    ),
  });
}

function compactExtraData(data: SessionExtraData): SessionExtraData {
  return Object.fromEntries(
    Object.entries(data).filter((entry) => entry[1] !== undefined),
  ) as SessionExtraData;
}

function readLegacyRunLocation(
  record: Record<string, unknown>,
  key: string,
  field: string,
): LegacyRunLocationData | undefined {
  const value = readOptionalObject(record, key, field);
  if (!value) return undefined;
  const nested = `${field}.${key}`;
  return {
    mode: readOptionalEnum(value, 'mode', RUN_LOCATION_MODES, nested),
    resolvedDir: readOptionalString(value, 'resolvedDir', nested),
    resolvedBranch: readOptionalString(value, 'resolvedBranch', nested),
    parentRepoDir: readOptionalString(value, 'parentRepoDir', nested),
    createdAt: readOptionalSafeInteger(value, 'createdAt', nested),
  };
}

function readCurrentRunLocation(
  record: Record<string, unknown>,
  key: string,
  field: string,
): RunLocationData | undefined {
  const value = readLegacyRunLocation(record, key, field);
  if (!value) return undefined;
  if (!value.mode || !value.resolvedDir || value.createdAt === undefined) {
    throw new Error(`${field}.${key} must include mode, resolvedDir, and createdAt`);
  }
  return {
    mode: value.mode,
    resolvedDir: value.resolvedDir,
    ...(value.resolvedBranch ? { resolvedBranch: value.resolvedBranch } : {}),
    ...(value.parentRepoDir ? { parentRepoDir: value.parentRepoDir } : {}),
    createdAt: value.createdAt,
  };
}

function currentRunLocationFromLegacy(record: LegacySessionRecord): RunLocationData | undefined {
  const value = record.runLocation;
  const createdAt = value?.createdAt ?? record.createdAtMs ?? record.updatedAtMs;
  if (!value?.mode || !value.resolvedDir || createdAt === undefined) return undefined;
  return {
    mode: value.mode,
    resolvedDir: value.resolvedDir,
    ...(value.resolvedBranch ? { resolvedBranch: value.resolvedBranch } : {}),
    ...(value.parentRepoDir ? { parentRepoDir: value.parentRepoDir } : {}),
    createdAt,
  };
}

function normalizeStatus(value: LegacySessionStatus | null | undefined): SessionStatus {
  return value === undefined || value === null || value === 'finished' ? 'idle' : value;
}

function migratedVisibility(kind: SessionKind, value: SessionVisibility): SessionVisibility {
  if (kind === 'task') return 'visible';
  if (kind === 'peek' || kind === 'channel') return 'hidden';
  return value;
}

function deriveSessionKind(input: {
  readonly purpose?: string | null;
  readonly sessionType?: SessionType | null;
  readonly parentSessionId?: string | null;
  readonly originCronId?: string | null;
}): SessionKind {
  const purpose = input.purpose?.trim() ?? '';
  if (input.originCronId || purpose.startsWith('cron:')) return 'cron';
  if (isBranchChild(input) && startsWithOneOf(purpose, TASK_PURPOSE_PREFIXES)) return 'task';
  if (isBranchChild(input) && startsWithOneOf(purpose, PEEK_PURPOSE_PREFIXES)) return 'peek';
  if (startsWithOneOf(purpose, CHANNEL_PURPOSE_PREFIXES)) return 'channel';
  return purpose ? 'unknown' : 'conversation';
}

const TASK_PURPOSE_PREFIXES = ['local-task:', 'local-background-task:', 'team-plan:'] as const;
const PEEK_PURPOSE_PREFIXES = ['peek_', 'peek:'] as const;
const CHANNEL_PURPOSE_PREFIXES = ['channel:', 'im:'] as const;

function isBranchChild(input: {
  readonly sessionType?: SessionType | null;
  readonly parentSessionId?: string | null;
}): boolean {
  return input.sessionType === 'branch' && Boolean(input.parentSessionId);
}

function startsWithOneOf(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

type ProjectKind = 'default' | 'workspace';

interface ProjectIdentity {
  readonly kind: ProjectKind;
  readonly workspaceDir: string | null;
}

interface StoredProjectRow {
  readonly projectId: number;
  readonly projectKind: string | null;
  readonly workspaceDir: string | null;
  readonly pinned: 0 | 1;
  readonly hidden: 0 | 1;
  readonly orderIndex: number;
  readonly recentAtMs: number | null;
  readonly extraDataJson: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

interface ProjectState {
  pinned: 0 | 1;
  hidden: 0 | 1;
  orderIndex: number;
  recentAtMs: number | null;
}

interface ProjectGroup extends ProjectIdentity, ProjectState {
  projectId: number;
  extraDataJson: string;
  createdAtMs: number;
  updatedAtMs: number;
}

interface PreferenceState {
  readonly pinned?: boolean;
  readonly hidden?: boolean;
  readonly orderIndex?: number;
  readonly recentAtMs?: number;
}

interface ProjectPreferencePlan {
  readonly v1CompletedAtMs?: number;
  readonly states: ReadonlyMap<
    string,
    { readonly identity: ProjectIdentity; readonly state: PreferenceState }
  >;
}

function readProjectPreferencePlan(database: Database): ProjectPreferencePlan {
  const markers = database
    .prepare(
      `SELECT migration_key, completed_at_ms
       FROM local_runtime_project_migrations
       WHERE migration_key IN ('legacy-project-user-state-v1', 'legacy-project-user-state-v2')
       ORDER BY migration_key`,
    )
    .all();
  let v1CompletedAtMs: number | undefined;
  let alreadyMigrated = false;
  for (const marker of markers) {
    const key = readString(marker, 'migration_key', 'local_runtime_project_migrations');
    const completedAtMs = readInteger(
      marker,
      'completed_at_ms',
      'local_runtime_project_migrations',
    );
    if (key === 'legacy-project-user-state-v1') v1CompletedAtMs = completedAtMs;
    if (key === 'legacy-project-user-state-v2') alreadyMigrated = true;
  }
  if (alreadyMigrated) return { states: new Map() };

  const row = database
    .prepare(
      `SELECT value_json
       FROM local_runtime_preferences
       WHERE key = 'project-user-state'`,
    )
    .all()[0];
  if (row === undefined) return { v1CompletedAtMs, states: new Map() };
  const raw = readString(row, 'value_json', 'local_runtime_preferences');
  const parsed = parseJsonObject(raw, 'project-user-state preference');
  const result = new Map<
    string,
    { readonly identity: ProjectIdentity; readonly state: PreferenceState }
  >();
  for (const [key, value] of Object.entries(parsed).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const identity = preferenceProjectIdentity(key);
    if (!identity) continue;
    if (!isPlainObject(value)) {
      throw new Error(`project-user-state entry must be an object: ${key}`);
    }
    const state = readPreferenceState(value, key);
    const identityKey = projectIdentityKey(identity);
    result.set(identityKey, {
      identity,
      state: { ...result.get(identityKey)?.state, ...state },
    });
  }
  return { v1CompletedAtMs, states: result };
}

function preferenceProjectIdentity(key: string): ProjectIdentity | undefined {
  if (key === 'default') return { kind: 'default', workspaceDir: null };
  if (!key.startsWith('workspace:')) return undefined;
  const workspaceDir = canonicalProjectWorkspaceDir(key.slice('workspace:'.length));
  if (!workspaceDir) throw new Error(`project-user-state workspace is not absolute: ${key}`);
  return { kind: 'workspace', workspaceDir };
}

function readPreferenceState(value: Record<string, unknown>, key: string): PreferenceState {
  const context = `project-user-state.${key}`;
  const pinned = readOptionalBoolean(value, 'pinned', context);
  const hidden = readOptionalBoolean(value, 'hidden', context);
  const orderIndex = readOptionalSafeInteger(value, 'orderIndex', context);
  const recentAtMs = readOptionalSafeInteger(value, 'recentAt', context);
  return {
    ...(pinned === undefined ? {} : { pinned }),
    ...(hidden === undefined ? {} : { hidden }),
    ...(orderIndex === undefined ? {} : { orderIndex }),
    ...(recentAtMs === undefined ? {} : { recentAtMs }),
  };
}

function rebuildProjects(database: Database, plan: ProjectPreferencePlan): void {
  const historicalSequence = readProjectSequenceHighWater(database);
  const storedRows = readStoredProjects(database);
  const groups = mergeProjectRows(storedRows);
  const previousHighWater = Math.max(
    historicalSequence,
    0,
    ...storedRows.map(({ projectId }) => projectId),
  );
  if (previousHighWater >= Number.MAX_SAFE_INTEGER - 1) {
    throw new Error('Cannot allocate a safe Project id beyond the historical high-water');
  }
  const allocator = {
    nextProjectId: previousHighWater + 1,
  };
  applyProjectPreferences(groups, plan, allocator);
  const sessions = readProjectSessions(database);
  addMissingSessionProjects(groups, sessions, allocator);
  replaceProjectCatalog(database, groups, historicalSequence);
  assignSessionProjects(database, groups, sessions);
  database.prepare(FROZEN_PROJECT_AGGREGATE_REBUILD_SQL).run();
  database.exec(FROZEN_PROJECT_INDEXES_SQL);
  database.exec(FROZEN_PROJECT_TRIGGERS_SQL);
}

function readProjectSequenceHighWater(database: Database): number {
  const rows = database
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'local_runtime_projects'")
    .all();
  if (rows.length > 1) {
    throw new Error('sqlite_sequence has duplicate local_runtime_projects rows');
  }
  const row = rows[0];
  if (row === undefined) return 0;
  const sequence = readInteger(row, 'seq', 'sqlite_sequence.local_runtime_projects');
  if (sequence < 0) {
    throw new Error('sqlite_sequence.local_runtime_projects.seq must be nonnegative');
  }
  return sequence;
}

function readStoredProjects(database: Database): StoredProjectRow[] {
  return database
    .prepare(
      `SELECT project_id, project_kind, workspace_dir, pinned, hidden, order_index,
              recent_at_ms, extra_data_json, created_at_ms, updated_at_ms
       FROM local_runtime_projects
       ORDER BY project_id ASC`,
    )
    .all()
    .map(readStoredProjectRow);
}

interface ProjectIdAllocator {
  nextProjectId: number;
}

function applyProjectPreferences(
  groups: Map<string, ProjectGroup>,
  plan: ProjectPreferencePlan,
  allocator: ProjectIdAllocator,
): void {
  for (const { identity, state } of [...plan.states.values()].sort((left, right) =>
    projectIdentityKey(left.identity).localeCompare(projectIdentityKey(right.identity)),
  )) {
    const key = projectIdentityKey(identity);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, preferenceOnlyProject(identity, state, allocateProjectId(allocator)));
      continue;
    }
    if (canApplyPreference(existing, plan.v1CompletedAtMs)) applyPreferenceState(existing, state);
  }
}

function addMissingSessionProjects(
  groups: Map<string, ProjectGroup>,
  sessions: readonly ProjectSession[],
  allocator: ProjectIdAllocator,
): void {
  const missingIdentities = new Map<
    string,
    { readonly identity: ProjectIdentity; timestamp: number }
  >();
  for (const session of sessions) {
    const identity = projectIdentityForSession(session);
    if (!identity) continue;
    const key = projectIdentityKey(identity);
    if (groups.has(key)) continue;
    const timestamp = session.createdAtMs ?? session.updatedAtMs;
    const current = missingIdentities.get(key);
    if (current) {
      current.timestamp = Math.min(current.timestamp, timestamp);
    } else {
      missingIdentities.set(key, { identity, timestamp });
    }
  }
  for (const [key, { identity, timestamp }] of [...missingIdentities.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    groups.set(key, {
      ...identity,
      projectId: allocateProjectId(allocator),
      pinned: 0,
      hidden: 0,
      orderIndex: DEFAULT_PROJECT_ORDER_INDEX,
      recentAtMs: null,
      extraDataJson: '{}',
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
    });
  }
}

function replaceProjectCatalog(
  database: Database,
  groups: ReadonlyMap<string, ProjectGroup>,
  historicalSequence: number,
): void {
  database.exec(`
    DROP TABLE IF EXISTS local_runtime_projects_m0006;
    CREATE TABLE local_runtime_projects_m0006 (
      project_id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_kind TEXT NOT NULL CHECK(project_kind IN ('default', 'workspace')),
      workspace_dir TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      order_index INTEGER NOT NULL DEFAULT 2147483647,
      recent_at_ms INTEGER,
      latest_activity_at_ms INTEGER NOT NULL DEFAULT 0,
      session_count INTEGER NOT NULL DEFAULT 0,
      extra_data_json TEXT NOT NULL DEFAULT '{}',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      CHECK (
        (project_kind = 'default' AND workspace_dir IS NULL)
        OR (project_kind = 'workspace' AND workspace_dir IS NOT NULL AND trim(workspace_dir) <> '')
      )
    );
  `);
  const insert = database.prepare(
    `INSERT INTO local_runtime_projects_m0006(
       project_id, project_kind, workspace_dir, pinned, hidden, order_index, recent_at_ms,
       latest_activity_at_ms, session_count, extra_data_json, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
  );
  for (const group of [...groups.values()].sort(
    (left, right) => left.projectId - right.projectId,
  )) {
    insert.run(
      group.projectId,
      group.kind,
      group.workspaceDir,
      group.pinned,
      group.hidden,
      group.orderIndex,
      group.recentAtMs,
      group.extraDataJson,
      group.createdAtMs,
      group.updatedAtMs,
    );
  }
  database.exec(`
    DROP TABLE local_runtime_projects;
    ALTER TABLE local_runtime_projects_m0006 RENAME TO local_runtime_projects;
  `);
  const restoredSequence = Math.max(
    historicalSequence,
    0,
    ...[...groups.values()].map(({ projectId }) => projectId),
  );
  database
    .prepare(
      `DELETE FROM sqlite_sequence
       WHERE name IN ('local_runtime_projects', 'local_runtime_projects_m0006')`,
    )
    .run();
  if (restoredSequence > 0) {
    database
      .prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('local_runtime_projects', ?)")
      .run(restoredSequence);
  }
}

function assignSessionProjects(
  database: Database,
  groups: ReadonlyMap<string, ProjectGroup>,
  sessions: readonly ProjectSession[],
): void {
  const assign = database.prepare(
    'UPDATE local_runtime_sessions SET project_id = ? WHERE session_id = ?',
  );
  for (const session of sessions) {
    const identity = projectIdentityForSession(session);
    const projectId = identity ? groups.get(projectIdentityKey(identity))?.projectId : undefined;
    assign.run(projectId ?? 0, session.sessionId);
  }
}

function preferenceOnlyProject(
  identity: ProjectIdentity,
  state: PreferenceState,
  projectId: number,
): ProjectGroup {
  const timestamp = state.recentAtMs ?? 0;
  return {
    ...identity,
    projectId,
    pinned: booleanBit(state.pinned),
    hidden: booleanBit(state.hidden),
    orderIndex: state.orderIndex ?? DEFAULT_PROJECT_ORDER_INDEX,
    recentAtMs: state.recentAtMs ?? null,
    extraDataJson: '{}',
    createdAtMs: timestamp,
    updatedAtMs: timestamp,
  };
}

function canApplyPreference(project: ProjectGroup, completedAtMs: number | undefined): boolean {
  if (completedAtMs === undefined) return true;
  return isDefaultProjectState(project) && project.updatedAtMs <= completedAtMs;
}

function applyPreferenceState(project: ProjectGroup, state: PreferenceState): void {
  // The B preference is the complete user-state SoT, not a patch over transitional H rows.
  project.pinned = booleanBit(state.pinned);
  project.hidden = booleanBit(state.hidden);
  project.orderIndex = state.orderIndex ?? DEFAULT_PROJECT_ORDER_INDEX;
  project.recentAtMs = state.recentAtMs ?? null;
}

function allocateProjectId(allocator: ProjectIdAllocator): number {
  const value = allocator.nextProjectId;
  if (!Number.isSafeInteger(value) || value <= 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Cannot allocate a safe Project id');
  }
  allocator.nextProjectId += 1;
  return value;
}

function readStoredProjectRow(value: unknown): StoredProjectRow {
  const extraDataJson = readString(value, 'extra_data_json', 'local_runtime_projects');
  parseJsonObject(extraDataJson, 'local_runtime_projects.extra_data_json');
  const projectId = readInteger(value, 'project_id', 'local_runtime_projects');
  if (projectId <= 0) {
    throw new Error('local_runtime_projects.project_id must be a positive safe integer');
  }
  return {
    projectId,
    projectKind: readNullableString(value, 'project_kind', 'local_runtime_projects'),
    workspaceDir: readNullableString(value, 'workspace_dir', 'local_runtime_projects'),
    pinned: requireBit(
      readInteger(value, 'pinned', 'local_runtime_projects'),
      'local_runtime_projects.pinned',
    ),
    hidden: requireBit(
      readInteger(value, 'hidden', 'local_runtime_projects'),
      'local_runtime_projects.hidden',
    ),
    orderIndex: readInteger(value, 'order_index', 'local_runtime_projects'),
    recentAtMs: readNullableInteger(value, 'recent_at_ms', 'local_runtime_projects'),
    extraDataJson,
    createdAtMs: readInteger(value, 'created_at_ms', 'local_runtime_projects'),
    updatedAtMs: readInteger(value, 'updated_at_ms', 'local_runtime_projects'),
  };
}

function mergeProjectRows(rows: readonly StoredProjectRow[]): Map<string, ProjectGroup> {
  const grouped = new Map<string, StoredProjectRow[]>();
  for (const row of rows) {
    const identity = projectIdentityForStoredRow(row);
    const key = projectIdentityKey(identity);
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }
  const result = new Map<string, ProjectGroup>();
  for (const [key, candidates] of grouped) {
    const identity = projectIdentityForStoredRow(requireItem(candidates, 0, key));
    const finalized = candidates
      .filter((row) => storedProjectIdentityIsCanonical(row, identity))
      .sort((left, right) => left.projectId - right.projectId)[0];
    const exactWorkspace = candidates
      .filter((row) => storedProjectWorkspaceIsCanonical(row, identity))
      .sort((left, right) => left.projectId - right.projectId)[0];
    const target =
      finalized ??
      exactWorkspace ??
      [...candidates].sort((left, right) => left.projectId - right.projectId)[0];
    if (!target) throw new Error(`Project identity ${key} has no source row`);
    result.set(key, {
      ...identity,
      projectId: target.projectId,
      pinned: candidates.some(({ pinned }) => pinned === 1) ? 1 : 0,
      hidden: candidates.some(({ hidden }) => hidden === 1) ? 1 : 0,
      orderIndex: Math.min(...candidates.map(({ orderIndex }) => orderIndex)),
      recentAtMs: maxNullable(candidates.map(({ recentAtMs }) => recentAtMs)),
      extraDataJson: target.extraDataJson,
      createdAtMs: Math.min(...candidates.map(({ createdAtMs }) => createdAtMs)),
      updatedAtMs: Math.max(...candidates.map(({ updatedAtMs }) => updatedAtMs)),
    });
  }
  return result;
}

function projectIdentityForStoredRow(row: StoredProjectRow): ProjectIdentity {
  const trimmedWorkspace = row.workspaceDir?.trim() ?? '';
  if (row.projectKind === 'default') {
    if (trimmedWorkspace) throw new Error('Default Project has a non-null workspace_dir');
    return { kind: 'default', workspaceDir: null };
  }
  if (row.projectKind !== null && row.projectKind !== 'workspace') {
    throw new Error(`Invalid Project kind: ${row.projectKind}`);
  }
  if (!trimmedWorkspace) return { kind: 'default', workspaceDir: null };
  const workspaceDir = canonicalProjectWorkspaceDir(trimmedWorkspace);
  if (!workspaceDir) throw new Error(`Project workspace is not absolute: ${trimmedWorkspace}`);
  return { kind: 'workspace', workspaceDir };
}

function storedProjectWorkspaceIsCanonical(
  row: StoredProjectRow,
  identity: ProjectIdentity,
): boolean {
  if (identity.kind === 'default') return !row.workspaceDir?.trim();
  return row.workspaceDir === identity.workspaceDir;
}

function storedProjectIdentityIsCanonical(
  row: StoredProjectRow,
  identity: ProjectIdentity,
): boolean {
  if (identity.kind === 'default') {
    return row.projectKind === 'default' && !row.workspaceDir?.trim();
  }
  return row.projectKind === 'workspace' && row.workspaceDir === identity.workspaceDir;
}

function isDefaultProjectState(project: ProjectGroup): boolean {
  return (
    project.pinned === 0 &&
    project.hidden === 0 &&
    project.orderIndex === DEFAULT_PROJECT_ORDER_INDEX &&
    project.recentAtMs === null
  );
}

interface ProjectSession {
  readonly sessionId: string;
  readonly projectWorkspaceDir: string | null;
  readonly isDefaultWorkspace: 0 | 1;
  readonly createdAtMs: number | null;
  readonly updatedAtMs: number;
}

function readProjectSessions(database: Database): ProjectSession[] {
  return database
    .prepare(
      `SELECT session_id, project_workspace_dir, is_default_workspace,
              created_at_ms, updated_at_ms
       FROM local_runtime_sessions
       WHERE columnar_version = 3
       ORDER BY session_id ASC`,
    )
    .all()
    .map((row) => ({
      sessionId: readString(row, 'session_id', 'local_runtime_sessions'),
      projectWorkspaceDir: readNullableString(
        row,
        'project_workspace_dir',
        'local_runtime_sessions',
      ),
      isDefaultWorkspace: requireBit(
        readInteger(row, 'is_default_workspace', 'local_runtime_sessions'),
        'local_runtime_sessions.is_default_workspace',
      ),
      createdAtMs: readNullableInteger(row, 'created_at_ms', 'local_runtime_sessions'),
      updatedAtMs: readInteger(row, 'updated_at_ms', 'local_runtime_sessions'),
    }));
}

function projectIdentityForSession(session: ProjectSession): ProjectIdentity | undefined {
  if (session.isDefaultWorkspace === 1) return { kind: 'default', workspaceDir: null };
  if (!session.projectWorkspaceDir?.trim()) return undefined;
  const workspaceDir = canonicalProjectWorkspaceDir(session.projectWorkspaceDir);
  if (!workspaceDir) {
    throw new Error(
      `Session ${session.sessionId} has an invalid project_workspace_dir: ${session.projectWorkspaceDir}`,
    );
  }
  return { kind: 'workspace', workspaceDir };
}

function projectIdentityKey(identity: ProjectIdentity): string {
  return identity.kind === 'default' ? 'default' : `workspace:${identity.workspaceDir}`;
}

function maxNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? Math.max(...present) : null;
}

function dropProjectTriggers(database: Database): void {
  for (const name of FROZEN_PROJECT_TRIGGER_NAMES) {
    database.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
}

function readEligibleFtsRowId(value: unknown): number | undefined {
  const rowId = readField(value, 'fts_rowid', 'local_runtime_sessions_fts');
  return typeof rowId === 'number' && Number.isSafeInteger(rowId) && rowId > 0 ? rowId : undefined;
}

function assertSessionFtsAllocatorHasSafeHeadroom(database: Database): void {
  const sequenceRows = database
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'local_runtime_session_fts_keys'")
    .all();
  if (sequenceRows.length > 1) {
    throw new Error('sqlite_sequence has duplicate local_runtime_session_fts_keys rows');
  }
  const sequence = sequenceRows[0]
    ? readInteger(sequenceRows[0], 'seq', 'sqlite_sequence.local_runtime_session_fts_keys')
    : 0;
  if (sequence < 0) {
    throw new Error('sqlite_sequence.local_runtime_session_fts_keys.seq must be nonnegative');
  }
  const maximumRow = database
    .prepare('SELECT MAX(fts_rowid) AS max_fts_rowid FROM local_runtime_session_fts_keys')
    .all()[0];
  if (!maximumRow) throw new Error('Session FTS allocator query returned no row');
  const maximumRowId = readNullableInteger(
    maximumRow,
    'max_fts_rowid',
    'local_runtime_session_fts_keys',
  );
  if (Math.max(sequence, maximumRowId ?? 0) >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Session FTS allocator has no safe future allocation');
  }
}
