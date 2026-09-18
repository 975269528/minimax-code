import type { CronService } from './contracts.js';

const OWNER_PAGE_LIMIT = 200;

/** True iff an enabled Cron definition targets the exact existing Session. */
export function hasActiveCronSessionOwner(
  service: Pick<CronService, 'listDefinitions'>,
  sessionId: string,
): boolean {
  let cursor: string | undefined;
  do {
    const page = service.listDefinitions({
      limit: OWNER_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    if (
      page.items.some(
        (definition) =>
          definition.enabled &&
          definition.sessionTarget.mode === 'sessionId' &&
          definition.sessionTarget.sessionId === sessionId,
      )
    ) {
      return true;
    }
    if (!page.hasMore) return false;
    if (!page.nextCursor) throw new Error('Cron owner lookup returned an incomplete page cursor');
    cursor = page.nextCursor;
  } while (true);
}
