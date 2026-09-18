import path from 'node:path';

import type { DatabaseClient } from './client.js';

interface PreferenceRecoveryPlan {
  readonly valueJson: string;
  readonly recoveredCount: number;
}

interface PreferenceEntryPlan {
  readonly key: string;
  readonly value?: unknown;
  readonly recovered: boolean;
  readonly keep: boolean;
}

const PREFERENCE_FIELDS: ReadonlyArray<
  readonly [field: string, isValid: (value: unknown) => boolean]
> = [
  ['pinned', (value) => typeof value === 'boolean'],
  ['hidden', (value) => typeof value === 'boolean'],
  ['orderIndex', Number.isSafeInteger],
  ['recentAt', Number.isSafeInteger],
];

/** Keeps one malformed legacy preference entry from blocking the frozen version 7 backfill. */
export function recoverProjectPreferencesBeforeBackfill(options: {
  readonly database: DatabaseClient;
  readonly version7Pending: boolean;
}): number {
  if (!options.version7Pending || !tableExists(options.database, 'local_runtime_preferences')) {
    return 0;
  }
  if (projectPreferencesAlreadyMigrated(options.database)) return 0;
  const row = options.database.rawDb
    .prepare(
      `SELECT value_json
       FROM local_runtime_preferences
       WHERE key = 'project-user-state'`,
    )
    .get();
  if (row === undefined) return 0;

  const recovery = planPreferenceRecovery(readField(row, 'value_json'));
  if (recovery.recoveredCount === 0) return 0;
  options.database.rawDb
    .prepare("UPDATE local_runtime_preferences SET value_json = ? WHERE key = 'project-user-state'")
    .run(recovery.valueJson);
  return recovery.recoveredCount;
}

/** Skips malformed non-default Session metadata without changing default Project identity. */
export function recoverSessionProjectMetadataBeforeRepair(options: {
  readonly database: DatabaseClient;
  readonly version15Pending: boolean;
}): number {
  if (!options.version15Pending || !tableExists(options.database, 'local_runtime_sessions')) {
    return 0;
  }
  const rows = options.database.rawDb
    .prepare(
      `SELECT session_id, is_default_workspace, extra_data_json
       FROM local_runtime_sessions
       WHERE columnar_version = 3
       ORDER BY session_id`,
    )
    .all();
  const recoveryPlans = rows.map((row) => {
    const sessionId = readString(row, 'session_id');
    const isDefaultWorkspace = readBit(row, 'is_default_workspace') === 1;
    const malformed = !isJsonObject(readField(row, 'extra_data_json'));
    return { sessionId, isDefaultWorkspace, malformed };
  });
  const unsafe = recoveryPlans.find(
    ({ isDefaultWorkspace, malformed }) => isDefaultWorkspace && malformed,
  );
  if (unsafe) {
    throw new Error(
      `Cannot safely skip malformed Project metadata for default Session: ${unsafe.sessionId}`,
    );
  }
  const skippedSessionIds = recoveryPlans.flatMap(({ sessionId, malformed }) =>
    malformed ? [sessionId] : [],
  );
  if (skippedSessionIds.length === 0) return 0;

  const update = options.database.rawDb.prepare(
    `UPDATE local_runtime_sessions
     SET extra_data_json = '{}'
     WHERE session_id = ?`,
  );
  options.database.rawDb.transaction(() => {
    skippedSessionIds.forEach((sessionId) => update.run(sessionId));
  })();
  return skippedSessionIds.length;
}

function planPreferenceRecovery(raw: unknown): PreferenceRecoveryPlan {
  const parsed = parseJsonObject(raw);
  if (!parsed) return { valueJson: '{}', recoveredCount: 1 };

  const entries = Object.entries(parsed).map(([key, value]) => planPreferenceEntry(key, value));
  const recoveredCount = entries.filter(({ recovered }) => recovered).length;
  if (recoveredCount === 0 && typeof raw === 'string') {
    return { valueJson: raw, recoveredCount: 0 };
  }
  const recoveredEntries = entries.flatMap(({ key, value, keep }) =>
    keep ? ([[key, value]] as const) : [],
  );
  return { valueJson: JSON.stringify(Object.fromEntries(recoveredEntries)), recoveredCount };
}

function planPreferenceEntry(key: string, value: unknown): PreferenceEntryPlan {
  const identity = classifyPreferenceIdentity(key);
  if (identity === 'unknown') return { key, value, recovered: false, keep: true };
  if (identity === 'invalid' || !isPlainObject(value)) {
    return { key, recovered: true, keep: false };
  }

  const recoveredValue = { ...value };
  const recovered = PREFERENCE_FIELDS.map(([field, isValid]) =>
    dropInvalidOptionalField(recoveredValue, field, isValid),
  ).some(Boolean);
  return { key, value: recovered ? recoveredValue : value, recovered, keep: true };
}

function classifyPreferenceIdentity(key: string): 'valid' | 'invalid' | 'unknown' {
  if (key === 'default') return 'valid';
  if (!key.startsWith('workspace:')) return 'unknown';
  return isAbsoluteWorkspace(key.slice('workspace:'.length)) ? 'valid' : 'invalid';
}

function isAbsoluteWorkspace(value: string): boolean {
  const input = value.trim();
  if (!input) return false;
  if (input.startsWith('\\\\')) {
    return input.split(/[\\/]+/u).filter(Boolean).length >= 2;
  }
  const flavor = /^[A-Za-z]:[\\/]/u.test(input) ? path.win32 : path.posix;
  return flavor.isAbsolute(input);
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

function readString(value: unknown, field: string): string {
  const result = readField(value, field);
  if (typeof result !== 'string') {
    throw new Error(`Project migration recovery ${field} must be text`);
  }
  return result;
}

function readBit(value: unknown, field: string): 0 | 1 {
  const result = readField(value, field);
  if (result !== 0 && result !== 1) {
    throw new Error(`Project migration recovery ${field} must be a bit`);
  }
  return result;
}

function readField(value: unknown, field: string): unknown {
  if (!isPlainObject(value) || !Object.hasOwn(value, field)) {
    throw new Error(`Project migration recovery row is missing ${field}`);
  }
  return value[field];
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isJsonObject(value: unknown): boolean {
  return parseJsonObject(value) !== undefined;
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

function projectPreferencesAlreadyMigrated(database: DatabaseClient): boolean {
  return Boolean(
    database.rawDb
      .prepare(
        `SELECT 1
         FROM local_runtime_project_migrations
         WHERE migration_key = 'legacy-project-user-state-v2'`,
      )
      .get(),
  );
}
