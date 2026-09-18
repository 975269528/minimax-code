import type {
  QueueSessionInput as ListQueueMessagesReq,
  QueueItemInput as GetQueueItemReq,
  QueueItemInput as DeleteQueueItemReq,
  QueueEditInput as UpdateQueueItemReq,
  QueueOrderInput as ReorderQueueReq,
  QueueItemResult as GetQueueItemResp,
  QueueItemResult as UpdateQueueItemResp,
  QueueItemResult as DeleteQueueItemResp,
  QueueOrderResult as ReorderQueueResp,
  QueueSnapshotResult as ListQueueMessagesResp,
} from "./contract.js";
import {
  QueueServiceError,
  type CommittedQueueCapability,
  type QueueCommittedFact,
  type QueueCommittedFactSink,
  type QueueItem,
  type QueueMessageInput,
  type QueueUpdateInput,
} from "../../service/session-system/index.js";
import {
  AttachmentRegistrationError,
  attachmentRegistrationResponse,
  materializeLocalAttachmentInputs,
  type LocalAttachmentRegistrationPort,
} from "../conversation/attachment-registration.js";
import type { ApplicationContext } from "../context.js";
import { AppError } from "../errors.js";
import { publishBestEffort, type GlobalEventPublisher } from "../events.js";
import {
  mergeQueueMessageUpdate,
  toQueuedMessageItemView,
  toQueueModelOverride,
} from "./wire.js";
import { turnAdmissionError } from "../conversation/errors.js";

export interface QueueApplicationOptions {
  readonly queue: Pick<
    CommittedQueueCapability,
    | "requireMutableSession"
    | "snapshot"
    | "list"
    | "get"
    | "update"
    | "reorder"
    | "cancel"
  >;
  readonly attachmentRegistration: LocalAttachmentRegistrationPort;
}

export interface QueueCommittedEventProjectorOptions {
  readonly publish: GlobalEventPublisher;
}

/** Projects neutral committed Queue facts to the admitted public event. */
export class QueueCommittedEventProjector implements QueueCommittedFactSink {
  constructor(private readonly options: QueueCommittedEventProjectorOptions) {}

  handle(facts: readonly QueueCommittedFact[]): void {
    for (const fact of facts) {
      if (fact.kind === "execution-state-changed") {
        publishBestEffort(this.options.publish, {
          type: "session.queue.updated",
          payload: { sessionId: fact.sessionId },
        });
        continue;
      }
      const admissionReason =
        "admissionReason" in fact ? fact.admissionReason : undefined;
      const admissionError = admissionReason
        ? turnAdmissionError(admissionReason)
        : undefined;
      const errorPayload = admissionError
        ? { errorSource: admissionError.key, error: admissionError.message }
        : {};
      publishBestEffort(
        this.options.publish,
        fact.kind === "removed"
          ? {
              type: "session.queue.updated",
              payload: {
                sessionId: fact.sessionId,
                itemId: fact.itemId,
                status: fact.reason,
                reason: fact.reason,
                ...(fact.admissionReason
                  ? { admissionReason: fact.admissionReason }
                  : {}),
                ...errorPayload,
              },
            }
          : {
              type: "session.queue.updated",
              payload: {
                sessionId: fact.sessionId,
                itemId: fact.itemId,
                status: "queued",
                source: fact.source,
                ...(admissionReason ? { admissionReason } : {}),
                ...errorPayload,
                ...(fact.clientRequestId
                  ? { clientRequestId: fact.clientRequestId }
                  : {}),
              },
            },
      );
    }
  }
}

export class QueueApplication {
  constructor(private readonly options: QueueApplicationOptions) {}

  async listQueueMessages(
    _context: ApplicationContext,
    req: ListQueueMessagesReq,
  ): Promise<ListQueueMessagesResp> {
    await this.invoke(() => this.options.queue.requireMutableSession(req.id));
    const [items, snapshot] = await Promise.all([
      this.invoke(() => this.options.queue.list(req.id)),
      this.invoke(() => this.options.queue.snapshot(req.id)),
    ]);
    return {
      paused: snapshot.pause !== undefined,
      pendingCount: snapshot.pendingCount,
      items: items
        .filter(
          (item) => item.status === "queued" && !isSystemManagedQueueItem(item),
        )
        .map((item) =>
          toQueuedMessageItemView(
            item,
            snapshot.pause ? { status: "paused" } : {},
          ),
        ),
    };
  }

  async getQueueItem(
    _context: ApplicationContext,
    req: GetQueueItemReq,
  ): Promise<GetQueueItemResp> {
    await this.invoke(() => this.options.queue.requireMutableSession(req.id));
    const item = await this.invoke(() =>
      this.options.queue.get(req.id, req.itemId),
    );
    if (!item || isSystemManagedQueueItem(item))
      throw queueItemNotFound(req.id, req.itemId);
    return { item: toQueuedMessageItemView(item) };
  }

  async updateQueueItem(
    _context: ApplicationContext,
    req: UpdateQueueItemReq,
  ): Promise<UpdateQueueItemResp> {
    await this.invoke(() => this.options.queue.requireMutableSession(req.id));
    const existing = await this.readUserManageableQueueItem(req.id, req.itemId);
    const existingMessage =
      req.content === undefined && req.attachments === undefined
        ? undefined
        : existing.message;
    const registered =
      req.attachments === undefined
        ? undefined
        : await this.invoke(() =>
            materializeLocalAttachmentInputs(
              this.options.attachmentRegistration,
              {
                sessionId: req.id,
                attachments: req.attachments,
              },
            ),
          );
    try {
      const message = mergeRegisteredQueueMessage(
        existingMessage,
        req.content,
        registered,
      );
      const model: QueueUpdateInput["model"] =
        req.model === undefined
          ? undefined
          : (toQueueModelOverride(req.model) ?? null);
      const result = await this.invoke(() =>
        this.options.queue.update({
          sessionId: req.id,
          itemId: req.itemId,
          ...(message ? { message } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(req.expiresAt !== undefined ? { expiresAt: req.expiresAt } : {}),
        }),
      );
      if (result === "invalid") {
        throw new AppError(
          400,
          "QUEUE_MESSAGE_REQUIRED",
          "Queued message content or attachment is required",
        );
      }
      if (result === "not_editable")
        throw queueItemNotEditable(req.id, req.itemId, "edited");
      if (!result) throw queueItemNotFound(req.id, req.itemId);
      return { item: toQueuedMessageItemView(result) };
    } catch (error) {
      await registered?.discardCreated();
      throw error;
    }
  }

  async reorderQueue(
    _context: ApplicationContext,
    req: ReorderQueueReq,
  ): Promise<ReorderQueueResp> {
    await this.invoke(() => this.options.queue.requireMutableSession(req.id));
    const current = (
      await this.invoke(() => this.options.queue.list(req.id))
    ).filter((item) => item.status === "queued");
    const visibleIds = current
      .filter((item) => !isSystemManagedQueueItem(item))
      .map((item) => item.itemId);
    if (!sameQueueItemIds(visibleIds, req.itemIds)) {
      throw queueReorderInvalid();
    }
    let visibleIndex = 0;
    const completeOrder = current.map((item) =>
      isSystemManagedQueueItem(item)
        ? item.itemId
        : requireQueueItemId(req.itemIds, visibleIndex++),
    );
    const result = await this.invoke(() =>
      this.options.queue.reorder({ sessionId: req.id, itemIds: completeOrder }),
    );
    if (result === "invalid") throw queueReorderInvalid();
    return {
      items: result
        .filter((item) => !isSystemManagedQueueItem(item))
        .map((item) => toQueuedMessageItemView(item)),
    };
  }

  async deleteQueueItem(
    _context: ApplicationContext,
    req: DeleteQueueItemReq,
  ): Promise<DeleteQueueItemResp> {
    await this.invoke(() => this.options.queue.requireMutableSession(req.id));
    await this.readUserManageableQueueItem(req.id, req.itemId);
    const result = await this.invoke(() =>
      this.options.queue.cancel(req.id, req.itemId),
    );
    if (result === "not_editable")
      throw queueItemNotEditable(req.id, req.itemId, "cancelled");
    if (!result) throw queueItemNotFound(req.id, req.itemId);
    return {
      item: toQueuedMessageItemView(result, {
        status: "cancelled",
        finishedAt: result.removedAtMs,
      }),
    };
  }

  private async invoke<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof QueueServiceError) throw mapQueueServiceError(error);
      if (error instanceof AttachmentRegistrationError) {
        const mapped = attachmentRegistrationResponse(error);
        throw new AppError(mapped.status, mapped.key, mapped.message);
      }
      throw error;
    }
  }

  private async readUserManageableQueueItem(
    sessionId: string,
    itemId: string,
  ): Promise<QueueItem> {
    const existing = await this.invoke(() =>
      this.options.queue.get(sessionId, itemId),
    );
    if (!existing) throw queueItemNotFound(sessionId, itemId);
    if (isSystemManagedQueueItem(existing))
      throw queueItemSystemManaged(sessionId, itemId);
    return existing;
  }
}

function isSystemManagedQueueItem(item: Pick<QueueItem, "source">): boolean {
  return item.source === "thread-goal";
}

function queueItemSystemManaged(sessionId: string, itemId: string): AppError {
  return new AppError(
    409,
    "QUEUE_ITEM_SYSTEM_MANAGED",
    `Queue item is managed by the Runtime: ${sessionId}/${itemId}`,
  );
}

function queueReorderInvalid(): AppError {
  return new AppError(
    400,
    "QUEUE_REORDER_INVALID",
    "Queue reorder requires exactly all user-manageable queued item ids",
  );
}

function sameQueueItemIds(
  expected: readonly string[],
  actual: readonly string[],
): boolean {
  return (
    expected.length === actual.length &&
    new Set(expected).size === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((itemId) => actual.includes(itemId))
  );
}

function requireQueueItemId(itemIds: readonly string[], index: number): string {
  const itemId = itemIds[index];
  if (!itemId) throw queueReorderInvalid();
  return itemId;
}

function mergeRegisteredQueueMessage(
  existing: QueueMessageInput | undefined,
  content: string | undefined,
  registered:
    | Awaited<ReturnType<typeof materializeLocalAttachmentInputs>>
    | undefined,
): QueueMessageInput | undefined {
  if (!existing) return undefined;
  return mergeQueueMessageUpdate(
    existing,
    registered
      ? { content, attachments: [...registered.wireAttachments] }
      : { content },
  );
}

function mapQueueServiceError(error: QueueServiceError): AppError {
  switch (error.reason) {
    case "session-not-found":
      return new AppError(404, "SESSION_NOT_FOUND", error.message);
    case "read-only-session":
      return new AppError(409, "READ_ONLY_SESSION", error.message);
    case "runtime-unsupported":
      return new AppError(409, "OPENCODE_QUEUE_UNAVAILABLE", error.message);
    case "session-busy":
      return new AppError(409, "SESSION_BUSY", error.message);
    case "expiry-invalid":
      return new AppError(400, "QUEUE_EXPIRY_INVALID", error.message);
    case "model-invalid":
      return new AppError(400, "VALIDATION_ERROR", error.message);
    case "data-corrupt":
      return new AppError(500, "QUEUE_DATA_CORRUPT", error.message);
  }
}

function queueItemNotFound(sessionId: string, itemId: string): AppError {
  return new AppError(
    404,
    "QUEUE_ITEM_NOT_FOUND",
    `Queue item not found: ${sessionId}/${itemId}`,
  );
}

function queueItemNotEditable(
  sessionId: string,
  itemId: string,
  operation: "edited" | "cancelled",
): AppError {
  return new AppError(
    409,
    "QUEUE_ITEM_NOT_EDITABLE",
    `Only queued items can be ${operation}: ${sessionId}/${itemId}`,
  );
}
