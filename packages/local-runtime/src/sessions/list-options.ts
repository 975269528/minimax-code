import type { LocalSessionListOptions, LocalSessionRecord } from './controller.js';

export { applyLocalSessionListOptions } from './record-list-options.js';

/** Recency scan cap for `/session/search`: only the newest N session records are considered. */
export const LOCAL_SESSION_SEARCH_SCAN_LIMIT = 1000;

export function readLocalSessionListOptions(
  url: URL,
  opts?: { agentName?: string },
): LocalSessionListOptions {
  const archivedOnly =
    url.searchParams.get('onlyCompressed') === 'true' ||
    url.searchParams.get('only_archived') === 'true';
  const includeArchived =
    archivedOnly ||
    url.searchParams.get('includeCompressed') === 'true' ||
    url.searchParams.get('include_archived') === 'true';
  const excludePurposePrefix = readOptionalSearchParam(url, 'excludePurposePrefix');
  const includePurposePrefix = readOptionalSearchParam(url, 'includePurposePrefix');
  const search =
    readOptionalSearchParam(url, 'keyword') ??
    readOptionalSearchParam(url, 'query') ??
    readOptionalSearchParam(url, 'q');
  const cursor = readOptionalSearchParam(url, 'cursor');
  const limit = readOptionalPositiveInt(url.searchParams.get('limit'));
  const offset = readOptionalNonNegativeInt(url.searchParams.get('offset'));

  return {
    ...(opts?.agentName ? { agentName: opts.agentName } : {}),
    ...(archivedOnly ? { archived: true } : includeArchived ? {} : { archived: false }),
    includeHidden:
      url.searchParams.get('includeHidden') === 'true' ||
      url.searchParams.get('include_hidden') === 'true',
    ...(excludePurposePrefix ? { excludePurposePrefix } : {}),
    ...(includePurposePrefix ? { includePurposePrefix } : {}),
    ...(search ? { search } : {}),
    ...(cursor ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
  };
}

export function readLocalSessionSearchOptions(url: URL): {
  agentName?: string;
  limit: number;
  options: LocalSessionListOptions;
} {
  return {
    agentName:
      readOptionalSearchParam(url, 'agent_name') ?? readOptionalSearchParam(url, 'agentName'),
    limit: readPositiveInt(url.searchParams.get('limit'), 50),
    options: {
      ...readLocalSessionListOptions(url),
      // Task search excludes root/main sessions and never scans more than the
      // most recently updated LOCAL_SESSION_SEARCH_SCAN_LIMIT records, so the
      // store can serve it from the updated_at_ms index.
      sessionType: 'branch',
      scanLimit: LOCAL_SESSION_SEARCH_SCAN_LIMIT,
    },
  };
}

export async function pageLocalSessionSearch(
  url: URL,
  listSessions: (
    agentName: string | undefined,
    options: LocalSessionListOptions,
  ) => Promise<LocalSessionRecord[]>,
): Promise<{ sessions: LocalSessionRecord[]; hasMore: boolean; nextCursor?: string }> {
  const { agentName, limit, options } = readLocalSessionSearchOptions(url);
  const sessions = await listSessions(agentName, { ...options, limit: limit + 1 });
  const hasMore = sessions.length > limit;
  if (hasMore) sessions.pop();
  return {
    sessions,
    hasMore,
    ...(hasMore && sessions.at(-1)?.sessionId ? { nextCursor: sessions.at(-1)!.sessionId } : {}),
  };
}

export function withoutLocalSessionPagination(
  options?: LocalSessionListOptions,
): LocalSessionListOptions | undefined {
  if (!options) return undefined;
  const { cursor: _cursor, limit: _limit, offset: _offset, ...rest } = options;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function readOptionalSearchParam(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value || undefined;
}

function readPositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readOptionalPositiveInt(value: string | null): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readOptionalNonNegativeInt(value: string | null): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
