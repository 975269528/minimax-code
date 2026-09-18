import { toUserModelSelection } from "../conversation/model-selection.js";
import type { UserModelSelection } from "../../service/turn-system/index.js";
import { basename } from "node:path";

import type {
  AttachmentInput,
  AttachmentView,
  EnqueueMessageInput as EnqueueMessageReq,
  ModelInfoView,
  ModelSelectionInput,
  QueuedMessageItemView,
  UpdateQueueItemInput as UpdateQueueItemReq,
} from "@mavis/protocol/local";

import {
  isInlineDisplayDataUrl,
  type QueueItem,
  type QueueMessageAttachment,
  type QueueMessageInput,
  type QueueModelOverride,
} from "../../service/session-system/index.js";

interface QueueItemViewOverrides {
  readonly status?: string;
  readonly finishedAt?: number;
}

export function toQueueMessageInput(
  input: Pick<EnqueueMessageReq, "content" | "attachments">,
): QueueMessageInput {
  return {
    content: input.content ?? "",
    attachments: (input.attachments ?? []).flatMap((attachment) => {
      const mapped = toQueueAttachment(attachment);
      return mapped ? [mapped] : [];
    }),
  };
}

export function toQueueMessageUpdate(
  input: Pick<UpdateQueueItemReq, "content" | "attachments">,
): QueueMessageInput | undefined {
  if (input.content === undefined && input.attachments === undefined)
    return undefined;
  return toQueueMessageInput(input);
}

export function mergeQueueMessageUpdate(
  existing: QueueMessageInput,
  input: Pick<UpdateQueueItemReq, "content" | "attachments">,
): QueueMessageInput | undefined {
  if (input.content === undefined && input.attachments === undefined)
    return undefined;
  const update = toQueueMessageInput(input);
  return {
    ...existing,
    ...(input.content !== undefined ? { content: update.content } : {}),
    ...(input.attachments !== undefined
      ? { attachments: update.attachments }
      : {}),
  };
}

export function toQueueModelOverride(
  input: ModelSelectionInput,
): QueueModelOverride | undefined {
  const selection = toUserModelSelection(input);
  const fields = {
    providerId: "provider_id",
    modelId: "model_id",
    variant: "variant",
    reasoning: "reasoning",
    contextLimit: "context_limit",
    thinking: "thinking",
  } satisfies Record<keyof UserModelSelection, keyof QueueModelOverride>;
  const override: QueueModelOverride = Object.fromEntries(
    Object.entries(selection).map(([key, value]) => [
      fields[key as keyof UserModelSelection],
      value,
    ]),
  );
  return Object.keys(override).length > 0 ? override : undefined;
}

export function toQueuedMessageItemView(
  item: QueueItem,
  overrides: QueueItemViewOverrides = {},
): QueuedMessageItemView {
  return {
    itemId: item.itemId,
    sessionId: item.sessionId,
    status: overrides.status ?? item.status,
    source: item.source,
    content:
      item.message.displayContent ??
      (item.source === "thread-goal" ? "" : item.message.content),
    attachments: item.message.attachments.map(toAttachmentView),
    ...(item.model ? { modelInfo: toModelInfoView(item.model) } : {}),
    createdAt: item.createdAt,
    ...(item.expiresAt !== undefined ? { expiresAt: item.expiresAt } : {}),
    ...(overrides.finishedAt !== undefined
      ? { finishedAt: overrides.finishedAt }
      : {}),
    ...(item.message.source === "code_review"
      ? { reviewRequest: { scope: "local_changes" } }
      : {}),
  };
}

function toQueueAttachment(
  input: AttachmentInput,
): QueueMessageAttachment | undefined {
  const location = toQueueAttachmentLocation(input);
  if (!location) return undefined;
  const mimeType = input.meta?.mimeType ?? "";
  const fileName =
    nonEmptyString(input.meta?.fileName) ??
    (location.filePath ? basename(location.filePath) : "attachment");
  return {
    type:
      input.meta?.attachmentType === "image" || mimeType.startsWith("image/")
        ? "image"
        : "file",
    fileName,
    mimeType,
    ...location,
  };
}

function toQueueAttachmentLocation(
  input: AttachmentInput,
):
  | Pick<QueueMessageAttachment, "filePath" | "dataUrl" | "assetId">
  | undefined {
  const filePath = nonEmptyString(input.local?.filePath);
  const candidateDataUrl = nonEmptyString(input.local?.dataUrl);
  const dataUrl = isInlineDisplayDataUrl(candidateDataUrl)
    ? undefined
    : candidateDataUrl;
  const assetId = nonEmptyString(input.local?.assetId);
  if (!filePath && !dataUrl) return undefined;
  return {
    filePath: filePath ?? "",
    ...(dataUrl ? { dataUrl } : {}),
    ...(assetId ? { assetId } : {}),
  };
}

function toAttachmentView(attachment: QueueMessageAttachment): AttachmentView {
  return {
    meta: {
      attachmentType: attachment.type,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
    },
    local: {
      filePath: attachment.filePath,
      ...(attachment.assetId ? { assetId: attachment.assetId } : {}),
      ...(attachment.dataUrl && !isInlineDisplayDataUrl(attachment.dataUrl)
        ? { dataUrl: attachment.dataUrl }
        : {}),
    },
  };
}

function toModelInfoView(model: QueueModelOverride): ModelInfoView {
  return {
    ...(model.provider_id ? { providerId: model.provider_id } : {}),
    ...(model.model_id ? { modelId: model.model_id } : {}),
    ...(model.variant !== undefined ? { variant: model.variant } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.context_limit !== undefined
      ? { contextLimit: model.context_limit }
      : {}),
    ...(model.thinking !== undefined ? { thinking: model.thinking } : {}),
  };
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}
