import type { ProjectRepository } from './repo/contract.js';
import type { SessionRepository } from '../sessions/repo/contract.js';
import { ProjectService } from './service.js';

export interface InitializeProjectDomainOptions {
  readonly repository: ProjectRepository;
  readonly sessions: Pick<
    SessionRepository,
    'listProjectRootPreviews' | 'listProjectRootPage' | 'listChildrenMany'
  >;
  readonly nowMs?: () => number;
}

export function initializeProjectDomain(options: InitializeProjectDomainOptions) {
  return {
    repository: options.repository,
    service: new ProjectService({
      projects: options.repository,
      sessions: options.sessions,
      nowMs: options.nowMs,
    }),
  };
}
