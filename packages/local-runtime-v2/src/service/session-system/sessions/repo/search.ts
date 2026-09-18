import { createHash } from 'node:crypto';

import { eq, sql, type SQL } from 'drizzle-orm';

import type { AppDb } from '../../../../infra/db/client.js';
import { sessionFtsKeys } from '../../../../infra/db/schema/sessions.js';
import { isPrimarySessionAgentName, PRIMARY_SESSION_AGENT_NAMES } from '../agent-name.js';
import type { SessionRecord } from './contract.js';

interface SessionSearchOptions {
  readonly keyword: string;
  readonly agentName?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface SessionSearchIdPage {
  readonly sessionIds: readonly string[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

interface SessionSearchCursor {
  readonly rank: number;
  readonly rowId: number;
}

export function writeSessionSearchDocument(db: AppDb, record: SessionRecord): void {
  db.insert(sessionFtsKeys).values({ sessionId: record.sessionId }).onConflictDoNothing().run();
  const key = db
    .select({ rowId: sessionFtsKeys.ftsRowId })
    .from(sessionFtsKeys)
    .where(eq(sessionFtsKeys.sessionId, record.sessionId))
    .get();
  if (!key) throw new Error(`Session FTS key missing for ${record.sessionId}`);
  db.run(sql`DELETE FROM local_runtime_sessions_fts WHERE rowid = ${key.rowId}`);
  db.run(sql`INSERT INTO local_runtime_sessions_fts(
      rowid, session_id, session_id_terms, agent_name_terms, title_terms,
      workspace_dir_terms, purpose_terms, status_terms, session_type_terms
    ) VALUES (
      ${key.rowId}, ${record.sessionId}, ${toSessionSearchTerms(record.sessionId)},
      ${toSessionSearchTerms(record.agentName)}, ${toSessionSearchTerms(record.title)},
      ${toSessionSearchTerms(record.workspaceDir)}, ${toSessionSearchTerms(record.purpose)},
      ${toSessionSearchTerms(record.status)}, ${toSessionSearchTerms(record.sessionType)}
    )`);
}

export function deleteSessionSearchDocument(db: AppDb, sessionId: string): void {
  const key = db
    .select({ rowId: sessionFtsKeys.ftsRowId })
    .from(sessionFtsKeys)
    .where(eq(sessionFtsKeys.sessionId, sessionId))
    .get();
  if (key) db.run(sql`DELETE FROM local_runtime_sessions_fts WHERE rowid = ${key.rowId}`);
}

export function searchSessionIds(db: AppDb, options: SessionSearchOptions): SessionSearchIdPage {
  const keyword = normalizeSearchText(options.keyword);
  const query = toSessionSearchMatch(keyword);
  if (!query) return { sessionIds: [], hasMore: false };
  const fingerprint = searchFingerprint(keyword, options.agentName);
  const cursor = decodeSearchCursor(options.cursor, fingerprint);
  const cursorPredicate = cursor
    ? sql`AND (
        rank > ${cursor.rank}
        OR (rank = ${cursor.rank} AND rowid > ${cursor.rowId})
      )`
    : sql``;
  const agentPredicate = primaryAgentSearchPredicate(options.agentName);
  const rows = searchRows(db, {
    query,
    cursorPredicate,
    agentPredicate,
    limit: options.limit,
  });
  const hasMore = rows.length > options.limit;
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    sessionIds: page.map(({ sessionId }) => sessionId),
    hasMore,
    ...(hasMore && last
      ? { nextCursor: encodeSearchCursor(last.rank, last.rowId, fingerprint) }
      : {}),
  };
}

function primaryAgentSearchPredicate(agentName: string | undefined): SQL {
  if (!agentName) return sql``;
  return isPrimarySessionAgentName(agentName)
    ? sql`AND s.agent_name IN (${PRIMARY_SESSION_AGENT_NAMES[0]}, ${PRIMARY_SESSION_AGENT_NAMES[1]})`
    : sql`AND s.agent_name = ${agentName}`;
}

function searchRows(
  db: AppDb,
  options: {
    readonly query: string;
    readonly cursorPredicate: SQL;
    readonly agentPredicate: SQL;
    readonly limit: number;
  },
): Array<{ readonly sessionId: string; readonly rank: number; readonly rowId: number }> {
  return db.all(sql`SELECT
      local_runtime_sessions_fts.session_id AS sessionId,
      rank AS rank,
      rowid AS rowId
    FROM local_runtime_sessions_fts
    WHERE local_runtime_sessions_fts MATCH ${options.query}
      ${options.cursorPredicate}
      AND EXISTS (
        SELECT 1
        FROM local_runtime_sessions AS s
        WHERE s.session_id = local_runtime_sessions_fts.session_id
          AND s.columnar_version = 3
          AND s.archived = 0
          AND s.visibility <> 'hidden'
          AND s.session_kind NOT IN ('peek', 'cron')
          ${options.agentPredicate}
      )
    ORDER BY rank, rowid
    LIMIT ${options.limit + 1}`);
}

function toSessionSearchTerms(value: string | null | undefined): string {
  if (!value) return '';
  return [...normalizeSearchText(value)]
    .map((character) => `c${character.codePointAt(0)?.toString(16) ?? ''}`)
    .join(' ');
}

function toSessionSearchMatch(keyword: string): string {
  const terms = toSessionSearchTerms(keyword);
  return terms ? `"${terms}"` : '';
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

function searchFingerprint(keyword: string, agentName?: string): string {
  return createHash('sha256')
    .update(keyword)
    .update('\u0000')
    .update(agentName ?? '')
    .digest('base64url');
}

function encodeSearchCursor(rank: number, rowId: number, fingerprint: string): string {
  return Buffer.from(
    JSON.stringify({ v: 1, k: 'search', r: rank, i: rowId, f: fingerprint }),
  ).toString('base64url');
}

function decodeSearchCursor(
  value: string | undefined,
  fingerprint: string,
): SessionSearchCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (
      !isRecord(parsed) ||
      parsed.v !== 1 ||
      parsed.k !== 'search' ||
      parsed.f !== fingerprint ||
      !Number.isFinite(parsed.r) ||
      !Number.isSafeInteger(parsed.i) ||
      (parsed.i as number) <= 0
    ) {
      return undefined;
    }
    return { rank: parsed.r as number, rowId: parsed.i as number };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
