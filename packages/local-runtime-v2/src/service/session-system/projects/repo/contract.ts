import type { AppDb } from '../../../../infra/db/client.js';
import type { SessionTreeFilter } from '../../sessions/repo/contract.js';

export interface ProjectRecord {
  readonly projectId: number;
  readonly projectKind: 'default' | 'workspace';
  readonly workspaceDir: string | null;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly orderIndex: number;
  readonly recentAtMs: number | null;
  readonly latestActivityAtMs: number;
  readonly sessionCount: number;
  readonly extraDataJson: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ProjectPage {
  readonly projects: readonly ProjectRecord[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}
export interface ProjectListOptions {
  readonly agentName?: string;
  readonly sessionFilter?: SessionTreeFilter;
  readonly includeHiddenProjects?: boolean;
  readonly includeHidden?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface ProjectRecentOptions {
  readonly limit?: number;
  readonly cursor?: string;
}
export const PROJECT_REPOSITORY_CAPABILITIES = [
  'getById',
  'getSessionProjectId',
  'getByWorkspaceDir',
  'getDefault',
  'ensureByWorkspaceDir',
  'ensureDefault',
  'listPage',
  'listRecent',
  'setPinned',
  'setHidden',
  'putOrder',
  'touchRecent',
] as const;
export interface ProjectRepository {
  getById(projectId: number): Promise<ProjectRecord | undefined>;
  getSessionProjectId(sessionId: string): Promise<number | undefined>;
  getByWorkspaceDir(workspaceDir: string): Promise<ProjectRecord | undefined>;
  getDefault(): Promise<ProjectRecord | undefined>;
  ensureByWorkspaceDir(workspaceDir: string, nowMs: number): Promise<ProjectRecord | undefined>;
  ensureDefault(nowMs: number): Promise<ProjectRecord>;
  listPage(options: ProjectListOptions): Promise<ProjectPage>;
  listRecent(options: ProjectRecentOptions): Promise<ProjectPage>;
  setPinned(projectId: number, pinned: boolean, nowMs: number): Promise<ProjectRecord | undefined>;
  setHidden(projectId: number, hidden: boolean, nowMs: number): Promise<ProjectRecord | undefined>;
  putOrder(projectIds: readonly number[], nowMs: number): Promise<void>;
  touchRecent(projectId: number, nowMs: number): Promise<ProjectRecord | undefined>;
}
export interface ProjectRepositoryOptions {
  readonly db: AppDb;
}
