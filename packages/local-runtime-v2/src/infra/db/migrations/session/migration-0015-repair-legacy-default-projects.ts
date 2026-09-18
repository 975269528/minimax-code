import path from 'node:path';

import type { MigrationDatabase, MigrationEntry } from '../../migrate.js';

interface SessionRow {
  readonly sessionId: string;
  readonly workspaceDir: string | undefined;
  readonly projectWorkspaceDir: string | null;
  readonly isDefaultWorkspace: boolean;
  readonly sessionOrigin: string | undefined;
  readonly hasRunLocation: boolean;
}

/** Repairs daemon-era default workspace aliases while preserving explicit and v2-native rows. */
export const migration: MigrationEntry = {
  version: 15,
  name: 'repair_legacy_default_projects',
  up: repairLegacyDefaultProjects,
};

function repairLegacyDefaultProjects(database: MigrationDatabase): void {
  const rows = readSessionRows(database);
  repairExplicitRunLocations(database, rows);
  const defaultWorkspaces = new Set(
    rows.flatMap((row) =>
      row.isDefaultWorkspace && !row.hasRunLocation ? normalizedWorkspace(row.workspaceDir) : [],
    ),
  );
  rows.forEach((row) => {
    if (!isRepairCandidate(row) || !isSessionDefaultWorkspaceDir(row.workspaceDir, row.sessionId)) {
      return;
    }
    const workspace = normalizeAbsolutePath(row.workspaceDir);
    if (workspace) defaultWorkspaces.add(workspace);
  });
  const update = database.prepare(
    `UPDATE local_runtime_sessions
     SET project_workspace_dir = NULL, is_default_workspace = 1
     WHERE session_id = ? AND is_default_workspace = 0`,
  );
  rows.forEach((row) => {
    const workspace = normalizeAbsolutePath(row.workspaceDir);
    if (isRepairCandidate(row) && workspace && defaultWorkspaces.has(workspace)) {
      update.run(row.sessionId);
    }
  });
}

function repairExplicitRunLocations(
  database: MigrationDatabase,
  rows: readonly SessionRow[],
): void {
  const update = database.prepare(
    `UPDATE local_runtime_sessions
     SET project_workspace_dir = ?, is_default_workspace = 0
     WHERE session_id = ? AND is_default_workspace = 1`,
  );
  rows.forEach((row) => {
    if (!row.hasRunLocation || !row.isDefaultWorkspace) return;
    const projectWorkspaceDir = row.projectWorkspaceDir ?? normalizeAbsolutePath(row.workspaceDir);
    if (projectWorkspaceDir) update.run(projectWorkspaceDir, row.sessionId);
  });
}

function readSessionRows(database: MigrationDatabase): SessionRow[] {
  return database
    .prepare(
      `SELECT session_id, workspace_dir, project_workspace_dir,
              is_default_workspace, extra_data_json
       FROM local_runtime_sessions
       WHERE columnar_version = 3
       ORDER BY session_id`,
    )
    .all()
    .map(readSessionRow);
}

function readSessionRow(value: unknown): SessionRow {
  if (!isRecord(value)) throw new Error('Invalid Session Project repair row');
  const sessionId = readString(value, 'session_id');
  const workspaceDir = readNullableString(value, 'workspace_dir') ?? undefined;
  const projectWorkspaceDir = readNullableString(value, 'project_workspace_dir');
  const isDefaultWorkspace = readBit(value, 'is_default_workspace') === 1;
  const extraData = readExtraData(readString(value, 'extra_data_json'));
  return {
    sessionId,
    workspaceDir,
    projectWorkspaceDir,
    isDefaultWorkspace,
    sessionOrigin:
      typeof extraData.sessionOrigin === 'string' ? extraData.sessionOrigin : undefined,
    hasRunLocation: extraData.runLocation !== undefined && extraData.runLocation !== null,
  };
}

function isRepairCandidate(row: SessionRow): boolean {
  return row.sessionOrigin === 'legacy-opencode' && !row.isDefaultWorkspace && !row.hasRunLocation;
}

function readExtraData(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Invalid Session extra_data_json during Project repair');
  }
  if (!isRecord(parsed)) throw new Error('Session extra_data_json must be an object');
  return parsed;
}

function readString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') throw new Error(`Session Project repair ${key} must be text`);
  return field;
}

function readNullableString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  if (field === null || typeof field === 'string') return field;
  throw new Error(`Session Project repair ${key} must be nullable text`);
}

function readBit(value: Record<string, unknown>, key: string): 0 | 1 {
  const field = value[key];
  if (field === 0 || field === 1) return field;
  throw new Error(`Session Project repair ${key} must be a bit`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAbsolutePath(value: string | undefined): string | undefined {
  const input = value?.trim();
  if (!input) return undefined;
  const flavor = pathFlavor(input);
  if (!flavor.isAbsolute(input)) return undefined;
  return trimTrailingSeparators(flavor.normalize(input));
}

function pathFlavor(value: string): typeof path.posix | typeof path.win32 {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\') ? path.win32 : path.posix;
}

function trimTrailingSeparators(value: string): string {
  if (value === '/' || /^[A-Za-z]:\\$/u.test(value)) return value;
  if (/^\\\\[^\\]+\\[^\\]+\\?$/u.test(value)) return value.replace(/\\$/u, '');
  return value.replace(/[\\/]+$/u, '');
}

function isSessionDefaultWorkspaceDir(
  workspaceDir: string | undefined,
  sessionId: string,
): boolean {
  if (!sessionId || /[\\/]/u.test(sessionId)) return false;
  const normalized = normalizeAbsolutePath(workspaceDir);
  if (!normalized) return false;
  const windows = /^[A-Za-z]:[\\/]/u.test(normalized) || normalized.startsWith('\\\\');
  const parts = normalized.split(windows ? /[\\/]+/u : /\/+/u).filter(Boolean);
  const samePart = (value: string | undefined, expected: string): boolean =>
    value !== undefined &&
    (windows ? value.toLowerCase() === expected.toLowerCase() : value === expected);
  return (
    samePart(parts.at(-1), 'workspace') &&
    samePart(parts.at(-2), sessionId) &&
    samePart(parts.at(-3), 'sessions')
  );
}

function normalizedWorkspace(workspaceDir: string | undefined): string[] {
  const normalized = normalizeAbsolutePath(workspaceDir);
  return normalized ? [normalized] : [];
}
