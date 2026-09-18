import type { DatabaseClient } from './client.js';

interface SessionBackfillRow {
  readonly rowId: number;
  readonly sessionId: string;
  readonly recordJson: string;
  readonly columnarVersion: number;
  readonly runtime: string | null;
  readonly sessionType: string | null;
  readonly status: string | null;
  readonly archived: number;
  readonly visibility: string;
  readonly sessionKind: string;
  readonly isDefaultWorkspace: number;
  readonly extraDataJson: string;
  readonly recoveredRecordJson?: string;
}

interface SessionRecoveryPlan {
  readonly rowId: number;
  readonly action: 'unchanged' | 'recovered' | 'degraded';
  readonly recordJson?: string;
  readonly extraDataJson?: string;
}

interface SessionRecoveryResult {
  readonly recoveredCount: number;
  readonly degradedCount: number;
}

const OPTIONAL_STRING_FIELDS = [
  'agentName',
  'workspaceDir',
  'title',
  'parentSessionId',
  'purpose',
  'originCronId',
  'errorMessage',
  'errorSource',
  'errorDetail',
  'errorProviderId',
  'effectiveModel',
  'effectiveModelVariant',
  'scratchpadPath',
] as const;

const OPTIONAL_INTEGER_FIELDS = [
  'errorCode',
  'sessionDataVersion',
  'createdAtMs',
  'updatedAtMs',
] as const;

const OPTIONAL_ENUM_FIELDS: ReadonlyArray<readonly [field: string, allowed: readonly string[]]> = [
  ['runtime', ['pi-agent', 'opencode']],
  ['sessionType', ['root', 'branch', 'task']],
  ['sessionKind', ['conversation', 'task', 'peek', 'channel', 'cron', 'unknown']],
  ['visibility', ['visible', 'hidden']],
  ['appMode', ['coding', 'work']],
  ['status', ['idle', 'started', 'error', 'aborted', 'interrupted', 'finished']],
  ['origin', ['user', 'root-repair']],
  ['sessionOrigin', ['local-runtime', 'legacy-opencode', 'unknown']],
];

const CURRENT_COLUMNAR_VERSION = 3;
// These codecs mirror the immutable migration 0007 contract so row-local data errors can be
// degraded before the frozen all-or-nothing backfill runs. SQL and schema errors still escape.
const CURRENT_STATUSES = ['idle', 'started', 'error', 'aborted', 'interrupted'] as const;
const LEGACY_STATUSES = [...CURRENT_STATUSES, 'finished'] as const;
const SESSION_KINDS = ['conversation', 'task', 'peek', 'channel', 'cron', 'unknown'] as const;
const RUNTIMES = ['pi-agent', 'opencode'] as const;
const SESSION_TYPES = ['root', 'branch', 'task'] as const;
const VISIBILITIES = ['visible', 'hidden'] as const;
const RUN_LOCATION_MODES = ['current', 'new-worktree', 'existing-worktree'] as const;
const CURRENT_EXTRA_ENUM_FIELDS: ReadonlyArray<
  readonly [field: string, allowed: readonly string[]]
> = [
  ['appMode', ['coding', 'work']],
  ['origin', ['user', 'root-repair']],
  ['sessionOrigin', ['local-runtime', 'legacy-opencode', 'unknown']],
];
const DEGRADED_SESSION_ERROR_MESSAGE = 'Legacy Session metadata was degraded during migration';

class SessionRowDataError extends Error {}

/**
 * Version 7 is already published. Recover optional legacy metadata before the frozen migration
 * sees it so one malformed Session record cannot block every Session and runtime startup.
 */
export function recoverLegacySessionRecordsBeforeBackfill(options: {
  readonly database: DatabaseClient;
  readonly version7Pending: boolean;
}): SessionRecoveryResult {
  if (!options.version7Pending || !tableExists(options.database, 'local_runtime_sessions'))
    return { recoveredCount: 0, degradedCount: 0 };

  const plans = readSessionRecoveryPlans(options.database);
  const recoveredRows = plans.filter(
    (plan): plan is SessionRecoveryPlan & { readonly recordJson: string } =>
      plan.action === 'recovered' && plan.recordJson !== undefined,
  );
  const degradedRows = plans.filter(
    (
      plan,
    ): plan is SessionRecoveryPlan & {
      readonly recordJson: string;
      readonly extraDataJson: string;
    } =>
      plan.action === 'degraded' &&
      plan.recordJson !== undefined &&
      plan.extraDataJson !== undefined,
  );
  if (recoveredRows.length === 0 && degradedRows.length === 0) {
    return { recoveredCount: 0, degradedCount: 0 };
  }

  const update = options.database.rawDb.prepare(
    'UPDATE local_runtime_sessions SET record_json = ? WHERE rowid = ?',
  );
  const degrade = options.database.rawDb.prepare(
    `UPDATE local_runtime_sessions
     SET record_json = ?,
         updated_at_ms = CASE
           WHEN typeof(updated_at_ms) = 'integer'
             AND updated_at_ms BETWEEN -9007199254740991 AND 9007199254740991
           THEN updated_at_ms ELSE 0 END,
         columnar_version = 3,
         agent_name = CASE WHEN typeof(agent_name) IN ('text', 'null') THEN agent_name ELSE NULL END,
         runtime = CASE WHEN runtime IN ('pi-agent', 'opencode') THEN runtime ELSE 'pi-agent' END,
         session_type = CASE
           WHEN session_type IN ('root', 'branch', 'task') THEN session_type ELSE 'branch' END,
         status = 'error', archived = 1, visibility = 'hidden',
         session_kind = CASE
           WHEN session_kind IN ('conversation', 'task', 'peek', 'channel', 'cron', 'unknown')
           THEN session_kind ELSE 'unknown' END,
         purpose = CASE WHEN typeof(purpose) IN ('text', 'null') THEN purpose ELSE NULL END,
         purpose_kind = CASE WHEN typeof(purpose_kind) = 'text' THEN purpose_kind ELSE '' END,
         origin_cron_id = CASE
           WHEN typeof(origin_cron_id) IN ('text', 'null') THEN origin_cron_id ELSE NULL END,
         parent_session_id = CASE
           WHEN typeof(parent_session_id) IN ('text', 'null') THEN parent_session_id ELSE NULL END,
         workspace_dir = CASE
           WHEN typeof(workspace_dir) IN ('text', 'null') THEN workspace_dir ELSE NULL END,
         is_default_workspace = CASE
           WHEN is_default_workspace = 0 THEN 0
           WHEN is_default_workspace = 1 THEN 1 ELSE 1 END,
         title = CASE WHEN typeof(title) IN ('text', 'null') THEN title ELSE NULL END,
         created_at_ms = CASE
           WHEN typeof(created_at_ms) = 'integer'
             AND created_at_ms BETWEEN -9007199254740991 AND 9007199254740991
           THEN created_at_ms
           WHEN typeof(updated_at_ms) = 'integer'
             AND updated_at_ms BETWEEN -9007199254740991 AND 9007199254740991
           THEN updated_at_ms ELSE 0 END,
         error_message = ?,
         error_code = CASE
           WHEN typeof(error_code) = 'integer'
             AND error_code BETWEEN -9007199254740991 AND 9007199254740991
           THEN error_code ELSE NULL END,
         extra_data_json = ?
     WHERE rowid = ?`,
  );
  options.database.rawDb.transaction(() => {
    recoveredRows.forEach((row) => update.run(row.recordJson, row.rowId));
    degradedRows.forEach((row) =>
      degrade.run(row.recordJson, DEGRADED_SESSION_ERROR_MESSAGE, row.extraDataJson, row.rowId),
    );
  })();
  return { recoveredCount: recoveredRows.length, degradedCount: degradedRows.length };
}

function readSessionRecoveryPlans(database: DatabaseClient): readonly SessionRecoveryPlan[] {
  return database.rawDb
    .prepare(
      `SELECT rowid, session_id, record_json, updated_at_ms, columnar_version,
              agent_name, runtime, session_type, status, archived, visibility, session_kind,
              purpose, purpose_kind, origin_cron_id, parent_session_id, workspace_dir,
              is_default_workspace, title, created_at_ms, error_message, error_code,
              extra_data_json
       FROM local_runtime_sessions
       ORDER BY rowid`,
    )
    .all()
    .map(planSessionRecovery);
}

function readSessionBackfillRow(value: unknown): SessionBackfillRow {
  const sessionId = readSessionString(value, 'session_id');
  const columnarVersion = readSessionInteger(value, 'columnar_version');
  const rawRecordJson = readSessionField(value, 'record_json');
  const recoveredRecordJson =
    columnarVersion < 2 ? recoverRecordJson(rawRecordJson, sessionId) : undefined;
  validateUnusedPhysicalColumns(value);
  return {
    rowId: readPositiveRowId(value),
    sessionId,
    recordJson: recoveredRecordJson ?? readSessionString(value, 'record_json'),
    columnarVersion,
    runtime: readSessionNullableString(value, 'runtime'),
    sessionType: readSessionNullableString(value, 'session_type'),
    status: readSessionNullableString(value, 'status'),
    archived: readSessionInteger(value, 'archived'),
    visibility: readSessionString(value, 'visibility'),
    sessionKind: readSessionString(value, 'session_kind'),
    isDefaultWorkspace: readSessionInteger(value, 'is_default_workspace'),
    extraDataJson: readSessionString(value, 'extra_data_json'),
    ...(recoveredRecordJson === undefined ? {} : { recoveredRecordJson }),
  };
}

function planSessionRecovery(value: unknown): SessionRecoveryPlan {
  const rowId = readPositiveRowId(value);
  const sessionId = readRequiredSessionId(value);
  try {
    const row = readSessionBackfillRow(value);
    assertSessionRowMigratable(row);
    return row.recoveredRecordJson === undefined
      ? { rowId: row.rowId, action: 'unchanged' }
      : { rowId: row.rowId, action: 'recovered', recordJson: row.recoveredRecordJson };
  } catch (error) {
    if (!(error instanceof SessionRowDataError)) throw error;
    return {
      rowId,
      action: 'degraded',
      recordJson: recoverDegradedRecordJson(value, sessionId),
      extraDataJson: recoverDegradedExtraDataJson(value),
    };
  }
}

function readRequiredSessionId(value: unknown): string {
  const sessionId = readField(value, 'session_id');
  if (typeof sessionId !== 'string') {
    throw new Error('Legacy Session recovery cannot preserve an invalid session_id');
  }
  return sessionId;
}

function recoverDegradedRecordJson(value: unknown, sessionId: string): string {
  const raw = readField(value, 'record_json');
  return (
    recoverRecordJson(raw, sessionId) ??
    (typeof raw === 'string' ? raw : JSON.stringify({ sessionId }))
  );
}

function recoverDegradedExtraDataJson(value: unknown): string {
  const raw = readField(value, 'extra_data_json');
  if (typeof raw !== 'string') return '{}';
  try {
    assertCurrentExtraData(raw);
    return raw;
  } catch (error) {
    if (!(error instanceof SessionRowDataError)) throw error;
    return '{}';
  }
}

function readPositiveRowId(value: unknown): number {
  const rowId = readField(value, 'rowid');
  if (typeof rowId !== 'number' || !Number.isSafeInteger(rowId) || rowId <= 0) {
    throw new Error('Legacy Session recovery encountered an invalid rowid');
  }
  return rowId;
}

function assertSessionRowMigratable(row: SessionBackfillRow): void {
  if (row.columnarVersion < 0 || row.columnarVersion > CURRENT_COLUMNAR_VERSION) {
    throw new SessionRowDataError('unsupported columnar_version');
  }
  if (row.columnarVersion < 2) {
    if (!parseRecord(row.recordJson)) throw new SessionRowDataError('invalid record_json');
    return;
  }
  requireAllowed(row.runtime, RUNTIMES, 'runtime');
  requireAllowed(row.sessionType, SESSION_TYPES, 'session_type');
  requireBit(row.archived, 'archived');
  requireAllowed(row.visibility, VISIBILITIES, 'visibility');
  requireAllowed(row.sessionKind, SESSION_KINDS, 'session_kind');
  requireBit(row.isDefaultWorkspace, 'is_default_workspace');
  assertCurrentExtraData(row.extraDataJson);
  if (row.columnarVersion === CURRENT_COLUMNAR_VERSION) {
    requireAllowed(row.status, CURRENT_STATUSES, 'status');
  } else if (row.status !== null) {
    requireAllowed(row.status, LEGACY_STATUSES, 'status');
  }
}

function validateUnusedPhysicalColumns(value: unknown): void {
  readSessionInteger(value, 'updated_at_ms');
  readSessionNullableString(value, 'agent_name');
  readSessionNullableString(value, 'purpose');
  readSessionString(value, 'purpose_kind');
  readSessionNullableString(value, 'origin_cron_id');
  readSessionNullableString(value, 'parent_session_id');
  readSessionNullableString(value, 'workspace_dir');
  readSessionNullableString(value, 'title');
  readSessionNullableInteger(value, 'created_at_ms');
  readSessionNullableString(value, 'error_message');
  readSessionNullableInteger(value, 'error_code');
}

function assertCurrentExtraData(raw: string): void {
  const record = parseRecord(raw);
  if (!record) throw new SessionRowDataError('invalid extra_data_json');
  ['isDefaultWorkspace'].forEach((field) => assertOptionalBoolean(record, field));
  [
    'errorSource',
    'errorDetail',
    'errorProviderId',
    'effectiveModel',
    'effectiveModelVariant',
    'scratchpadPath',
  ].forEach((field) => assertOptionalString(record, field));
  ['sessionDataVersion'].forEach((field) => assertOptionalInteger(record, field));
  CURRENT_EXTRA_ENUM_FIELDS.forEach(([field, allowed]) =>
    assertOptionalAllowed(record, field, allowed),
  );
  assertCurrentRunLocation(record);
}

function assertCurrentRunLocation(record: Record<string, unknown>): void {
  const value = record.runLocation;
  if (value === undefined || value === null) return;
  if (!isPlainObject(value)) throw new SessionRowDataError('runLocation must be an object');
  assertOptionalAllowed(value, 'mode', RUN_LOCATION_MODES);
  ['resolvedDir', 'resolvedBranch', 'parentRepoDir'].forEach((field) =>
    assertOptionalString(value, field),
  );
  assertOptionalInteger(value, 'createdAt');
  if (!value.mode || !value.resolvedDir || value.createdAt === undefined) {
    throw new SessionRowDataError('runLocation is incomplete');
  }
}

function assertOptionalBoolean(record: Record<string, unknown>, field: string): void {
  const value = record[field];
  if (value !== undefined && value !== null && typeof value !== 'boolean') {
    throw new SessionRowDataError(`${field} must be a boolean`);
  }
}

function assertOptionalString(record: Record<string, unknown>, field: string): void {
  const value = record[field];
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new SessionRowDataError(`${field} must be a string`);
  }
}

function assertOptionalInteger(record: Record<string, unknown>, field: string): void {
  const value = record[field];
  if (value !== undefined && value !== null && !Number.isSafeInteger(value)) {
    throw new SessionRowDataError(`${field} must be a safe integer`);
  }
}

function assertOptionalAllowed(
  record: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
): void {
  const value = record[field];
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new SessionRowDataError(`${field} has an unsupported value`);
  }
}

function requireAllowed(value: string | null, allowed: readonly string[], field: string): void {
  if (value === null || !allowed.includes(value)) {
    throw new SessionRowDataError(`${field} has an unsupported value`);
  }
}

function requireBit(value: number, field: string): void {
  if (value !== 0 && value !== 1) throw new SessionRowDataError(`${field} must be 0 or 1`);
}

function readSessionField(value: unknown, field: string): unknown {
  if (!isPlainObject(value) || !Object.hasOwn(value, field)) {
    throw new SessionRowDataError(`Session row is missing ${field}`);
  }
  return value[field];
}

function readSessionString(value: unknown, field: string): string {
  const result = readSessionField(value, field);
  if (typeof result !== 'string') throw new SessionRowDataError(`${field} must be a string`);
  return result;
}

function readSessionNullableString(value: unknown, field: string): string | null {
  const result = readSessionField(value, field);
  if (result === null) return null;
  if (typeof result !== 'string') {
    throw new SessionRowDataError(`${field} must be a string or null`);
  }
  return result;
}

function readSessionInteger(value: unknown, field: string): number {
  const result = readSessionField(value, field);
  if (typeof result !== 'number' || !Number.isSafeInteger(result)) {
    throw new SessionRowDataError(`${field} must be a safe integer`);
  }
  return result;
}

function readSessionNullableInteger(value: unknown, field: string): number | null {
  const result = readSessionField(value, field);
  if (result === null) return null;
  if (typeof result !== 'number' || !Number.isSafeInteger(result)) {
    throw new SessionRowDataError(`${field} must be a safe integer or null`);
  }
  return result;
}

function recoverRecordJson(raw: unknown, sessionId: string): string | undefined {
  const parsed = parseRecord(raw);
  if (!parsed) return JSON.stringify({ sessionId });

  const record = { ...parsed };
  const changed = [
    recoverSessionIdentity(record, sessionId),
    ...(['isDefaultWorkspace', 'archived'] as const).map((field) =>
      recoverOptionalBoolean(record, field),
    ),
    ...OPTIONAL_STRING_FIELDS.map((field) =>
      dropInvalidOptionalField(record, field, (value) => typeof value === 'string'),
    ),
    ...OPTIONAL_INTEGER_FIELDS.map((field) =>
      dropInvalidOptionalField(record, field, Number.isSafeInteger),
    ),
    ...OPTIONAL_ENUM_FIELDS.map(([field, allowed]) =>
      dropInvalidOptionalField(
        record,
        field,
        (value) => typeof value === 'string' && allowed.includes(value),
      ),
    ),
    recoverRunLocation(record),
  ].some(Boolean);
  return changed ? JSON.stringify(record) : undefined;
}

function recoverSessionIdentity(record: Record<string, unknown>, sessionId: string): boolean {
  if (!Object.hasOwn(record, 'sessionId')) return false;
  const value = record.sessionId;
  if (value === undefined || value === null || value === sessionId) return false;
  record.sessionId = sessionId;
  return true;
}

function recoverOptionalBoolean(record: Record<string, unknown>, field: string): boolean {
  if (!Object.hasOwn(record, field)) return false;
  const value = record[field];
  if (value === undefined || value === null || typeof value === 'boolean') return false;
  const recovered = compatibleBoolean(value);
  if (recovered === undefined) delete record[field];
  else record[field] = recovered;
  return true;
}

function compatibleBoolean(value: unknown): boolean | undefined {
  if (value === 0) return false;
  if (value === 1) return true;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'false' || normalized === '0') return false;
  if (normalized === 'true' || normalized === '1') return true;
  return undefined;
}

function recoverRunLocation(record: Record<string, unknown>): boolean {
  if (!Object.hasOwn(record, 'runLocation')) return false;
  const value = record.runLocation;
  if (value === undefined || value === null) return false;
  if (!isPlainObject(value)) {
    delete record.runLocation;
    return true;
  }

  const runLocation = { ...value };
  const changed = [
    dropInvalidOptionalField(
      runLocation,
      'mode',
      (candidate) =>
        typeof candidate === 'string' &&
        ['current', 'new-worktree', 'existing-worktree'].includes(candidate),
    ),
    ...['resolvedDir', 'resolvedBranch', 'parentRepoDir'].map((field) =>
      dropInvalidOptionalField(runLocation, field, (candidate) => typeof candidate === 'string'),
    ),
    dropInvalidOptionalField(runLocation, 'createdAt', Number.isSafeInteger),
  ].some(Boolean);
  if (changed) record.runLocation = runLocation;
  return changed;
}

function dropInvalidOptionalField(
  record: Record<string, unknown>,
  field: string,
  isValid: (value: unknown) => boolean,
): boolean {
  if (!Object.hasOwn(record, field)) return false;
  const value = record[field];
  if (value === undefined || value === null || isValid(value)) return false;
  delete record[field];
  return true;
}

function parseRecord(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return isPlainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readField(value: unknown, field: string): unknown {
  if (!isPlainObject(value) || !Object.hasOwn(value, field)) {
    throw new Error(`Legacy Session recovery row is missing ${field}`);
  }
  return value[field];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tableExists(database: DatabaseClient, tableName: string): boolean {
  return Boolean(
    database.rawDb
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName),
  );
}
