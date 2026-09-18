import type { AbortSessionReq } from '@mavis/local-runtime-v2/cli-service';
import type {
  ListTuiSessionPageInput,
  TuiDelegationSnapshot,
  TuiDelegationStopReceipt,
  TuiSessionPage,
} from '../port.js';
import {
  collectTuiDelegatedSessions,
  isActiveTuiDelegatedAgent,
  toTuiDelegatedAgent,
} from '../delegation.js';

const DELEGATION_PAGE_SIZE = 200;
const MAX_DELEGATION_PAGES = 20;
const MAX_STOP_PASSES = 3;

export interface TuiDelegationAccessOptions {
  listSessionPage(input: ListTuiSessionPageInput): Promise<TuiSessionPage>;
  abortSession(req: AbortSessionReq): Promise<boolean>;
}

export class TuiDelegationAccess {
  constructor(private readonly options: TuiDelegationAccessOptions) {}

  async getSnapshot(rootSessionId: string): Promise<TuiDelegationSnapshot> {
    const sessions = await this.listAllSessions();
    const members = collectTuiDelegatedSessions(sessions, rootSessionId).map((session) =>
      toTuiDelegatedAgent(session),
    );
    return { schemaVersion: 1, rootSessionId, members };
  }

  async stop(rootSessionId: string): Promise<TuiDelegationStopReceipt> {
    const failedSessionIds = new Set<string>();
    const inactiveSessionIds = new Set<string>();
    const stoppedSessionIds = new Set<string>();
    const rootStopped =
      (await this.abort(rootSessionId, failedSessionIds, inactiveSessionIds)) === 'stopped';
    const initial = await this.getSnapshot(rootSessionId);
    let pending = initial.members.filter(isActiveTuiDelegatedAgent);

    for (let pass = 0; pass < MAX_STOP_PASSES; pass += 1) {
      for (const member of pending) {
        if (stoppedSessionIds.has(member.sessionId)) continue;
        if (
          (await this.abort(member.sessionId, failedSessionIds, inactiveSessionIds)) === 'stopped'
        ) {
          stoppedSessionIds.add(member.sessionId);
        }
      }
      const refreshed = await this.getSnapshot(rootSessionId);
      pending = refreshed.members.filter(
        (member) => isActiveTuiDelegatedAgent(member) && !stoppedSessionIds.has(member.sessionId),
      );
      if (pending.length === 0) break;
    }

    const final = await this.getSnapshot(rootSessionId);
    return {
      schemaVersion: 1,
      rootSessionId,
      rootStopped,
      stoppedSessionIds: [...stoppedSessionIds],
      activeSessionIds: final.members
        .filter(isActiveTuiDelegatedAgent)
        .filter(
          ({ sessionId }) =>
            !stoppedSessionIds.has(sessionId) && !inactiveSessionIds.has(sessionId),
        )
        .map(({ sessionId }) => sessionId),
      failedSessionIds: [...failedSessionIds],
    };
  }

  private async listAllSessions() {
    const sessions = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_DELEGATION_PAGES; pageIndex += 1) {
      const page = await this.options.listSessionPage({
        allAgents: true,
        includeArchived: true,
        includeHidden: true,
        limit: DELEGATION_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      sessions.push(...page.sessions);
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return sessions;
  }

  private async abort(
    sessionId: string,
    failedSessionIds: Set<string>,
    inactiveSessionIds: Set<string>,
  ): Promise<'stopped' | 'inactive' | 'failed'> {
    try {
      if (await this.options.abortSession({ id: sessionId, reason: 'user_stop' })) {
        inactiveSessionIds.delete(sessionId);
        return 'stopped';
      }
      inactiveSessionIds.add(sessionId);
      return 'inactive';
    } catch {
      failedSessionIds.add(sessionId);
      return 'failed';
    }
  }
}
