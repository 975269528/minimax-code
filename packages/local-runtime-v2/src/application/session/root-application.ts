import type {
  GetRootSessionInput as GetRootSessionReq,
  GetRootSessionResult as GetRootSessionResp,
  ReplaceRootSessionInput as ReplaceRootSessionReq,
  ReplaceRootSessionResult as ReplaceRootSessionResp,
} from "@mavis/protocol/local";

import {
  RootInvariantError,
  type RootArchiveTitleCommittedFact,
  type RootArchiveTitleFactObserver,
  type RootArchiveTitleService,
  type RootReplacementCommit,
  type RootSessionInvariantService,
  type SessionRecord,
} from "../../service/session-system/index.js";
import { AgentServiceError } from "../../service/agent/index.js";
import type { ApplicationContext } from "../context.js";
import { AppError } from "../errors.js";
import { publishBestEffort, type GlobalEventPublisher } from "../events.js";
import { toSessionInfoView } from "./wire.js";

export interface RootReplacementFactObserver {
  observe(fact: RootReplacementCommit): void | Promise<void>;
}

export interface SessionRootReplacementResult extends RootReplacementCommit {
  readonly fallbackName: string;
}

export interface SessionRootEventProjectorOptions {
  readonly publish: GlobalEventPublisher;
}

/** Projects the admitted subset of a committed Root replacement. */
export class SessionRootEventProjector implements RootReplacementFactObserver {
  constructor(private readonly options: SessionRootEventProjectorOptions) {}

  observe(fact: RootReplacementCommit): void {
    for (const previousRoot of fact.previousRoots) {
      publishBestEffort(this.options.publish, {
        type: "session.title_updated",
        payload: {
          sessionId: previousRoot.sessionId,
          agentName: fact.agentName,
          title: fact.archivedRootTitle,
        },
      });
    }
    publishBestEffort(this.options.publish, {
      type: "session.title_updated",
      payload: {
        sessionId: fact.nextRoot.sessionId,
        agentName: fact.agentName,
        title: "Main",
      },
    });
    publishBestEffort(this.options.publish, {
      type: "agent.updated",
      payload: {
        agentName: fact.agentName,
        agentId: fact.agentName,
        change: "updated",
      },
    });
  }
}

/** Projects a later committed archive-title refinement without archive-state events. */
export class RootArchiveTitleEventProjector
  implements RootArchiveTitleFactObserver
{
  constructor(private readonly options: SessionRootEventProjectorOptions) {}

  observe(fact: RootArchiveTitleCommittedFact): void {
    publishBestEffort(this.options.publish, {
      type: "session.title_updated",
      payload: {
        sessionId: fact.sessionId,
        agentName: fact.agentName,
        title: fact.title,
      },
    });
  }
}

export type RootBestEffortFailureStage =
  | "turn-abort"
  | "archive-title"
  | "fact-observer";

export interface SessionRootApplicationOptions {
  readonly invariant: Pick<
    RootSessionInvariantService,
    "getRootSessionByAgent" | "prepareReplacement" | "commitReplacement"
  >;
  readonly resolveAgentWriteTarget: (requestRef: string) => Promise<string>;
  readonly requireExactAgentKey: (requestRef: string) => Promise<string>;
  readonly turn: {
    abort(input: {
      readonly sessionId: string;
      readonly reason: "root-session-replaced";
    }): Promise<unknown>;
  };
  readonly archiveTitle: Pick<RootArchiveTitleService, "generate">;
  readonly facts?: RootReplacementFactObserver;
  readonly onBestEffortFailure?: (input: {
    readonly stage: RootBestEffortFailureStage;
    readonly agentName: string;
    readonly sessionId: string;
    readonly error: unknown;
  }) => void;
}

/** Owns generated Root mapping and the source-ordered replacement workflow. */
export class SessionRootApplication {
  constructor(private readonly options: SessionRootApplicationOptions) {}

  async getRootSession(
    _context: ApplicationContext,
    request: GetRootSessionReq,
  ): Promise<GetRootSessionResp> {
    const agentName = await this.resolvePublicAgentName(request.name);
    return {
      session: toSessionInfoView(await this.getRootSessionByAgent(agentName)),
    };
  }

  async replaceRootSession(
    _context: ApplicationContext,
    request: ReplaceRootSessionReq,
  ): Promise<ReplaceRootSessionResp> {
    const agentName = await this.resolvePublicAgentName(request.name);
    await this.replaceRootSessionByAgent(agentName, request.sessionId);
    return { ok: true };
  }

  getRootSessionByAgent(agentName: string): Promise<SessionRecord> {
    return this.invoke(() =>
      this.options.invariant.getRootSessionByAgent(agentName),
    );
  }

  async replaceRootSessionByAgent(
    agentName: string,
    nextRootSessionId: string,
    options: { readonly linkPreviousRootsToNext?: boolean } = {},
  ): Promise<SessionRecord> {
    const { nextRoot } = await this.replaceRootSessionWithResult(
      agentName,
      nextRootSessionId,
      options,
    );
    return nextRoot;
  }

  replaceRootSessionWithResult(
    agentName: string,
    nextRootSessionId: string,
    options: { readonly linkPreviousRootsToNext?: boolean } = {},
  ): Promise<SessionRootReplacementResult> {
    return this.invoke(() =>
      this.runReplacement(agentName, nextRootSessionId, options),
    );
  }

  private resolvePublicAgentName(requestRef: string): Promise<string> {
    // `agent:` is an explicit physical-owner request. Let AgentService validate
    // and unwrap it; only bare generated aliases may select the current winner.
    return this.invoke(() =>
      requestRef.trim().toLowerCase().startsWith("agent:")
        ? this.options.requireExactAgentKey(requestRef)
        : this.options.resolveAgentWriteTarget(requestRef),
    );
  }

  private async runReplacement(
    agentName: string,
    nextRootSessionId: string,
    options: { readonly linkPreviousRootsToNext?: boolean },
  ): Promise<SessionRootReplacementResult> {
    const plan = await this.options.invariant.prepareReplacement(
      agentName,
      nextRootSessionId,
    );
    await Promise.all(
      plan.previousRoots.map((root) =>
        this.abortOldRoot(agentName, root.sessionId),
      ),
    );
    const committed = await this.options.invariant.commitReplacement(
      plan,
      options,
    );
    await Promise.all(
      committed.previousRoots.map((root) =>
        this.runPostCommitParticipants(agentName, root, plan.fallbackName),
      ),
    );
    await this.observeFact(committed);
    return { ...committed, fallbackName: plan.fallbackName };
  }

  private async abortOldRoot(
    agentName: string,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.options.turn.abort({
        sessionId,
        reason: "root-session-replaced",
      });
    } catch (error) {
      this.reportBestEffortFailure("turn-abort", agentName, sessionId, error);
    }
  }

  private async runPostCommitParticipants(
    agentName: string,
    previousRoot: SessionRecord,
    fallbackName: string,
  ): Promise<void> {
    try {
      this.options.archiveTitle.generate(previousRoot.sessionId, {
        agentName,
        fallbackName,
      });
    } catch (error) {
      this.reportBestEffortFailure(
        "archive-title",
        agentName,
        previousRoot.sessionId,
        error,
      );
    }
  }

  private async observeFact(fact: RootReplacementCommit): Promise<void> {
    try {
      await this.options.facts?.observe(fact);
    } catch (error) {
      this.reportBestEffortFailure(
        "fact-observer",
        fact.agentName,
        fact.nextRoot.sessionId,
        error,
      );
    }
  }

  private reportBestEffortFailure(
    stage: RootBestEffortFailureStage,
    agentName: string,
    sessionId: string,
    error: unknown,
  ): void {
    try {
      this.options.onBestEffortFailure?.({
        stage,
        agentName,
        sessionId,
        error,
      });
    } catch {
      // The Root mutation committed or the participant is independently retryable.
    }
  }

  private async invoke<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RootInvariantError)
        throw rootApplicationError(error);
      if (error instanceof AgentServiceError) {
        throw new AppError(error.status, error.code, error.message);
      }
      throw error;
    }
  }
}

function rootApplicationError(error: RootInvariantError): AppError {
  switch (error.reason) {
    case "agent-not-found":
      return new AppError(404, "AGENT_NOT_FOUND", error.message);
    case "replacement-not-found":
      return new AppError(404, "ROOT_SESSION_NOT_FOUND", error.message);
  }
}
