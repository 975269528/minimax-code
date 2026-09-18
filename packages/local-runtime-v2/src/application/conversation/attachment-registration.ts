import { basename } from "node:path";

import type { AttachmentInput } from "@mavis/protocol/local";

import {
  isInlineDisplayDataUrl,
  type UserMessageAttachment,
} from "../../service/session-system/index.js";
import type { AgentHostInputAttachment } from "../../service/turn-system/index.js";

interface LocalAttachmentRegistrationInput {
  readonly type: "file" | "image";
  readonly filePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly desktopPath?: string;
  readonly dataUrl?: string;
  readonly assetId?: string;
}

interface AttachmentRegistrationReceipt {
  readonly assetId: string;
  readonly filePath: string;
}

type RegisteredLocalAttachment = LocalAttachmentRegistrationInput & {
  readonly registrationReceipt?: AttachmentRegistrationReceipt;
};

export interface LocalAttachmentRegistrationPort {
  register(input: {
    readonly sessionId: string;
    readonly turnId?: string;
    readonly attachments: readonly LocalAttachmentRegistrationInput[];
  }): Promise<readonly RegisteredLocalAttachment[]>;
  discard?(input: {
    readonly sessionId: string;
    readonly receipts: readonly AttachmentRegistrationReceipt[];
  }): Promise<void>;
}

export class AttachmentRegistrationError extends Error {
  override readonly name = "AttachmentRegistrationError";

  constructor(readonly reason: "too-large" | "unreadable") {
    super(
      reason === "too-large"
        ? "Local attachment is too large to persist"
        : "Local attachment source is unreadable or invalid",
    );
  }
}

export interface MaterializedLocalAttachments {
  readonly executionAttachments: readonly AgentHostInputAttachment[];
  readonly displayAttachments: readonly UserMessageAttachment[];
  readonly wireAttachments: readonly AttachmentInput[];
  readonly discardCreated: () => Promise<void>;
}

export async function materializeLocalAttachmentInputs(
  registration: LocalAttachmentRegistrationPort,
  input: {
    readonly sessionId: string;
    readonly turnId?: string;
    readonly attachments: readonly AttachmentInput[] | undefined;
  },
): Promise<MaterializedLocalAttachments> {
  const sources = (input.attachments ?? []).flatMap((attachment, index) => {
    const source = toRegistrationSource(attachment, index);
    return source ? [source] : [];
  });
  if (sources.length === 0) return emptyMaterializedAttachments();
  let registered: readonly RegisteredLocalAttachment[];
  try {
    registered = await registration.register({
      sessionId: input.sessionId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      attachments: sources.map(({ attachment }) => attachment),
    });
  } catch (error) {
    const reason = registrationFailureReason(error);
    if (reason) throw new AttachmentRegistrationError(reason);
    throw error;
  }
  if (registered.length !== sources.length) {
    throw new TypeError(
      "Attachment registration returned an invalid result count.",
    );
  }
  const materialized = registered.map((attachment, index) =>
    validateRegisteredAttachment(attachment, index),
  );
  return {
    executionAttachments: materialized.map(toExecutionAttachment),
    displayAttachments: materialized.map((attachment, index) =>
      toDisplayAttachment(attachment, sources[index]?.sizeBytes),
    ),
    wireAttachments: materialized.map((attachment, index) =>
      toWireAttachment(attachment, sources[index]?.sizeBytes),
    ),
    discardCreated: createDiscardCreated(
      registration,
      input.sessionId,
      registered,
    ),
  };
}

export function attachmentRegistrationResponse(
  error: AttachmentRegistrationError,
): {
  readonly status: number;
  readonly key: string;
  readonly message: string;
} {
  return error.reason === "too-large"
    ? { status: 413, key: "local_attachment_too_large", message: error.message }
    : {
        status: 415,
        key: "local_attachment_unreadable",
        message: error.message,
      };
}

function toRegistrationSource(
  input: AttachmentInput,
  index: number,
):
  | {
      readonly attachment: LocalAttachmentRegistrationInput;
      readonly sizeBytes?: number;
    }
  | undefined {
  const local = localAttachmentSource(input);
  if (!local) return undefined;
  const metadata = registrationMetadata(input, index, local.filePath);
  const attachment: LocalAttachmentRegistrationInput = {
    ...local,
    ...metadata,
    filePath: local.filePath ?? "",
  };
  return registrationSourceWithSize(attachment, input.meta?.sizeBytes);
}

function registrationMetadata(
  input: AttachmentInput,
  index: number,
  filePath: string | undefined,
): Pick<LocalAttachmentRegistrationInput, "type" | "fileName" | "mimeType"> {
  const meta: NonNullable<AttachmentInput["meta"]> = input.meta ?? {};
  const mimeType = nonEmpty(meta.mimeType) ?? "application/octet-stream";
  const fileName =
    nonEmpty(meta.fileName) ??
    (filePath ? basename(filePath) : `attachment-${String(index)}`);
  return {
    type:
      meta.attachmentType === "image" || mimeType.startsWith("image/")
        ? "image"
        : "file",
    fileName,
    mimeType,
  };
}

function registrationSourceWithSize(
  attachment: LocalAttachmentRegistrationInput,
  sizeBytes: number | undefined,
): {
  readonly attachment: LocalAttachmentRegistrationInput;
  readonly sizeBytes?: number;
} {
  return { attachment, ...(sizeBytes !== undefined ? { sizeBytes } : {}) };
}

function localAttachmentSource(input: AttachmentInput):
  | {
      readonly filePath?: string;
      readonly dataUrl?: string;
      readonly desktopPath?: string;
      readonly assetId?: string;
    }
  | undefined {
  const source = input.local;
  if (!source) return undefined;
  const filePath = nonEmpty(source.filePath);
  const dataUrl = nonEmpty(source.dataUrl);
  if (!filePath && !dataUrl) return undefined;
  const desktopPath = nonEmpty(source.desktopPath);
  const assetId = nonEmpty(source.assetId);
  return {
    ...(filePath ? { filePath } : {}),
    ...(dataUrl ? { dataUrl } : {}),
    ...(desktopPath ? { desktopPath } : {}),
    ...(assetId ? { assetId } : {}),
  };
}

function validateRegisteredAttachment(
  input: RegisteredLocalAttachment,
  index: number,
): RegisteredLocalAttachment {
  const registered = withoutRedundantInlinePreview(input);
  const filePath = nonEmpty(registered.filePath);
  const dataUrl = nonEmpty(registered.dataUrl);
  if (
    (registered.type !== "file" && registered.type !== "image") ||
    (!filePath && !dataUrl) ||
    !nonEmpty(registered.fileName) ||
    !nonEmpty(registered.mimeType)
  ) {
    throw new TypeError(
      `Attachment registration returned an invalid result at index ${String(index)}.`,
    );
  }
  return registered;
}

function withoutRedundantInlinePreview(
  input: RegisteredLocalAttachment,
): RegisteredLocalAttachment {
  if (!isInlineDisplayDataUrl(input.dataUrl)) return input;
  return { ...input, dataUrl: undefined };
}

function toExecutionAttachment(
  input: RegisteredLocalAttachment,
): AgentHostInputAttachment {
  return {
    type: input.type,
    ...(nonEmpty(input.filePath) ? { filePath: input.filePath } : {}),
    fileName: input.fileName,
    mimeType: input.mimeType,
    ...(nonEmpty(input.desktopPath) ? { desktopPath: input.desktopPath } : {}),
    ...(nonEmpty(input.dataUrl) ? { dataUrl: input.dataUrl } : {}),
    ...(nonEmpty(input.assetId) ? { assetId: input.assetId } : {}),
  };
}

function toDisplayAttachment(
  input: RegisteredLocalAttachment,
  sizeBytes: number | undefined,
): UserMessageAttachment {
  return {
    meta: {
      attachmentType: input.type,
      fileName: input.fileName,
      mimeType: input.mimeType,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    },
    local: {
      ...(nonEmpty(input.assetId) ? { assetId: input.assetId } : {}),
      ...(nonEmpty(input.filePath) ? { filePath: input.filePath } : {}),
      ...(nonEmpty(input.desktopPath)
        ? { desktopPath: input.desktopPath }
        : {}),
      ...(nonEmpty(input.dataUrl) ? { dataUrl: input.dataUrl } : {}),
    },
  };
}

function toWireAttachment(
  input: RegisteredLocalAttachment,
  sizeBytes: number | undefined,
): AttachmentInput {
  const display = toDisplayAttachment(input, sizeBytes);
  return { meta: display.meta, local: display.local };
}

function emptyMaterializedAttachments(): MaterializedLocalAttachments {
  return {
    executionAttachments: [],
    displayAttachments: [],
    wireAttachments: [],
    discardCreated: async () => undefined,
  };
}

function createDiscardCreated(
  registration: LocalAttachmentRegistrationPort,
  sessionId: string,
  registered: readonly RegisteredLocalAttachment[],
): () => Promise<void> {
  const receipts = registered.flatMap((attachment) =>
    attachment.registrationReceipt ? [attachment.registrationReceipt] : [],
  );
  return async () => {
    if (!registration.discard || receipts.length === 0) return;
    try {
      await registration.discard({ sessionId, receipts });
    } catch {
      // Admission failure remains authoritative when best-effort asset cleanup fails.
    }
  };
}

function registrationFailureReason(
  error: unknown,
): "too-large" | "unreadable" | undefined {
  if (!error || typeof error !== "object") return undefined;
  const message = Reflect.get(error, "message");
  const code = Reflect.get(error, "code");
  if (message === "asset_too_large") return "too-large";
  if (
    typeof message === "string" &&
    [
      "invalid_asset_data_url",
      "asset_source_required",
      "asset_source_not_file",
      "asset_remote_url_invalid",
      "asset_remote_unreadable",
    ].includes(message)
  ) {
    return "unreadable";
  }
  return typeof code === "string" &&
    ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR"].includes(code)
    ? "unreadable"
    : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
