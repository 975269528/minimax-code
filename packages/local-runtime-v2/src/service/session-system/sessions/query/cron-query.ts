import type {
  SessionCronOriginPageOptions,
  SessionPage,
  SessionRecord,
  SessionRepository,
} from '../repo/contract.js';

export interface SessionCronQuery {
  listCreatedByCron(options: SessionCronOriginPageOptions): Promise<SessionPage>;
  getMany(sessionIds: readonly string[]): Promise<Array<SessionRecord | undefined>>;
}

export function createSessionCronQuery(
  repository: Pick<SessionRepository, 'listByCronOriginPage' | 'getMany'>,
): SessionCronQuery {
  return {
    listCreatedByCron: (options) => repository.listByCronOriginPage(options),
    getMany: (sessionIds) => repository.getMany(sessionIds),
  };
}
