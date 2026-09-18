import type { ProjectRepository, ProjectRecord } from './repo/contract.js';
import type {
  SessionPage,
  SessionRecord,
  SessionRepository,
  SessionTreeFilter,
} from '../sessions/repo/contract.js';

export const DEFAULT_PROJECT_KEY = 'default';

/**
 * Canonical Project identity for an already-created Session.
 *
 * This is intentionally derived only from `Session.project_id -> Project`.
 * Session execution paths and frozen Agent definitions are migration evidence,
 * not alternate Project identities.
 */
export interface CanonicalSessionProjectIdentity {
  readonly projectKey: string;
  readonly projectKind: 'default' | 'workspace';
  readonly workspaceDir?: string;
}

export interface ProjectReference {
  readonly projectId?: number;
  readonly projectKey?: string;
  readonly workspaceDir?: string;
}

export interface ProjectListInput {
  readonly agentName?: string;
  readonly sessionFilter: SessionTreeFilter;
  readonly includeHiddenProjects?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
  readonly sessionLimit?: number;
}

export interface ProjectGroup {
  readonly project: ProjectRecord;
  readonly sessionCount: number;
  readonly sessions: readonly SessionRecord[];
  readonly childrenByParent: ReadonlyMap<string, readonly SessionRecord[]>;
  readonly hasMoreSessions: boolean;
  readonly nextSessionCursor?: string;
}

export interface ProjectGroupPage {
  readonly projects: readonly ProjectGroup[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface ProjectSessionPageInput {
  readonly agentName?: string;
  readonly filter: SessionTreeFilter;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ProjectSessionPage extends SessionPage {
  readonly childrenByParent: ReadonlyMap<string, readonly SessionRecord[]>;
}

export interface ProjectServiceOptions {
  readonly projects: ProjectRepository;
  readonly sessions: Pick<
    SessionRepository,
    'listProjectRootPreviews' | 'listProjectRootPage' | 'listChildrenMany'
  >;
  readonly nowMs?: () => number;
}
