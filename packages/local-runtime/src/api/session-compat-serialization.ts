import { join } from 'node:path';

import type { LocalSessionRecord } from '../sessions/controller.js';
import {
  isLocalChildWorkerSession,
  isLocalSidebarTreeSession,
} from '../sessions/session-policy.js';
import { toDaemonSession } from '../sessions/serialization.js';
import { isVisibleTreeSession } from './host-helpers.js';

export async function serializeLocalSessionTree(input: {
  sessions: LocalSessionRecord[];
  url: URL;
  agentName: string;
  agentNames?: readonly string[];
  dataDir: string;
  getSessionById: (sessionId: string) => Promise<LocalSessionRecord | undefined>;
}): Promise<Array<Record<string, unknown>>> {
  const archivedOnly =
    input.url.searchParams.get('onlyCompressed') === 'true' ||
    input.url.searchParams.get('only_archived') === 'true';
  const includeArchivedRoots =
    archivedOnly ||
    input.url.searchParams.get('includeCompressed') === 'true' ||
    input.url.searchParams.get('include_archived') === 'true';
  const excludePurposePrefix = input.url.searchParams.get('excludePurposePrefix') ?? '';
  const includeHidden =
    input.url.searchParams.get('includeHidden') === 'true' ||
    input.url.searchParams.get('include_hidden') === 'true';
  const visible = input.sessions.filter(
    (session) =>
      (!archivedOnly || session.archived) &&
      (includeHidden || isLocalSidebarTreeSession(session)) &&
      (!excludePurposePrefix ||
        !session.purpose ||
        !session.purpose.startsWith(excludePurposePrefix)),
  );
  const visibleById = new Map(visible.map((session) => [session.sessionId, session]));
  const fullById = new Map(input.sessions.map((session) => [session.sessionId, session]));
  const rootAgentNames = new Set(
    input.agentNames && input.agentNames.length > 0 ? input.agentNames : [input.agentName],
  );
  const childrenByParent = new Map<string, LocalSessionRecord[]>();
  for (const session of visible) {
    const parentSessionId = session.parentSessionId;
    if (!parentSessionId) continue;
    const parent = visibleById.get(parentSessionId);
    if (!parent || (!includeArchivedRoots && parent.archived)) continue;
    const children = childrenByParent.get(parentSessionId) ?? [];
    children.push(session);
    childrenByParent.set(parentSessionId, children);
  }
  const roots = visible.filter((session) => {
    if (!rootAgentNames.has(session.agentName)) return false;
    if (!includeArchivedRoots && session.archived) return false;
    if (!session.parentSessionId) return true;
    if (!includeHidden && isLocalChildWorkerSession(session)) return false;
    const parentAll = fullById.get(session.parentSessionId);
    if (parentAll && parentAll.agentName !== session.agentName) return false;
    const parent = visibleById.get(session.parentSessionId);
    if (!parent) return true;
    if (!includeArchivedRoots && parent.archived) return true;
    return false;
  });
  const serializeNode = async (
    session: LocalSessionRecord,
    ancestors = new Set<string>(),
  ): Promise<Record<string, unknown>> => {
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(session.sessionId);
    const children = (childrenByParent.get(session.sessionId) ?? []).filter(
      (child) => !nextAncestors.has(child.sessionId),
    );
    return {
      ...(await serializeLocalSession({
        session,
        dataDir: input.dataDir,
        getSessionById: input.getSessionById,
      })),
      childSessions: await Promise.all(
        children.map((child) => serializeNode(child, nextAncestors)),
      ),
    };
  };
  return Promise.all(roots.map((session) => serializeNode(session)));
}

export async function serializeLocalSession(input: {
  session: LocalSessionRecord;
  dataDir: string;
  getSessionById: (sessionId: string) => Promise<LocalSessionRecord | undefined>;
}): Promise<Record<string, unknown>> {
  const rootSessionId = await resolveLocalRootSessionId(input.session, input.getSessionById);
  return {
    ...toDaemonSession(input.session),
    scratchpadPath: join(input.dataDir, 'scratchpads', rootSessionId, 'scratchpad.md'),
  };
}

async function resolveLocalRootSessionId(
  session: LocalSessionRecord,
  getSessionById: (sessionId: string) => Promise<LocalSessionRecord | undefined>,
): Promise<string> {
  const visited = new Set<string>([session.sessionId]);
  let current = session;
  while (current.parentSessionId && !visited.has(current.parentSessionId)) {
    visited.add(current.parentSessionId);
    const parent = await getSessionById(current.parentSessionId);
    if (!parent) break;
    current = parent;
  }
  return current.sessionId;
}
