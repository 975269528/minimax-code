import { projectConversationRootPredicate } from '../../sessions/repo/filters.js';
import { and, eq, isNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { sessions as s, sessionAgentState as a } from '../../../../infra/db/schema/sessions.js';
import { projects as p } from '../../../../infra/db/schema/projects.js';
import { turnIngress as t } from '../../../../infra/db/schema/turn.js';
import type { NormalizedSidebarQuery } from './context.js';
import { sessionAfterProjectRemoval } from '../../shared/project-removal.js';

export const TRUSTED_IM_MARKER = '[mavis:trusted-legacy-im-root]';
const trustedImRoot = and(
  eq(s.sessionType, 'root'),
  eq(s.sessionKind, 'conversation'),
  or(
    eq(s.purpose, TRUSTED_IM_MARKER),
    sql`substr(${s.purpose}, -${TRUSTED_IM_MARKER.length + 1}) = ${`\n${TRUSTED_IM_MARKER}`}`,
  ),
)!;
export const canonicalOwner = sql<string>`CASE WHEN ${s.agentName} IN ('main','mavis') THEN 'mavis' ELSE ${s.agentName} END`;
export const isDone = sql<boolean>`(${s.status} = 'idle' AND EXISTS (
  SELECT 1 FROM ${a} WHERE ${a.sessionId} = ${s.sessionId} AND ${a.terminalOutcome} = 'completed'
) AND NOT EXISTS (SELECT 1 FROM ${t} WHERE ${t.sessionId} = ${s.sessionId} AND ${t.status} = 'accepted'))`;
function membership(
  column: SQL | typeof s.sessionId | typeof p.projectId,
  values: readonly (string | number)[],
  negate = false,
): SQL {
  return negate
    ? sql`${column} NOT IN (SELECT value FROM json_each(${JSON.stringify(values)}))`
    : sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;
}
export function eligible(includeHiddenProject = false, internalRootIds: readonly string[] = []): SQL {
  return and(
    eq(s.columnarVersion, 3),
    eq(s.archived, 0),
    isNull(s.parentSessionId),
    includeHiddenProject ? undefined : eq(p.hidden, 0),
    sessionAfterProjectRemoval(),
    membership(s.sessionId, internalRootIds, true),
    or(
      and(
        eq(s.sessionType, 'branch'),
        ne(s.visibility, 'hidden'),
        notInArray(s.sessionKind, ['peek', 'task', 'channel']),
      ),
      and(eq(s.sessionType, 'branch'), eq(s.sessionKind, 'channel')),
      and(ne(s.visibility, 'hidden'), projectConversationRootPredicate()),
    ),
  )!;
}
export function sidebarProjectPredicate(q: NormalizedSidebarQuery): SQL {
  return and(
    eq(p.hidden, 0),
    eq(p.pinned, 0),
    membership(p.projectId, q.excludedProjectIds, true),
  )!;
}
export function sidebarPredicate(q: NormalizedSidebarQuery): SQL {
  const typeConditions: Record<string, SQL> = {
    chat: eq(p.projectKind, 'default'),
    task: eq(p.projectKind, 'workspace'),
    cron: or(eq(s.sessionKind, 'cron'), membership(s.sessionId, q.cronTargetIds))!,
    im: or(eq(s.sessionKind, 'channel'), membership(s.sessionId, q.bindingIds), trustedImRoot)!,
  };
  const statusConditions: Record<string, SQL> = {
    working: eq(s.status, 'started'),
    done: isDone,
    unread: membership(s.sessionId, q.unreadIds),
  };
  return and(
    eligible(false, q.internalRootIds),
    sidebarProjectPredicate(q),
    membership(s.sessionId, q.excludedIds, true),
    q.types.length ? or(...q.types.map((v) => typeConditions[v])) : undefined,
    q.statuses.length ? or(...q.statuses.map((v) => statusConditions[v])) : undefined,
    q.agentNames.length ? membership(canonicalOwner, q.agentNames) : undefined,
    q.activityDays ? sql`${s.updatedAtMs} >= ${q.nowMs - q.activityDays * 86400000}` : undefined,
  )!;
}
export function tupleAfter(
  columns: SQL[],
  values: unknown[] | undefined,
  descending: boolean[],
): SQL | undefined {
  if (!values) return undefined;
  return or(
    ...columns.map((column, i) =>
      and(
        ...columns.slice(0, i).map((c, j) => sql`${c} = ${values[j]}`),
        descending[i] ? sql`${column} < ${values[i]}` : sql`${column} > ${values[i]}`,
      ),
    ),
  );
}
