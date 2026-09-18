import type { MessageRepository, QueryCollapseState } from '../../service/session-system/index.js';

interface QueryCollapseGoalState {
  readonly goalId: string;
  readonly status: string;
}

const STEERING_QUERY_MARKER = ':s:';

export interface QueryCollapseKeyResolver {
  queryKeyForTurn(sessionId: string, turnId: string): Promise<string>;
  queryKeyForContinuation(sessionId: string, turnId: string): Promise<string>;
}

export interface QueryCollapseKeyResolverOptions {
  readonly state: Pick<QueryCollapseState, 'findByCurrentTurn' | 'findByKey'>;
  readonly messages?: Pick<MessageRepository, 'listRecent'>;
  readonly getGoalBySession?: (sessionId: string) => Promise<QueryCollapseGoalState | undefined>;
}

export function queryCollapseQueryKey(turnId: string, goalId?: string): string {
  return goalId ? `goal:${goalId}:turn:${turnId}` : `turn:${turnId}`;
}

/** Explicit steered-provenance fields projected next to a message `query_key`. */
export interface QueryCollapseSteeringProjection {
  readonly steered?: true;
  readonly root_query_key?: string;
}

/**
 * Derives the explicit steered fields for one query key at projection time.
 * Old rows persisted with only a marked key project the same fields, so no
 * migration is needed and consumers never parse the marker themselves.
 */
export function queryCollapseSteeringProjection(
  queryKey: string | undefined,
): QueryCollapseSteeringProjection {
  if (!queryKey) return {};
  const rootQueryKey = queryCollapseRootQueryKey(queryKey);
  return rootQueryKey === queryKey ? {} : { steered: true, root_query_key: rootQueryKey };
}

function queryCollapseRootQueryKey(queryKey: string): string {
  const markerIndex = queryKey.indexOf(STEERING_QUERY_MARKER);
  return markerIndex < 0 ? queryKey : queryKey.slice(0, markerIndex);
}

/** Resolves one stable display identity before a Turn enters execution. */
export function createQueryCollapseKeyResolver(
  options: QueryCollapseKeyResolverOptions,
): QueryCollapseKeyResolver {
  return {
    queryKeyForTurn: (sessionId, turnId) => resolveNewQueryKey(options, sessionId, turnId),
    queryKeyForContinuation: async (sessionId, turnId) => {
      const priorQueryKey = await latestVisibleQueryKey(options, sessionId);
      if (priorQueryKey) {
        try {
          const persisted = await options.state.findByKey(sessionId, priorQueryKey);
          if (persisted) return persisted.queryKey;
        } catch {
          // A missing display projection falls back to the deterministic Turn identity.
        }
      }
      return resolveNewQueryKey(options, sessionId, turnId);
    },
  };
}

async function resolveNewQueryKey(
  options: QueryCollapseKeyResolverOptions,
  sessionId: string,
  turnId: string,
): Promise<string> {
  try {
    const existing = await options.state.findByCurrentTurn(sessionId, turnId);
    if (existing) return existing.queryKey;
  } catch {
    // Identity remains derivable when the optional sidecar is unavailable.
  }
  if (!options.getGoalBySession) return queryCollapseQueryKey(turnId);
  try {
    const goal = await options.getGoalBySession(sessionId);
    return queryCollapseQueryKey(turnId, goal?.status === 'complete' ? undefined : goal?.goalId);
  } catch {
    return queryCollapseQueryKey(turnId);
  }
}

async function latestVisibleQueryKey(
  options: QueryCollapseKeyResolverOptions,
  sessionId: string,
): Promise<string | undefined> {
  if (!options.messages) return undefined;
  try {
    const messages = await options.messages.listRecent(sessionId, { limit: 1, role: 'user' });
    const queryKey = messages[0]?.query_key;
    return typeof queryKey === 'string' && queryKey.length > 0 ? queryKey : undefined;
  } catch {
    return undefined;
  }
}
