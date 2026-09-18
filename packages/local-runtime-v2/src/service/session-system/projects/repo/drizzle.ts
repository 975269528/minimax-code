import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  isNotNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { DEFAULT_PROJECT_ORDER_INDEX, projects } from '../../../../infra/db/schema/projects.js';
import { sessions } from '../../../../infra/db/schema/sessions.js';
import { canonicalProjectWorkspaceDir } from '../../shared/workspace.js';
import { recordProjectRemoval } from '../../shared/project-removal.js';
import { sessionAgentNamePredicate } from '../../sessions/repo/agent-name-predicate.js';
import { projectTaskRootPredicate } from '../../sessions/repo/filters.js';
import type {
  ProjectListOptions,
  ProjectRecentOptions,
  ProjectRepository,
  ProjectRepositoryOptions,
  ProjectRecord,
} from './contract.js';
import {
  decodeProjectCursor,
  normalizeProjectLimit,
  projectPageFromRows,
  type CatalogProjectCursor,
  type ProjectPageKind,
  type RecentProjectCursor,
} from './pagination.js';

import { channelProjectPredicate, projectActivityExpression } from './activity.js';

const projectSelection = {
  ...getTableColumns(projects),
  latestActivityAtMs: projectActivityExpression,
  sessionCount: sql<number>`${projects.sessionCount} +
    (SELECT COUNT(*) FROM ${sessions} WHERE ${channelProjectPredicate} AND ${sessions.parentSessionId} IS NULL)`,
};

export function createProjectRepository(options: ProjectRepositoryOptions): ProjectRepository {
  return new DrizzleProjectRepository(options);
}
class DrizzleProjectRepository implements ProjectRepository {
  constructor(private readonly options: ProjectRepositoryOptions) {}
  async getById(projectId: number) {
    return decode(
      this.options.db
        .select(projectSelection)
        .from(projects)
        .where(eq(projects.projectId, projectId))
        .get(),
    );
  }
  async getSessionProjectId(sessionId: string) {
    return (
      this.options.db
        .select({ projectId: sessions.projectId })
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .get()?.projectId ?? undefined
    );
  }
  async getByWorkspaceDir(workspaceDir: string) {
    const canonical = canonicalProjectWorkspaceDir(workspaceDir);
    return canonical
      ? decode(
          this.options.db
            .select(projectSelection)
            .from(projects)
            .where(eq(projects.workspaceDir, canonical))
            .get(),
        )
      : undefined;
  }
  async getDefault() {
    return decode(
      this.options.db
        .select(projectSelection)
        .from(projects)
        .where(eq(projects.projectKind, 'default'))
        .get(),
    );
  }
  async ensureByWorkspaceDir(workspaceDir: string, nowMs: number) {
    const canonical = canonicalProjectWorkspaceDir(workspaceDir);
    if (!canonical) return undefined;
    this.options.db
      .insert(projects)
      .values({
        projectKind: 'workspace',
        workspaceDir: canonical,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      })
      .onConflictDoNothing()
      .run();
    return this.getByWorkspaceDir(canonical);
  }
  async ensureDefault(nowMs: number) {
    this.options.db
      .insert(projects)
      .values({
        projectKind: 'default',
        workspaceDir: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      })
      .onConflictDoNothing()
      .run();
    const value = await this.getDefault();
    if (!value) throw new Error('Default Project was not created');
    return value;
  }
  async listPage(options: ProjectListOptions) {
    const includeHiddenProjects =
      options.includeHiddenProjects === true || options.includeHidden === true;
    const kind: ProjectPageKind = includeHiddenProjects ? 'catalog-all' : 'catalog-visible';
    const cursor = decodeProjectCursor(options.cursor, kind);
    const limit = normalizeProjectLimit(options.limit);
    const sessionCountExpression = this.options.db.$count(sessions, projectRootPredicate(options));
    const values = this.options.db
      .select({
        project: projects,
        filteredSessionCount: sessionCountExpression,
        latestActivityAtMs: projectActivityExpression,
      })
      .from(projects)
      .where(
        and(
          includeHiddenProjects ? undefined : eq(projects.hidden, 0),
          gt(sessionCountExpression, 0),
          cursor?.kind === 'catalog-visible' || cursor?.kind === 'catalog-all'
            ? catalogCursorPredicate(cursor)
            : undefined,
        ),
      )
      .orderBy(
        desc(projects.pinned),
        asc(projects.orderIndex),
        desc(projectActivityExpression),
        asc(projects.projectId),
      )
      .limit(limit + 1)
      .all()
      .map(({ project, filteredSessionCount, latestActivityAtMs }) => ({
        ...requiredDecode(project),
        sessionCount: Number(filteredSessionCount),
        latestActivityAtMs,
      }));
    return projectPageFromRows(values, limit, kind);
  }
  async listRecent(options: ProjectRecentOptions) {
    const cursor = decodeProjectCursor(options.cursor, 'recent');
    const limit = normalizeProjectLimit(options.limit);
    const values = this.options.db
      .select(projectSelection)
      .from(projects)
      .where(
        and(
          isNotNull(projects.recentAtMs),
          cursor?.kind === 'recent' ? recentCursorPredicate(cursor) : undefined,
        ),
      )
      .orderBy(desc(projects.recentAtMs), asc(projects.projectId))
      .limit(limit + 1)
      .all()
      .map(requiredDecode);
    return projectPageFromRows(values, limit, 'recent');
  }
  async setPinned(projectId: number, pinned: boolean, nowMs: number) {
    return this.update(projectId, {
      pinned: pinned ? 1 : 0,
      ...(pinned ? {} : { orderIndex: DEFAULT_PROJECT_ORDER_INDEX }),
      updatedAtMs: nowMs,
    });
  }
  async setHidden(projectId: number, hidden: boolean, nowMs: number) {
    this.options.db.transaction((tx) => {
      const project = tx.select().from(projects).where(eq(projects.projectId, projectId)).get();
      if (!project) return;
      if (hidden) recordProjectRemoval(tx, project, nowMs);
      tx.update(projects).set({ hidden: hidden ? 1 : 0, updatedAtMs: nowMs })
        .where(eq(projects.projectId, projectId)).run();
    });
    return this.getById(projectId);
  }
  async putOrder(projectIds: readonly number[], nowMs: number) {
    this.options.db.transaction((tx) =>
      projectIds.forEach((projectId, orderIndex) => {
        tx.update(projects)
          .set({ pinned: 1, orderIndex, updatedAtMs: nowMs })
          .where(eq(projects.projectId, projectId))
          .run();
      }),
    );
  }
  async touchRecent(projectId: number, nowMs: number) {
    return this.update(projectId, { recentAtMs: nowMs, updatedAtMs: nowMs });
  }
  private async update(projectId: number, fields: Partial<typeof projects.$inferInsert>) {
    this.options.db.update(projects).set(fields).where(eq(projects.projectId, projectId)).run();
    return this.getById(projectId);
  }
}

const DEFAULT_PROJECT_SESSION_FILTER = {
  archived: false,
  includeHidden: false,
  excludeInternalTreeSessions: true,
} as const;

function projectRootPredicate(options: ProjectListOptions): SQL | undefined {
  return and(
    eq(sessions.columnarVersion, 3),
    eq(sessions.projectId, projects.projectId),
    sessionAgentNamePredicate(options.agentName),
    projectTaskRootPredicate(options.sessionFilter ?? DEFAULT_PROJECT_SESSION_FILTER),
  );
}

function catalogCursorPredicate(cursor: CatalogProjectCursor): SQL | undefined {
  const pinned = cursor.pinned ? 1 : 0;
  return or(
    lt(projects.pinned, pinned),
    and(eq(projects.pinned, pinned), gt(projects.orderIndex, cursor.orderIndex)),
    and(
      eq(projects.pinned, pinned),
      eq(projects.orderIndex, cursor.orderIndex),
      lt(projectActivityExpression, cursor.latestActivityAtMs),
    ),
    and(
      eq(projects.pinned, pinned),
      eq(projects.orderIndex, cursor.orderIndex),
      eq(projectActivityExpression, cursor.latestActivityAtMs),
      gt(projects.projectId, cursor.projectId),
    ),
  );
}

function recentCursorPredicate(cursor: RecentProjectCursor): SQL | undefined {
  return or(
    lt(projects.recentAtMs, cursor.recentAtMs),
    and(eq(projects.recentAtMs, cursor.recentAtMs), gt(projects.projectId, cursor.projectId)),
  );
}
function decode(row: typeof projects.$inferSelect | undefined): ProjectRecord | undefined {
  return row ? requiredDecode(row) : undefined;
}
function requiredDecode(row: typeof projects.$inferSelect): ProjectRecord {
  return {
    ...row,
    projectKind: row.projectKind === 'default' ? 'default' : 'workspace',
    pinned: row.pinned === 1,
    hidden: row.hidden === 1,
  };
}
