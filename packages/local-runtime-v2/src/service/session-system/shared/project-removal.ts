import { and, eq, ne, sql } from 'drizzle-orm';
import type { AppDb } from '../../../infra/db/client.js';
import { projects } from '../../../infra/db/schema/projects.js';
import { sessions } from '../../../infra/db/schema/sessions.js';

// The boundary IDs distinguish old and new sessions created in the same millisecond.
export function recordProjectRemoval(
  db: AppDb,
  project: typeof projects.$inferSelect,
  atMs: number,
  newlyCreatedSessionId?: string,
): void {
  const boundaryIds = db
    .select({ id: sessions.sessionId })
    .from(sessions)
    .where(
      and(
        eq(sessions.projectId, project.projectId),
        eq(sessions.createdAtMs, atMs),
        newlyCreatedSessionId ? ne(sessions.sessionId, newlyCreatedSessionId) : undefined,
      ),
    )
    .all()
    .map((row) => row.id);
  db.update(projects)
    .set({
      extraDataJson: sql`json_set(${projects.extraDataJson}, '$.sidebarRemoval', json(${JSON.stringify({ atMs, boundaryIds })}))`,
    })
    .where(eq(projects.projectId, project.projectId))
    .run();
}

export function sessionAfterProjectRemoval() {
  return sql`(json_extract(${projects.extraDataJson}, '$.sidebarRemoval.atMs') IS NULL
    OR ${sessions.createdAtMs} > json_extract(${projects.extraDataJson}, '$.sidebarRemoval.atMs')
    OR (${sessions.createdAtMs} = json_extract(${projects.extraDataJson}, '$.sidebarRemoval.atMs')
      AND ${sessions.sessionId} NOT IN (
        SELECT value FROM json_each(${projects.extraDataJson}, '$.sidebarRemoval.boundaryIds')
      )))`;
}

export function sessionNotRemovedFromProject() {
  return sql`NOT EXISTS (SELECT 1 FROM ${projects}
    WHERE ${projects.projectId} = ${sessions.projectId} AND NOT ${sessionAfterProjectRemoval()})`;
}
