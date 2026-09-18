import type {
  SessionKind,
  SessionListOptions,
  SessionRecord,
  SessionRepository,
} from '../repo/contract.js';
import { SessionQueryServiceError } from '../errors.js';
import { projectPrimarySessionAgentName } from '../agent-name.js';
import { sessionKindForLegacyPurposePrefix } from '../repo/drizzle/normalization.js';
import { sessionTreeFilterFromRequest } from './tree-query-policy.js';

export interface SessionListInput extends SessionListOptions {
  readonly includeArchived?: boolean;
  readonly onlyArchived?: boolean;
  readonly onlyCompressed?: boolean;
}

export interface SessionSearchInput {
  readonly keyword?: string;
  readonly agentName?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SessionTreeInput extends SessionListInput {
  readonly agentName: string;
}

/**
 * Sidebar aggregate input. `agentName` is dropped rather than made optional so
 * a caller cannot accidentally pass an Agent and silently get an Agent-scoped
 * page back from an API whose contract promises "every Agent".
 */
export type SessionSidebarTreeInput = Omit<SessionTreeInput, 'agentName'>;

export interface SessionRecordPage {
  readonly sessions: readonly SessionRecord[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export type SessionFilteredPageInput = Omit<SessionListOptions, 'offset' | 'scanLimit'>;

export interface SessionTreeRecord {
  readonly session: SessionRecord;
  readonly children: readonly SessionRecord[];
}

export interface SessionTreeRecordPage {
  readonly sessions: readonly SessionTreeRecord[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface SessionMetadataDiscovery {
  discover(agentName?: string): Promise<void>;
  ensureMetadataReady(sessionId: string): Promise<SessionRecord | undefined>;
}

export class SessionQueryService {
  constructor(
    private readonly repository: Pick<
      SessionRepository,
      'list' | 'listPage' | 'searchPage' | 'listRootPage' | 'listChildrenMany' | 'get'
    >,
    private readonly discovery?: SessionMetadataDiscovery,
  ) {}

  async list(input: SessionListInput = {}): Promise<SessionRecordPage> {
    await this.discovery?.discover(input.agentName);
    const archived = archivedFilter(input);
    const page = await this.repository.listPage({
      ...input,
      archived,
      excludeInternalDefaultRoots: archived === true,
      includeHidden: input.includeHidden === true,
      ...sessionKindFilters(input),
    });
    return projectPrimarySessionPage(page, input.agentName);
  }

  async listExact(input?: SessionListOptions): Promise<readonly SessionRecord[]> {
    await this.discovery?.discover(input?.agentName);
    const sessions = await this.repository.list(input);
    return projectPrimarySessions(sessions, input?.agentName);
  }

  async listFilteredPage(input: SessionFilteredPageInput): Promise<SessionRecordPage> {
    await this.discovery?.discover(input.agentName);
    return projectPrimarySessionPage(await this.repository.listPage(input), input.agentName);
  }

  async search(input: SessionSearchInput): Promise<SessionRecordPage> {
    return projectPrimarySessionPage(await this.repository.searchPage(input), input.agentName);
  }

  async tree(input: SessionTreeInput): Promise<SessionTreeRecordPage> {
    await this.discovery?.discover(input.agentName);
    const filter = sessionTreeFilterFromRequest(input, input.includeHidden === true);
    const roots = await this.repository.listRootPage({
      agentName: input.agentName,
      ...filter,
      limit: input.limit,
      cursor: input.cursor,
    });
    const children = await this.repository.listChildrenMany(
      roots.sessions.map(({ sessionId }) => sessionId),
      filter,
    );
    return {
      sessions: roots.sessions.map((session) => ({
        session: projectPrimarySessionAgentName(session, input.agentName),
        children: (children.get(session.sessionId) ?? []).map((child) =>
          projectPrimarySessionAgentName(child, input.agentName),
        ),
      })),
      hasMore: roots.hasMore,
      ...(roots.nextCursor ? { nextCursor: roots.nextCursor } : {}),
    };
  }

  /**
   * Cross-Agent sidebar aggregate: one recency-ordered page of top-level
   * Sessions owned by *any* Agent.
   *
   * Why this exists: Cloud gets its all-Agent sidebar projection server-side,
   * but local(daemon) only had the Agent-scoped `tree()`. Every caller passed a
   * concrete Agent, so a non-primary Agent's root conversation — and an IM
   * `channel` Session parked under a non-primary Agent — could never reach the
   * sidebar even though the row itself was `visible` and un-archived.
   *
   * Design notes:
   * - Single keyset-cursor query instead of fan-out-per-Agent. Merging N Agent
   *   pages client-side would break `updated_at DESC` paging (each source has
   *   its own cursor), and with 16 Agents it would also mean 16 round trips.
   * - No `projectPrimarySessionAgentName` projection. `tree()` rewrites a
   *   primary-family Agent name onto the requested one so an Agent-scoped view
   *   stays self-consistent; here there is no requested Agent, and the UI needs
   *   each row's real owner to attribute it (notably IM rows).
   * - `cron`/`peek` stay excluded through the shared
   *   `sessionTreeFilterFromRequest` default, so this path inherits the same
   *   internal-tree policy as `tree()`.
   */
  async sidebarTree(input: SessionSidebarTreeInput = {}): Promise<SessionTreeRecordPage> {
    // No Agent name: discovery hydrates metadata across all Agents.
    await this.discovery?.discover();
    const filter = sessionTreeFilterFromRequest(input, input.includeHidden === true);
    const roots = await this.repository.listRootPage({
      // Intentionally no `agentName` — see SessionRootPageOptions.agentName.
      ...filter,
      limit: input.limit,
      cursor: input.cursor,
    });
    const children = await this.repository.listChildrenMany(
      roots.sessions.map(({ sessionId }) => sessionId),
      filter,
    );
    return {
      sessions: roots.sessions.map((session) => ({
        session,
        children: children.get(session.sessionId) ?? [],
      })),
      hasMore: roots.hasMore,
      ...(roots.nextCursor ? { nextCursor: roots.nextCursor } : {}),
    };
  }

  async get(sessionId: string): Promise<SessionRecord> {
    const session = await this.find(sessionId);
    if (!session) {
      throw new SessionQueryServiceError('session-not-found', `Session not found: ${sessionId}`);
    }
    return session;
  }

  async find(sessionId: string): Promise<SessionRecord | undefined> {
    await this.discovery?.ensureMetadataReady(sessionId);
    return this.repository.get(sessionId);
  }
}

function archivedFilter(input: SessionListInput): boolean | undefined {
  if (input.archived !== undefined) return input.archived;
  if (input.onlyArchived === true || input.onlyCompressed === true) return true;
  return input.includeArchived === true ? undefined : false;
}

function projectPrimarySessionPage(
  page: SessionRecordPage,
  requestedAgentName: string | undefined,
): SessionRecordPage {
  return {
    ...page,
    sessions: projectPrimarySessions(page.sessions, requestedAgentName),
  };
}

function projectPrimarySessions(
  sessions: readonly SessionRecord[],
  requestedAgentName: string | undefined,
): readonly SessionRecord[] {
  return requestedAgentName
    ? sessions.map((session) => projectPrimarySessionAgentName(session, requestedAgentName))
    : sessions;
}

function sessionKindFilters(input: SessionListInput): {
  readonly includeSessionKinds?: readonly SessionKind[];
  readonly excludeSessionKinds?: readonly SessionKind[];
  readonly includePurposePrefix?: string;
  readonly excludePurposePrefix?: string;
} {
  const includeKind = mapPurposePrefix(input.includePurposePrefix);
  const excludeKind = mapPurposePrefix(input.excludePurposePrefix);
  const included = mergeKinds(input.includeSessionKinds, includeKind);
  const excluded = mergeKinds(
    [...defaultExcludedKinds(input), ...(input.excludeSessionKinds ?? [])],
    excludeKind,
  );
  return {
    ...optionalKinds('includeSessionKinds', included),
    ...optionalKinds('excludeSessionKinds', excluded),
    ...literalPurposeFilters(input, includeKind, excludeKind),
  };
}

function mapPurposePrefix(prefix: string | undefined): SessionKind | undefined {
  return prefix ? sessionKindForLegacyPurposePrefix(prefix) : undefined;
}

function defaultExcludedKinds(input: SessionListInput): readonly SessionKind[] {
  return input.includeHidden === true || input.includePurposePrefix ? [] : ['cron'];
}

function mergeKinds(
  kinds: readonly SessionKind[] | undefined,
  extra: SessionKind | undefined,
): readonly SessionKind[] {
  const merged = extra ? [...(kinds ?? []), extra] : [...(kinds ?? [])];
  return [...new Set(merged)];
}

function optionalKinds<K extends 'includeSessionKinds' | 'excludeSessionKinds'>(
  key: K,
  kinds: readonly SessionKind[],
): Partial<Record<K, readonly SessionKind[]>> {
  return kinds.length > 0 ? ({ [key]: kinds } as Partial<Record<K, readonly SessionKind[]>>) : {};
}

function literalPurposeFilters(
  input: SessionListInput,
  includeKind: SessionKind | undefined,
  excludeKind: SessionKind | undefined,
): Pick<SessionListOptions, 'includePurposePrefix' | 'excludePurposePrefix'> {
  return {
    ...(input.includePurposePrefix && !includeKind
      ? { includePurposePrefix: input.includePurposePrefix }
      : {}),
    ...(input.excludePurposePrefix && !excludeKind
      ? { excludePurposePrefix: input.excludePurposePrefix }
      : {}),
  };
}
