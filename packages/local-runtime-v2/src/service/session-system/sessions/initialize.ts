import type { SessionRepository } from './repo/contract.js';
import { createSessionCronQuery } from './query/cron-query.js';
import { SessionQueryService, type SessionMetadataDiscovery } from './query/query-service.js';

export interface InitializeSessionDomainOptions {
  readonly repository: SessionRepository;
  readonly discovery?: SessionMetadataDiscovery;
}

export function initializeSessionDomain(options: InitializeSessionDomainOptions) {
  return {
    repository: options.repository,
    query: new SessionQueryService(options.repository, options.discovery),
    cronQuery: createSessionCronQuery(options.repository),
  };
}
