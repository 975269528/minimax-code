import {
  PermissionReply,
  type CliService,
  type PendingPermissionItem,
  type QuestionnaireRequestView,
  type QueuedMessageItemView,
} from '@mavis/local-runtime-v2/cli-service';
import type {
  EnqueueTuiMessageOptions,
  TuiPendingPermission,
  TuiPermissionDecision,
  TuiQuestionnaireReplyAnswer,
  TuiQuestionnaireRequest,
  TuiQueueReceipt,
  TuiQueuedMessage,
  TuiQueueSnapshot,
} from '../port.js';
import { buildTuiToolPreview } from '../tool-preview.js';
import { normalizeTuiQuestionnaireRequest } from '../event-normalizer.js';

export class TuiInteractionAccess {
  constructor(
    private readonly createQueueRequestId: () => string,
    private readonly cliService: CliService,
  ) {}

  async listQueuedMessages(sessionId: string): Promise<TuiQueuedMessage[]> {
    return [...(await this.getQueueSnapshot(sessionId)).items];
  }

  async getQueueSnapshot(sessionId: string): Promise<TuiQueueSnapshot> {
    const response = await this.cliService.listQueueMessages({ id: sessionId });
    const items = (response.items ?? []).map(toTuiQueuedMessage);
    return {
      items,
      paused: response.paused === true,
      pendingCount: response.pendingCount ?? items.length,
    };
  }

  async continueQueue(sessionId: string): Promise<void> {
    const opened = await this.cliService.resumeSession({
      id: sessionId,
      drainQueued: true,
      continuePausedQueue: true,
    });
    if (!opened.ok) throw new Error(opened.body.message);
    // Session events attach the normal live stream. Closing this reservation
    // releases only its reader; the accepted Queue Turn remains Runtime-owned.
    if (Symbol.asyncIterator in opened.source) {
      await opened.source[Symbol.asyncIterator]()
        .return?.()
        .catch(() => undefined);
    }
  }

  async steerQueuedMessage(
    sessionId: string,
    itemId: string,
  ): Promise<{ queueItemId: string; turnId: string }> {
    const response = await this.cliService.steerSession({ id: sessionId, queueItemId: itemId });
    if (!response.success || !response.queueItemId || !response.turnId) {
      throw new Error('Runtime did not return the steered Queue item and Turn identities.');
    }
    return { queueItemId: response.queueItemId, turnId: response.turnId };
  }

  async enqueueMessage(
    sessionId: string,
    content: string,
    options: EnqueueTuiMessageOptions = {},
  ): Promise<TuiQueueReceipt> {
    return this.cliService.enqueueMessage({
      id: sessionId,
      content,
      clientRequestId: this.createQueueRequestId(),
      ...(options.clientIntent ? { clientIntent: options.clientIntent } : {}),
      ...(options.reviewRequest ? { reviewRequest: options.reviewRequest } : {}),
      ...(options.model
        ? {
            model: {
              ...options.model,
              ...(options.model.thinking ? { thinking: { ...options.model.thinking } } : {}),
            },
          }
        : {}),
      ...(options.attachments?.length
        ? {
            attachments: options.attachments.map((attachment) => ({
              meta: {
                attachmentType: attachment.type,
                fileName: attachment.fileName,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
              },
              local: {
                ...(attachment.filePath ? { filePath: attachment.filePath } : {}),
                ...(attachment.assetId ? { assetId: attachment.assetId } : {}),
              },
            })),
          }
        : {}),
    });
  }

  async deleteQueuedMessage(
    sessionId: string,
    itemId: string,
  ): Promise<TuiQueuedMessage | undefined> {
    const response = await this.cliService.deleteQueueItem({ id: sessionId, itemId });
    return response.item ? toTuiQueuedMessage(response.item) : undefined;
  }

  async updateQueuedMessageContent(
    sessionId: string,
    itemId: string,
    content: string,
  ): Promise<TuiQueuedMessage | undefined> {
    const response = await this.cliService.updateQueueItem({
      id: sessionId,
      itemId,
      content,
    });
    return response.item ? toTuiQueuedMessage(response.item) : undefined;
  }

  async getPendingQuestionnaire(
    agentName: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<TuiQuestionnaireRequest | undefined> {
    signal?.throwIfAborted();
    const response = await this.cliService.getPendingQuestionnaire({
      name: agentName,
      sessionId,
    });
    signal?.throwIfAborted();
    return response.request ? toTuiQuestionnaireRequest(response.request) : undefined;
  }

  async getLatestPlanReview(
    agentName: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<TuiQuestionnaireRequest | undefined> {
    signal?.throwIfAborted();
    const response = await this.cliService.getLatestPlanReview({ name: agentName, sessionId });
    signal?.throwIfAborted();
    return response.request ? toTuiQuestionnaireRequest(response.request) : undefined;
  }

  async getPlanModeCapabilities(): Promise<{ readonly entryEnabled: boolean }> {
    return this.cliService.getPlanModeCapabilities();
  }

  async replyQuestionnaire(
    agentName: string,
    requestId: string,
    answers: TuiQuestionnaireReplyAnswer[],
  ): Promise<boolean> {
    const response = await this.cliService.replyQuestionnaire({
      name: agentName,
      requestId,
      schemaVersion: 2,
      answers: answers.map((answer) => ({
        stepId: answer.stepId,
        selectedOptionIds: answer.selectedOptionIds ?? [],
        selectedOther: answer.selectedOther === true,
        ...(answer.otherText ? { otherText: answer.otherText } : {}),
        ...(answer.skipped === true ? { skipped: true } : {}),
      })),
      submittedAt: Date.now(),
    });
    return response.ok;
  }

  async dismissQuestionnaire(agentName: string, requestId: string): Promise<boolean> {
    const response = await this.cliService.dismissQuestionnaire({
      name: agentName,
      requestId,
    });
    return response.ok;
  }

  async listPendingPermissions(signal?: AbortSignal): Promise<TuiPendingPermission[]> {
    signal?.throwIfAborted();
    const response = await this.cliService.listPendingPermissions({});
    signal?.throwIfAborted();
    return (response.requests ?? []).map(toTuiPendingPermission);
  }

  async replyPermission(
    agentName: string,
    requestId: string,
    decision: TuiPermissionDecision,
  ): Promise<boolean> {
    const result = await this.cliService.replyPermission({
      name: agentName,
      requestId,
      reply: PERMISSION_REPLY[decision],
    });
    return result.success === true;
  }
}

const PERMISSION_REPLY = {
  allowOnce: PermissionReply.AllowOnce,
  allowAlways: PermissionReply.AllowAlways,
  deny: PermissionReply.Deny,
} as const satisfies Record<
  TuiPermissionDecision,
  (typeof PermissionReply)[keyof typeof PermissionReply]
>;

function toTuiPendingPermission(input: PendingPermissionItem): TuiPendingPermission {
  const structuredPreview = buildTuiToolPreview({
    toolName: input.toolName,
    input: input.toolInput,
  });
  return {
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.agentName ? { agentName: input.agentName } : {}),
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(input.ruleContents ? { ruleContents: [...input.ruleContents] } : {}),
    ...(input.toolInput !== undefined ? { toolInput: input.toolInput } : {}),
    ...(input.toolDescription !== undefined ? { toolDescription: input.toolDescription } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.allowAlwaysSupported !== undefined
      ? { allowAlwaysSupported: input.allowAlwaysSupported }
      : {}),
    ...(input.createdAt !== undefined ? { createdAt: Number(input.createdAt) } : {}),
    ...(structuredPreview ? { structuredPreview } : {}),
  };
}

function toTuiQueuedMessage(input: QueuedMessageItemView): TuiQueuedMessage {
  return {
    itemId: input.itemId,
    sessionId: input.sessionId,
    status: input.status,
    ...(input.source ? { source: input.source } : {}),
    ...(input.reviewRequest?.scope === 'local_changes'
      ? { reviewRequest: { scope: 'local_changes' as const } }
      : {}),
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(input.attachments ? { attachments: structuredClone(input.attachments) } : {}),
    ...(input.modelInfo ? { modelInfo: { ...input.modelInfo } } : {}),
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
    ...(input.failedReason ? { failedReason: input.failedReason } : {}),
  };
}

function toTuiQuestionnaireRequest(
  request: QuestionnaireRequestView,
): TuiQuestionnaireRequest | undefined {
  return normalizeTuiQuestionnaireRequest({
    ...request,
    ...(request.expiresAt !== undefined ? { expiresAt: Number(request.expiresAt) } : {}),
    ...(request.createdAt !== undefined ? { createdAt: Number(request.createdAt) } : {}),
  });
}
