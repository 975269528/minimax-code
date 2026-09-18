import type {
  EditSessionMessageInput as EditSessionMessageReq,
  EditSessionMessageResult as EditSessionMessageResp,
  ForkSessionInput as ForkSessionReq,
  ForkSessionResult as ForkSessionResp,
  GetSessionForkOptionsInput as GetSessionForkOptionsReq,
  GetSessionForkOptionsResult as GetSessionForkOptionsResp,
  GetSessionRewindPreviewInput as GetSessionRewindPreviewReq,
  GetSessionRewindPreviewResult as GetSessionRewindPreviewResp,
  RewindSessionInput as RewindSessionReq,
  RewindSessionResult as RewindSessionResp,
} from "@mavis/protocol/local";
import type { SessionRecord } from "../../service/session-system/index.js";
import type { ApplicationContext } from "../context.js";
import { ApplicationError } from "../conversation/errors.js";
import { CONVERSATION_MUTATION_NOT_SUPPORTED } from "./conversation-mutation-errors.js";

export { CONVERSATION_MUTATION_NOT_SUPPORTED } from "./conversation-mutation-errors.js";

/**
 * Minimal Turn boundary for Session mutations. Concrete gates, dispatchers, and TurnService
 * instances exist only inside TurnSystem composition; Application depends only on these lifecycle
 * capabilities.
 */
export interface ConversationMutationPort {
  readonly isActive: (sessionId: string) => boolean;
  readonly readPlanState?: (
    sessionId: string,
  ) => Promise<ConversationMutationPlanState>;
}

export interface ConversationMutationPlanState {
  readonly active: boolean;
  readonly interactionMode: "default" | "plan" | undefined;
  readonly lifecycleActive: boolean;
}

export type ConversationMutationWorkflow = {
  getSessionForkOptions(
    ctx: ApplicationContext,
    req: GetSessionForkOptionsReq,
  ): Promise<GetSessionForkOptionsResp>;
  forkSession(
    ctx: ApplicationContext,
    req: ForkSessionReq,
  ): Promise<ForkSessionResp>;
  /** Internal true-fork capability selected by CreateSessionReq.purpose. */
  createSideSession?(input: {
    readonly operationId: string;
    readonly parentSessionId: string;
    readonly purpose: string;
    readonly title?: string;
  }): Promise<SessionRecord>;
  getSessionRewindPreview(
    ctx: ApplicationContext,
    req: GetSessionRewindPreviewReq,
  ): Promise<GetSessionRewindPreviewResp>;
  rewindSession(
    ctx: ApplicationContext,
    req: RewindSessionReq,
  ): Promise<RewindSessionResp>;
  editSessionMessage(
    ctx: ApplicationContext,
    req: EditSessionMessageReq,
  ): Promise<EditSessionMessageResp>;
  recoverPendingForks?(): Promise<void>;
};

/** Named application boundary for the production Rewind/Edit/Fork workflows; absent workflow remains fail-closed for non-owner hosts. */
export class SessionConversationMutationApplication {
  constructor(
    private readonly port: ConversationMutationPort,
    private readonly workflow?: ConversationMutationWorkflow,
  ) {}

  async getSessionForkOptions(
    ctx: ApplicationContext,
    req: GetSessionForkOptionsReq,
  ) {
    return (
      this.workflow?.getSessionForkOptions(ctx, req) ??
      this.unsupported("getSessionForkOptions")
    );
  }

  async forkSession(ctx: ApplicationContext, req: ForkSessionReq) {
    return (
      this.workflow?.forkSession(ctx, req) ?? this.unsupported("forkSession")
    );
  }

  async getSessionRewindPreview(
    ctx: ApplicationContext,
    req: GetSessionRewindPreviewReq,
  ) {
    return (
      this.workflow?.getSessionRewindPreview(ctx, req) ??
      this.unsupported("getSessionRewindPreview")
    );
  }

  async rewindSession(ctx: ApplicationContext, req: RewindSessionReq) {
    return (
      this.workflow?.rewindSession(ctx, req) ??
      this.unsupported("rewindSession")
    );
  }

  async editSessionMessage(
    ctx: ApplicationContext,
    req: EditSessionMessageReq,
  ) {
    return (
      this.workflow?.editSessionMessage(ctx, req) ??
      this.unsupported("editSessionMessage")
    );
  }

  async recoverPendingForks(): Promise<void> {
    await this.workflow?.recoverPendingForks?.();
  }

  private unsupported(method: string): never {
    void this.port;
    throw new ApplicationError(
      501,
      CONVERSATION_MUTATION_NOT_SUPPORTED,
      `${method} is not supported by local-runtime-v2 yet`,
    );
  }
}
