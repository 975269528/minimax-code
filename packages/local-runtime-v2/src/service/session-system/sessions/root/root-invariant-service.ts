import type { SessionRecord, SessionRepository } from '../repo/contract.js';
import type { SessionRootCreationCapability } from '../lifecycle/record-service.js';
import { SessionRootSwapError } from '../repo/contract.js';
import { isSameSessionAgentName } from '../agent-name.js';
import { buildArchivedRootTitle } from './archived-root-title.js';

export interface RootAgentRecord {
  readonly agentName: string;
  readonly rootSessionId?: string;
  readonly displayName?: string;
  readonly defaultWorkspaceDir?: string;
}

export interface RootAgentPort {
  clearRootSession(agentName: string, sessionId: string): Promise<boolean>;
  get(agentName: string): Promise<RootAgentRecord | undefined>;
  setRootSession(agentName: string, sessionId: string): Promise<boolean>;
}

export interface RootReplacementPlan {
  readonly agentName: string;
  readonly fallbackName: string;
  readonly nextRoot: SessionRecord;
  readonly previousRoots: readonly SessionRecord[];
  readonly archivedRootTitle: string;
}

export interface RootReplacementCommit {
  readonly agentName: string;
  readonly nextRoot: SessionRecord;
  readonly previousRoots: readonly SessionRecord[];
  readonly archivedRootTitle: string;
}

export interface RootSessionInvariantServiceOptions {
  readonly sessions: Pick<SessionRepository, 'get' | 'listRootPage' | 'swapRoot'>;
  readonly agents: RootAgentPort;
  readonly creation: SessionRootCreationCapability;
  readonly legacyRoot?: { adopt(agentName: string): Promise<SessionRecord | undefined> };
  readonly locale?: () => string;
  readonly onAgentPointerFailure?: (input: {
    readonly agentName: string;
    readonly sessionId: string;
    readonly error: unknown;
  }) => void;
}

export class RootInvariantError extends Error {
  constructor(
    readonly reason: 'agent-not-found' | 'replacement-not-found',
    message: string,
  ) {
    super(message);
    this.name = 'RootInvariantError';
  }
}

export class RootSessionInvariantService {
  private readonly ensureOperations = new Map<string, Promise<SessionRecord>>();

  constructor(private readonly options: RootSessionInvariantServiceOptions) {}

  getRootSessionByAgent(agentName: string): Promise<SessionRecord> {
    const current = this.ensureOperations.get(agentName);
    if (current) return current;
    const operation = this.runEnsureRootSession(agentName);
    this.ensureOperations.set(agentName, operation);
    return operation;
  }

  private async runEnsureRootSession(agentName: string): Promise<SessionRecord> {
    try {
      return await this.ensureRootSession(agentName);
    } finally {
      this.ensureOperations.delete(agentName);
    }
  }

  async prepareReplacement(
    agentName: string,
    nextRootSessionId: string,
  ): Promise<RootReplacementPlan> {
    const agent = await this.requireAgent(agentName);
    const nextRoot = await this.options.sessions.get(nextRootSessionId);
    if (!isSameAgentPiSession(nextRoot, agentName))
      throw rootNotFound(agentName, nextRootSessionId);
    const previousRoots = (await this.findRoots(agentName)).filter(
      ({ sessionId }) => sessionId !== nextRootSessionId,
    );
    const fallbackName = agent.displayName?.trim() || agentName;
    return {
      agentName,
      fallbackName,
      nextRoot,
      previousRoots,
      archivedRootTitle: buildArchivedRootTitle({
        oldTitle: previousRoots[0]?.title,
        fallbackName,
        locale: this.options.locale?.(),
      }),
    };
  }

  async commitReplacement(
    plan: RootReplacementPlan,
    options: { readonly linkPreviousRootsToNext?: boolean } = {},
  ): Promise<RootReplacementCommit> {
    try {
      const swapped = await this.options.sessions.swapRoot({
        agentName: plan.agentName,
        nextRootSessionId: plan.nextRoot.sessionId,
        archivedRootTitle: plan.archivedRootTitle,
        ...(options.linkPreviousRootsToNext ? { linkPreviousRootsToNext: true } : {}),
      });
      await this.repairAgentPointer(plan.agentName, swapped.nextRoot.sessionId);
      return {
        agentName: plan.agentName,
        previousRoots: swapped.previousRoots,
        nextRoot: swapped.nextRoot,
        archivedRootTitle: plan.archivedRootTitle,
      };
    } catch (error) {
      if (error instanceof SessionRootSwapError) {
        throw rootNotFound(plan.agentName, plan.nextRoot.sessionId);
      }
      throw error;
    }
  }

  async clearSessionReference(session: SessionRecord): Promise<void> {
    await this.options.agents.clearRootSession(session.agentName, session.sessionId);
  }

  private async ensureRootSession(agentName: string): Promise<SessionRecord> {
    const agent = await this.requireAgent(agentName);
    const pointed = agent.rootSessionId
      ? await this.options.sessions.get(agent.rootSessionId)
      : undefined;
    const pointedRoot = isRootForAgent(pointed, agentName) ? pointed : undefined;
    if (pointedRoot && !pointedRoot.archived) return pointedRoot;
    const roots = await this.findRoots(agentName);
    const existing = roots.find((root) => !root.archived);
    if (existing) {
      if (agent.rootSessionId !== existing.sessionId) {
        await this.repairAgentPointer(agentName, existing.sessionId);
      }
      return existing;
    }
    const adopted = await this.options.legacyRoot?.adopt(agentName);
    if (isRootForAgent(adopted, agentName) && !adopted.archived) {
      await this.repairAgentPointer(agentName, adopted.sessionId);
      return adopted;
    }
    const created = await this.createRootSession(agent);
    await this.repairAgentPointer(agentName, created.sessionId);
    return created;
  }

  private async createRootSession(agent: RootAgentRecord): Promise<SessionRecord> {
    return this.options.creation.createRootSession({
      agentName: agent.agentName,
    });
  }

  private async requireAgent(agentName: string): Promise<RootAgentRecord> {
    const agent = await this.options.agents.get(agentName);
    if (!agent) throw new RootInvariantError('agent-not-found', `Agent not found: ${agentName}`);
    return agent;
  }

  private async findRoots(agentName: string): Promise<SessionRecord[]> {
    const roots: SessionRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.options.sessions.listRootPage({
        agentName,
        runtime: 'pi-agent',
        includeHidden: true,
        excludeInternalTreeSessions: false,
        // Agent pointers may only adopt user-facing conversation roots. Cron,
        // channel, peek, and task rows are separate internal trees and must
        // never participate in root repair/replacement.
        includeSessionKinds: ['conversation'],
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      roots.push(
        ...page.sessions.filter(
          (session) =>
            session.sessionType === 'root' && isSameSessionAgentName(session.agentName, agentName),
        ),
      );
      cursor = page.hasMore ? page.nextCursor : undefined;
      if (page.hasMore && !cursor)
        throw new Error('Session root page is missing its continuation cursor');
    } while (cursor);
    return roots;
  }

  private async repairAgentPointer(agentName: string, sessionId: string): Promise<void> {
    try {
      const updated = await this.options.agents.setRootSession(agentName, sessionId);
      if (!updated) throw new Error(`Agent pointer target not found: ${agentName}`);
    } catch (error) {
      try {
        this.options.onAgentPointerFailure?.({ agentName, sessionId, error });
      } catch {
        // The Root row remains authoritative; the pointer is repaired on the next read.
      }
    }
  }
}

function isRootForAgent(
  session: SessionRecord | undefined,
  agentName: string,
): session is SessionRecord {
  return isSameAgentPiSession(session, agentName) && session.sessionType === 'root';
}

function isSameAgentPiSession(
  session: SessionRecord | undefined,
  agentName: string,
): session is SessionRecord {
  return Boolean(
    session &&
    isSameSessionAgentName(session.agentName, agentName) &&
    session.runtime === 'pi-agent',
  );
}

function rootNotFound(agentName: string, sessionId: string): RootInvariantError {
  return new RootInvariantError(
    'replacement-not-found',
    `Root replacement session not found for Agent ${agentName}: ${sessionId}`,
  );
}
