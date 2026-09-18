import type {
  GetSessionDiffInput as GetSessionDiffReq,
  GetSessionDiffResult as GetSessionDiffResp,
  GetTurnDiffInput as GetTurnDiffReq,
  GetTurnDiffResult as GetTurnDiffResp,
  ReapplyTurnDiffInput as ReapplyTurnDiffReq,
  ReapplyTurnDiffResult as ReapplyTurnDiffResp,
  RevertTurnDiffInput as RevertTurnDiffReq,
  RevertTurnDiffResult as RevertTurnDiffResp,
  TurnDiffView,
} from "@mavis/protocol/local";

import type { V1SessionCompatibility } from "../../compat/v1/session.js";
import {
  SessionDiffServiceError,
  type SessionDiffService,
  type SessionDiffTarget,
} from "../../service/session-system/index.js";
import type { ApplicationContext } from "../context.js";
import { AppError } from "../errors.js";

type DiffCapability = V1SessionCompatibility["diff"]["capability"];
type DiffMutationResult = Awaited<ReturnType<DiffCapability["mutateTurnDiff"]>>;
type DiffMutationBody = DiffMutationResult["body"];

export interface SessionDiffApplicationOptions {
  readonly service: Pick<SessionDiffService, "requireTarget">;
  readonly capability: DiffCapability;
}

interface SessionDiffSelector {
  readonly assistantMessageId?: string;
  readonly turnId?: string;
  readonly changeSetId?: string;
}

/** Owns Diff eligibility, selector mapping, and generated mutation response shapes. */
export class SessionDiffApplication {
  constructor(private readonly options: SessionDiffApplicationOptions) {}

  async getSessionDiff(
    _context: ApplicationContext,
    req: GetSessionDiffReq,
  ): Promise<GetSessionDiffResp> {
    return this.options.capability.getSessionDiff(
      await this.requireTarget(req.id),
      req.messageId,
    );
  }

  async getTurnDiff(
    _context: ApplicationContext,
    req: GetTurnDiffReq,
  ): Promise<GetTurnDiffResp> {
    await this.requireTarget(req.id);
    return this.options.capability.getTurnDiff(
      req.id,
      selectorFromRequest(req),
    );
  }

  async revertTurnDiff(
    _context: ApplicationContext,
    req: RevertTurnDiffReq,
  ): Promise<RevertTurnDiffResp> {
    await this.requireTarget(req.id);
    const result = await this.options.capability.mutateTurnDiff(
      req.id,
      "revert",
      selectorFromRequest(req),
    );
    assertMutationSucceeded(result);
    return {
      success: result.body.success,
      error: result.body.error,
      turnDiff: toTurnDiffView(result.body),
    };
  }

  async reapplyTurnDiff(
    _context: ApplicationContext,
    req: ReapplyTurnDiffReq,
  ): Promise<ReapplyTurnDiffResp> {
    await this.requireTarget(req.id);
    const result = await this.options.capability.mutateTurnDiff(
      req.id,
      "reapply",
      selectorFromRequest(req),
    );
    assertMutationSucceeded(result);
    const { success, error, ...diff } = result.body;
    return { success, error, ...diff };
  }

  private async requireTarget(sessionId: string): Promise<SessionDiffTarget> {
    try {
      return await this.options.service.requireTarget(sessionId);
    } catch (error) {
      if (!(error instanceof SessionDiffServiceError)) throw error;
      throw new AppError(
        error.reason === "session-not-found" ? 404 : 409,
        error.reason === "session-not-found"
          ? "SESSION_NOT_FOUND"
          : "OPENCODE_DIFF_UNAVAILABLE",
        error.message,
      );
    }
  }
}

function selectorFromRequest(input: SessionDiffSelector): SessionDiffSelector {
  return {
    ...(input.assistantMessageId
      ? { assistantMessageId: input.assistantMessageId }
      : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.changeSetId ? { changeSetId: input.changeSetId } : {}),
  };
}

function assertMutationSucceeded(
  result: DiffMutationResult,
): asserts result is DiffMutationResult & { readonly status: 200 } {
  if (result.status === 200) return;
  throw new AppError(
    result.status,
    result.status === 404 ? "TURN_DIFF_NOT_FOUND" : "TURN_DIFF_CONFLICT",
    result.body.error ?? "Turn diff mutation failed",
  );
}

function toTurnDiffView(body: DiffMutationBody): TurnDiffView | undefined {
  const view: TurnDiffView = {
    ...whenDefined("fileChanges", body.fileChanges),
    ...whenDefined("sourceMessageId", body.sourceMessageId),
    ...whenDefined("changeSetId", body.changeSetId),
    ...whenDefined("status", body.status),
    ...whenDefined("revertedAt", body.revertedAt),
    ...whenDefined("undoable", body.undoable),
    ...whenDefined("canUndo", body.canUndo),
    ...whenDefined("canReapply", body.canReapply),
  };
  if (
    (view.fileChanges?.length ?? 0) === 0 &&
    !view.sourceMessageId &&
    !view.changeSetId &&
    !view.status
  ) {
    return undefined;
  }
  return view;
}

function whenDefined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Partial<Record<Key, Value>> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}
