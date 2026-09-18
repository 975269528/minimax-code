import type { SessionRecord } from '../../sessions/repo/contract.js';
import type { ProjectRecord } from '../repo/contract.js';

export interface SidebarFilter {
  types?: string[];
  statuses?: string[];
  agentNames?: string[];
  activityDays?: number;
}
export interface SidebarScope {
  unreadSessionIds?: string[];
  excludedSessionIds?: string[];
  excludedProjectIds?: number[];
}
export interface SidebarQuery {
  activeSessionId?: string;
  allProjects?: boolean;
  filter?: SidebarFilter;
  scope?: SidebarScope;
  bindingIds: readonly string[];
  cronTargetIds?: readonly string[];
  context?: string;
  cursor?: string;
  limit?: number;
  sessionLimit?: number;
}
export interface SidebarEntry {
  session: SessionRecord;
  types: string[];
  done: boolean;
}
export interface SidebarGroup {
  activeEntry?: SidebarEntry;
  project: ProjectRecord;
  entries: SidebarEntry[];
  matchedCount: number;
  hasMoreSessions: boolean;
  nextSessionCursor?: string;
}
export class SidebarQueryError extends Error {
  constructor(
    readonly key: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'SidebarQueryError';
  }
}
