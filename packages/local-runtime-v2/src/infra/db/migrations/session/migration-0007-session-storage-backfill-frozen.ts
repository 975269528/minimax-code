import type { MigrationEntry } from '../../migrate.js';

type Database = Parameters<Exclude<MigrationEntry['up'], string>>[0];

/** Frozen Project/FTS primitives consumed only by the m0006 data migration. */
export const FROZEN_PROJECT_AGGREGATE_REBUILD_SQL = `
  UPDATE local_runtime_projects
  SET latest_activity_at_ms = COALESCE((
        SELECT MAX(s.updated_at_ms)
        FROM local_runtime_sessions s
        WHERE s.project_id = local_runtime_projects.project_id
          AND s.columnar_version = 3
          AND s.archived = 0
          AND s.visibility <> 'hidden'
          AND s.session_kind NOT IN ('peek', 'channel', 'cron')
      ), 0),
      session_count = (
        SELECT COUNT(*)
        FROM local_runtime_sessions s
        WHERE s.project_id = local_runtime_projects.project_id
          AND s.columnar_version = 3
          AND s.archived = 0
          AND s.visibility <> 'hidden'
          AND s.session_kind NOT IN ('peek', 'channel', 'cron')
          AND s.parent_session_id IS NULL
      )
`;

export const FROZEN_PROJECT_INDEXES_SQL = `
  CREATE UNIQUE INDEX idx_local_runtime_projects_one_default_v1
    ON local_runtime_projects(project_kind) WHERE project_kind = 'default';
  CREATE UNIQUE INDEX idx_local_runtime_projects_workspace_v1
    ON local_runtime_projects(workspace_dir) WHERE project_kind = 'workspace';
  CREATE INDEX idx_local_runtime_projects_list_v1
    ON local_runtime_projects(
      hidden, pinned DESC, order_index ASC, latest_activity_at_ms DESC, project_id ASC
    );
  CREATE INDEX idx_local_runtime_projects_recent_v1
    ON local_runtime_projects(recent_at_ms DESC, project_id ASC)
    WHERE recent_at_ms IS NOT NULL;
`;

export const FROZEN_PROJECT_TRIGGER_NAMES = [
  'trg_local_runtime_project_session_insert_v1',
  'trg_local_runtime_project_session_assignment_v1',
  'trg_local_runtime_project_session_activity_v1',
  'trg_local_runtime_project_session_delete_v1',
  'trg_local_runtime_project_session_insert_v2',
  'trg_local_runtime_project_session_assignment_v2',
  'trg_local_runtime_project_session_activity_v2',
  'trg_local_runtime_project_session_delete_v2',
  'trg_local_runtime_project_session_insert_v3',
  'trg_local_runtime_project_session_assignment_v3',
  'trg_local_runtime_project_session_activity_v3',
  'trg_local_runtime_project_session_delete_v3',
  'trg_local_runtime_project_session_insert_v4',
  'trg_local_runtime_project_session_assignment_v4',
  'trg_local_runtime_project_session_activity_v4',
  'trg_local_runtime_project_session_delete_v4',
  'trg_local_runtime_project_session_insert_v5',
  'trg_local_runtime_project_session_assignment_v5',
  'trg_local_runtime_project_session_activity_v5',
  'trg_local_runtime_project_session_delete_v5',
] as const;

const PROJECT_AGGREGATE_ASSIGNMENTS = `latest_activity_at_ms = COALESCE((
      SELECT MAX(s.updated_at_ms)
      FROM local_runtime_sessions s
      WHERE s.project_id = local_runtime_projects.project_id
        AND s.columnar_version = 3
        AND s.archived = 0
        AND s.visibility <> 'hidden'
        AND s.session_kind NOT IN ('peek', 'channel', 'cron')
    ), 0),
    session_count = (
      SELECT COUNT(*)
      FROM local_runtime_sessions s
      WHERE s.project_id = local_runtime_projects.project_id
        AND s.columnar_version = 3
        AND s.archived = 0
        AND s.visibility <> 'hidden'
        AND s.session_kind NOT IN ('peek', 'channel', 'cron')
        AND s.parent_session_id IS NULL
    )`;

const INSERT_PROJECT_FOR_NEW_SESSION = `
  INSERT INTO local_runtime_projects(
    project_kind, workspace_dir, latest_activity_at_ms, created_at_ms, updated_at_ms
  )
  SELECT
    CASE WHEN NEW.is_default_workspace = 1 THEN 'default' ELSE 'workspace' END,
    CASE WHEN NEW.is_default_workspace = 1 THEN NULL ELSE NEW.project_workspace_dir END,
    CASE
      WHEN NEW.columnar_version = 3 AND NEW.archived = 0 AND NEW.visibility <> 'hidden'
        AND NEW.session_kind NOT IN ('peek', 'channel', 'cron')
      THEN NEW.updated_at_ms ELSE 0
    END,
    COALESCE(NEW.created_at_ms, NEW.updated_at_ms, 0),
    COALESCE(NEW.created_at_ms, NEW.updated_at_ms, 0)
  WHERE NEW.columnar_version = 3
    AND (
      NEW.is_default_workspace = 1
      OR (NEW.project_workspace_dir IS NOT NULL AND trim(NEW.project_workspace_dir) <> '')
    )
  ON CONFLICT DO NOTHING;

  UPDATE local_runtime_sessions
  SET project_id = COALESCE((
    SELECT p.project_id
    FROM local_runtime_projects p
    WHERE NEW.columnar_version = 3
      AND (
        NEW.is_default_workspace = 1
        OR (NEW.project_workspace_dir IS NOT NULL AND trim(NEW.project_workspace_dir) <> '')
      )
      AND (
        (p.project_kind = 'default' AND NEW.is_default_workspace = 1)
        OR (
          p.project_kind = 'workspace' AND NOT (NEW.is_default_workspace = 1)
          AND p.workspace_dir = NEW.project_workspace_dir
        )
      )
  ), 0)
  WHERE session_id = NEW.session_id;
`;

export const FROZEN_PROJECT_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS trg_local_runtime_project_session_insert_v5
  AFTER INSERT ON local_runtime_sessions
  WHEN NEW.columnar_version = 3
  BEGIN
    ${INSERT_PROJECT_FOR_NEW_SESSION}
    UPDATE local_runtime_projects
    SET ${PROJECT_AGGREGATE_ASSIGNMENTS}
    WHERE project_id = (
      SELECT project_id FROM local_runtime_sessions WHERE session_id = NEW.session_id
    );
  END;

  CREATE TRIGGER IF NOT EXISTS trg_local_runtime_project_session_assignment_v5
  AFTER UPDATE OF columnar_version, project_workspace_dir, is_default_workspace
  ON local_runtime_sessions
  WHEN NEW.columnar_version = 3
    AND (
      OLD.columnar_version IS NOT NEW.columnar_version
      OR OLD.project_workspace_dir IS NOT NEW.project_workspace_dir
      OR OLD.is_default_workspace IS NOT NEW.is_default_workspace
    )
  BEGIN
    ${INSERT_PROJECT_FOR_NEW_SESSION}
    UPDATE local_runtime_projects
    SET ${PROJECT_AGGREGATE_ASSIGNMENTS}
    WHERE project_id IN (
      COALESCE(OLD.project_id, 0),
      COALESCE((
        SELECT project_id FROM local_runtime_sessions WHERE session_id = NEW.session_id
      ), 0)
    );
  END;

  CREATE TRIGGER IF NOT EXISTS trg_local_runtime_project_session_activity_v5
  AFTER UPDATE OF
    updated_at_ms, created_at_ms, archived, parent_session_id, session_type,
    visibility, session_kind
  ON local_runtime_sessions
  WHEN OLD.columnar_version IS NEW.columnar_version
    AND OLD.project_workspace_dir IS NEW.project_workspace_dir
    AND OLD.is_default_workspace IS NEW.is_default_workspace
  BEGIN
    UPDATE local_runtime_projects
    SET ${PROJECT_AGGREGATE_ASSIGNMENTS}
    WHERE project_id IN (COALESCE(OLD.project_id, 0), COALESCE(NEW.project_id, 0));
  END;

  CREATE TRIGGER IF NOT EXISTS trg_local_runtime_project_session_delete_v5
  AFTER DELETE ON local_runtime_sessions
  WHEN OLD.project_id > 0
  BEGIN
    UPDATE local_runtime_projects
    SET ${PROJECT_AGGREGATE_ASSIGNMENTS}
    WHERE project_id = OLD.project_id;
  END;
`;

interface FrozenRunLocation {
  readonly parentRepoDir?: string;
}

interface ParsedPath {
  readonly root: string;
  readonly separator: '/' | '\\';
  readonly parts: readonly string[];
}

/** Frozen POSIX/Windows/UNC Project identity rule used by m0006 only. */
export function canonicalFrozenProjectWorkspaceDir(
  workspaceDir: string | null | undefined,
  runLocation?: FrozenRunLocation,
): string | undefined {
  const parent = normalizeAbsolutePath(runLocation?.parentRepoDir);
  if (parent) return collapseWorktreePath(parent);
  const workspace = normalizeAbsolutePath(workspaceDir);
  return workspace ? collapseWorktreePath(workspace) : undefined;
}

/**
 * Frozen compatibility for v1's default Project classifier.
 *
 * A per-session fallback is reserved by its exact Session id, including custom
 * dataDir layouts. The runtime fallback is limited to the current `.minimax`
 * dataDir shape so an arbitrary directory named `workspace` stays explicit.
 */
export function isFrozenSessionDefaultWorkspaceDir(
  workspaceDir: string | null | undefined,
  sessionId: string,
): boolean {
  if (!sessionId || /[\\/]/u.test(sessionId)) return false;
  const normalized = normalizeAbsolutePath(workspaceDir);
  const parsed = normalized ? splitAbsolutePath(normalized) : undefined;
  if (!parsed) return false;
  const windows = parsed.separator === '\\';
  const parts = parsed.parts;
  if (!samePathPart(parts.at(-1), 'workspace', windows)) return false;
  if (
    samePathPart(parts.at(-2), sessionId, windows) &&
    samePathPart(parts.at(-3), 'sessions', windows)
  ) {
    return true;
  }
  const dataDirName = parts.at(-2);
  const pattern = /^\.minimax(?:-.+)?$/u;
  return (
    dataDirName !== undefined && pattern.test(windows ? dataDirName.toLowerCase() : dataDirName)
  );
}

function frozenSessionSearchTerms(value: string | null | undefined): string {
  if (!value) return '';
  return [...value.normalize('NFKC').trim().toLowerCase()]
    .map((character) => `c${character.codePointAt(0)?.toString(16) ?? ''}`)
    .join(' ');
}

interface FrozenFtsCodecs {
  readonly readEligibleRowId: (value: unknown) => number | undefined;
  readonly readNullableString: (value: unknown, key: string, field: string) => string | null;
  readonly readPositiveSafeInteger: (value: unknown, key: string, field: string) => number;
  readonly readString: (value: unknown, key: string, field: string) => string;
}

export function rebuildFrozenSessionSearchIndex(database: Database, codecs: FrozenFtsCodecs): void {
  database
    .prepare(
      `DELETE FROM local_runtime_session_fts_keys
       WHERE session_id NOT IN (SELECT session_id FROM local_runtime_sessions)`,
    )
    .run();
  const assignedSessionIds = new Set<string>();
  const assignedRowIds = new Set<number>();
  const keyRows = database
    .prepare(
      `SELECT fts_rowid, session_id
       FROM local_runtime_session_fts_keys
       ORDER BY fts_rowid ASC`,
    )
    .all();
  for (const row of keyRows) {
    const rowId = codecs.readPositiveSafeInteger(
      row,
      'fts_rowid',
      'local_runtime_session_fts_keys',
    );
    const sessionId = codecs.readString(row, 'session_id', 'local_runtime_session_fts_keys');
    assignedRowIds.add(rowId);
    assignedSessionIds.add(sessionId);
  }

  const insertKey = database.prepare(
    `INSERT INTO local_runtime_session_fts_keys(fts_rowid, session_id)
     VALUES (?, ?)`,
  );
  const legacyDocuments = database
    .prepare(
      `SELECT f.rowid AS fts_rowid, f.session_id
       FROM local_runtime_sessions_fts f
       INNER JOIN local_runtime_sessions s ON s.session_id = f.session_id
       ORDER BY f.rowid ASC, f.session_id ASC`,
    )
    .all();
  for (const document of legacyDocuments) {
    const rowId = codecs.readEligibleRowId(document);
    if (rowId === undefined) continue;
    const sessionId = codecs.readString(document, 'session_id', 'local_runtime_sessions_fts');
    if (assignedRowIds.has(rowId) || assignedSessionIds.has(sessionId)) continue;
    insertKey.run(rowId, sessionId);
    assignedRowIds.add(rowId);
    assignedSessionIds.add(sessionId);
  }
  database
    .prepare(
      `INSERT INTO local_runtime_session_fts_keys(session_id)
       SELECT s.session_id
       FROM local_runtime_sessions s
       WHERE NOT EXISTS (
         SELECT 1 FROM local_runtime_session_fts_keys k WHERE k.session_id = s.session_id
       )
       ORDER BY s.session_id`,
    )
    .run();
  database.prepare('DELETE FROM local_runtime_sessions_fts').run();

  const rows = database
    .prepare(
      `SELECT k.fts_rowid, s.session_id, s.agent_name, s.title, s.workspace_dir,
              s.purpose, s.status, s.session_type
       FROM local_runtime_sessions s
       INNER JOIN local_runtime_session_fts_keys k ON k.session_id = s.session_id
       WHERE s.columnar_version = 3
       ORDER BY s.session_id ASC`,
    )
    .all();
  const insert = database.prepare(
    `INSERT INTO local_runtime_sessions_fts(
       rowid, session_id, session_id_terms, agent_name_terms, title_terms,
       workspace_dir_terms, purpose_terms, status_terms, session_type_terms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    const rowId = codecs.readPositiveSafeInteger(
      row,
      'fts_rowid',
      'local_runtime_session_fts_keys',
    );
    const sessionId = codecs.readString(row, 'session_id', 'local_runtime_sessions');
    insert.run(
      rowId,
      sessionId,
      frozenSessionSearchTerms(sessionId),
      frozenSessionSearchTerms(
        codecs.readNullableString(row, 'agent_name', 'local_runtime_sessions'),
      ),
      frozenSessionSearchTerms(codecs.readNullableString(row, 'title', 'local_runtime_sessions')),
      frozenSessionSearchTerms(
        codecs.readNullableString(row, 'workspace_dir', 'local_runtime_sessions'),
      ),
      frozenSessionSearchTerms(codecs.readNullableString(row, 'purpose', 'local_runtime_sessions')),
      frozenSessionSearchTerms(codecs.readNullableString(row, 'status', 'local_runtime_sessions')),
      frozenSessionSearchTerms(
        codecs.readNullableString(row, 'session_type', 'local_runtime_sessions'),
      ),
    );
  }
}

interface FrozenPostconditionCodecs {
  readonly readCount: (database: Database, sql: string) => number;
  readonly readInteger: (value: unknown, key: string, field: string) => number;
  readonly readString: (value: unknown, key: string, field: string) => string;
}

export function assertFrozenBackfillPostconditions(
  database: Database,
  codecs: FrozenPostconditionCodecs,
): void {
  const sessionCount = codecs.readCount(
    database,
    'SELECT COUNT(*) AS count FROM local_runtime_sessions',
  );
  const currentCount = codecs.readCount(
    database,
    'SELECT COUNT(*) AS count FROM local_runtime_sessions WHERE columnar_version = 3',
  );
  const keyCount = codecs.readCount(
    database,
    'SELECT COUNT(*) AS count FROM local_runtime_session_fts_keys',
  );
  const ftsCount = codecs.readCount(
    database,
    'SELECT COUNT(*) AS count FROM local_runtime_sessions_fts',
  );
  if (sessionCount !== currentCount || sessionCount !== keyCount || sessionCount !== ftsCount) {
    throw new Error('Session storage backfill count mismatch');
  }
  const projectKind = database
    .prepare('PRAGMA table_info("local_runtime_projects")')
    .all()
    .find(
      (row) => codecs.readString(row, 'name', 'local_runtime_projects metadata') === 'project_kind',
    );
  if (
    !projectKind ||
    codecs.readInteger(projectKind, 'notnull', 'local_runtime_projects metadata') !== 1
  ) {
    throw new Error('Project catalog was not rebuilt to the final contract');
  }
  const triggerCount = codecs.readCount(
    database,
    `SELECT COUNT(*) AS count
     FROM sqlite_master
     WHERE type = 'trigger'
       AND name IN (
         'trg_local_runtime_project_session_insert_v5',
         'trg_local_runtime_project_session_assignment_v5',
         'trg_local_runtime_project_session_activity_v5',
         'trg_local_runtime_project_session_delete_v5'
       )`,
  );
  if (triggerCount !== 4) throw new Error('Project maintenance triggers are incomplete');
  const unassociated = codecs.readCount(
    database,
    `SELECT COUNT(*) AS count
     FROM local_runtime_sessions s
     WHERE s.columnar_version = 3
       AND (
         s.is_default_workspace = 1
         OR (s.project_workspace_dir IS NOT NULL AND trim(s.project_workspace_dir) <> '')
       )
       AND NOT EXISTS (
         SELECT 1 FROM local_runtime_projects p
         WHERE p.project_id = s.project_id
           AND (
             (s.is_default_workspace = 1 AND p.project_kind = 'default')
             OR (
               s.is_default_workspace = 0 AND p.project_kind = 'workspace'
               AND p.workspace_dir = s.project_workspace_dir
             )
           )
       )`,
  );
  if (unassociated !== 0) throw new Error('Session Project associations are incomplete');
}

function normalizeAbsolutePath(value: string | null | undefined): string | undefined {
  const input = value?.trim();
  if (!input) return undefined;
  const parsed = splitAbsolutePath(input);
  if (!parsed) return undefined;
  const parts: string[] = [];
  for (const part of parsed.parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return joinAbsolutePath({ ...parsed, parts });
}

function splitAbsolutePath(value: string): ParsedPath | undefined {
  if (value.startsWith('\\\\')) {
    const parts = value.replaceAll('/', '\\').slice(2).split(/\\+/u).filter(Boolean);
    const server = parts.shift();
    const share = parts.shift();
    if (!server || !share) return undefined;
    return { root: `\\\\${server}\\${share}`, separator: '\\', parts };
  }
  if (/^[A-Za-z]:[\\/]/u.test(value)) {
    const windows = value.replaceAll('/', '\\');
    return {
      root: `${windows.slice(0, 2)}\\`,
      separator: '\\',
      parts: windows.slice(3).split(/\\+/u).filter(Boolean),
    };
  }
  if (!value.startsWith('/')) return undefined;
  return { root: '/', separator: '/', parts: value.slice(1).split(/\/+/u).filter(Boolean) };
}

function joinAbsolutePath(path: ParsedPath): string {
  if (path.root === '/') return path.parts.length > 0 ? `/${path.parts.join('/')}` : '/';
  if (path.root.endsWith('\\')) return `${path.root}${path.parts.join('\\')}`;
  return path.parts.length > 0
    ? `${path.root}${path.separator}${path.parts.join(path.separator)}`
    : path.root;
}

function samePathPart(left: string | undefined, right: string, windows: boolean): boolean {
  if (left === undefined) return false;
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function collapseWorktreePath(value: string): string {
  const parsed = splitAbsolutePath(value);
  if (!parsed) return value;
  const nestedAgentWorktreeParent = '.\x63\x6c\x61\x75\x64\x65';
  const simple = parsed.parts.findIndex((part) => part === '.worktrees' || part === '.worktree');
  if (simple >= 0 && simple < parsed.parts.length - 1) {
    return joinAbsolutePath({ ...parsed, parts: parsed.parts.slice(0, simple) });
  }
  const nestedTool = parsed.parts.findIndex(
    (part, index) => part === nestedAgentWorktreeParent && parsed.parts[index + 1] === 'worktrees',
  );
  if (nestedTool >= 0 && nestedTool < parsed.parts.length - 2) {
    return joinAbsolutePath({ ...parsed, parts: parsed.parts.slice(0, nestedTool) });
  }
  return value;
}
