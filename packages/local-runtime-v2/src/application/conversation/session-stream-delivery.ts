import type {
  SessionStreamErrorBody,
  SessionStreamFrameView,
} from "@mavis/protocol/local";
import type { ProcessLocalStreamResult } from "@mavis/conversation-contract";
import {
  sanitizeDisplayAttachment,
  type SessionFrame,
} from "../../service/session-system/index.js";
import type { DirectSendResult } from "./direct-send-delivery.js";
import { turnAdmissionError } from "./errors.js";
import { queryCollapseSteeringProjection } from "./query-collapse-identity.js";
import type { TurnContinuationDeliveryResult } from "./turn-continuation-delivery.js";

export function mapV2TurnStreamResult(
  result: DirectSendResult | TurnContinuationDeliveryResult,
): ProcessLocalStreamResult<SessionStreamFrameView, SessionStreamErrorBody> {
  if (!result.accepted) {
    const error = directSendAdmissionError(result.reason);
    return streamError(error);
  }
  return { ok: true, source: mapV2SessionFrames(result.frames) };
}

export function openV2SessionStream(
  frames: AsyncIterable<SessionFrame>,
): ProcessLocalStreamResult<SessionStreamFrameView, SessionStreamErrorBody> {
  return { ok: true, source: mapV2SessionFrames(frames) };
}

function mapV2SessionFrames(
  frames: AsyncIterable<SessionFrame>,
): AsyncIterableIterator<SessionStreamFrameView> {
  const upstream = frames[Symbol.asyncIterator]();
  const queued: SessionStreamFrameView[] = [{ dataJson: '{"type":10}' }];
  let closed = false;
  let reading = false;
  let closePromise: Promise<IteratorResult<SessionStreamFrameView>> | undefined;

  const done = (): IteratorResult<SessionStreamFrameView> => ({
    done: true,
    value: undefined,
  });
  const closeUpstream = async (): Promise<
    IteratorResult<SessionStreamFrameView>
  > => {
    await upstream.return?.();
    return done();
  };
  const close = (): Promise<IteratorResult<SessionStreamFrameView>> => {
    if (closePromise) return closePromise;
    if (closed) return Promise.resolve(done());
    closed = true;
    queued.length = 0;
    closePromise = closeUpstream();
    return closePromise;
  };
  const pull = async (): Promise<IteratorResult<SessionStreamFrameView>> => {
    while (!closed) {
      const result = await upstream.next();
      if (closed) return done();
      if (result.done) {
        closed = true;
        return { done: false, value: { dataJson: "[DONE]" } };
      }
      const data = mapV2Frame(result.value);
      const mapped = data.map((value, index) =>
        withCursor(result.value, value, index === data.length - 1),
      );
      const first = mapped.shift();
      if (!first) continue;
      queued.push(...mapped);
      return { done: false, value: first };
    }
    return done();
  };
  const read = async (): Promise<IteratorResult<SessionStreamFrameView>> => {
    reading = true;
    try {
      return await pull();
    } finally {
      reading = false;
    }
  };

  const mapped: AsyncIterableIterator<SessionStreamFrameView> = {
    [Symbol.asyncIterator]() {
      return mapped;
    },
    next() {
      const available = queued.shift();
      if (available) return Promise.resolve({ done: false, value: available });
      if (closed) return Promise.resolve(done());
      if (reading)
        return Promise.reject(
          new Error("Concurrent mapped stream reads are invalid"),
        );
      return read();
    },
    return: close,
  };
  return mapped;
}

function mapV2SessionFrame(frame: SessionFrame): readonly unknown[] {
  if (frame.kind === "query-collapse-view") {
    const view = toQueryCollapseSseView(frame.data);
    return view
      ? [{ type: "query_collapse_view", query_collapse_view: view }]
      : [];
  }
  return mapStandardV2Frame(frame);
}

function mapStandardV2Frame(frame: SessionFrame): readonly unknown[] {
  if (frame.kind === "resync-required") return [{ type: "resume_overflow" }];
  if (frame.kind === "message-committed" || frame.kind === "durable-message") {
    return frameMessages(frame.data).map((message) => ({
      type: 2,
      agent_message: toSseMessage(message),
    }));
  }
  if (frame.kind === "session-status") {
    return [
      {
        type: "session_status",
        session_status: {
          type: recordString(frame.data, "status") ?? "started",
        },
      },
    ];
  }
  if (frame.kind === "turn-terminal") {
    return [
      {
        type: "session_status",
        session_status: terminalSessionStatus(frame.data),
      },
    ];
  }
  if (frame.kind === "runtime-event" || frame.kind === "action-required")
    return [frame.data];
  return [{ type: frame.kind, data: frame.data }];
}

function toQueryCollapseSseView(value: unknown):
  | {
      readonly query_key: string;
      readonly current_turn_id: string;
      readonly force_expanded: boolean;
      readonly processing_started_at_ms: number;
      readonly processing_finished_at_ms?: number;
    }
  | undefined {
  const queryKey = recordString(value, "queryKey");
  const currentTurnId = recordString(value, "currentTurnId");
  const forceExpanded = recordBoolean(value, "forceExpanded");
  const processingStartedAtMs = recordNumber(value, "processingStartedAtMs");
  const processingFinishedAtMs = recordNumber(value, "processingFinishedAtMs");
  if (
    queryKey === undefined ||
    currentTurnId === undefined ||
    forceExpanded === undefined ||
    processingStartedAtMs === undefined
  ) {
    return undefined;
  }
  return {
    query_key: queryKey,
    current_turn_id: currentTurnId,
    force_expanded: forceExpanded,
    processing_started_at_ms: processingStartedAtMs,
    ...(processingFinishedAtMs !== undefined
      ? { processing_finished_at_ms: processingFinishedAtMs }
      : {}),
  };
}

function mapV2Frame(frame: SessionFrame): readonly SessionStreamFrameView[] {
  const mapped = mapV2SessionFrame(frame).map(jsonFrame);
  return frame.kind === "turn-terminal" &&
    frame.messageActionDeltas &&
    frame.messageActionDeltas.length > 0
    ? [{ messageActionDeltas: [...frame.messageActionDeltas] }, ...mapped]
    : mapped;
}

function jsonFrame(data: unknown): SessionStreamFrameView {
  return {
    dataJson: typeof data === "string" ? data : JSON.stringify(data),
  };
}

function withCursor(
  frame: SessionFrame,
  mapped: SessionStreamFrameView,
  includeCursor: boolean,
): SessionStreamFrameView {
  return {
    ...mapped,
    ...(includeCursor && frame.cursor ? { cursor: frame.cursor } : {}),
  };
}

function frameMessages(
  data: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  if (!isRecord(data)) return [];
  const messages = Array.isArray(data.messages) ? data.messages : [data];
  return messages.filter(isRecord);
}

function toSseMessage(
  message: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const withSteering = toSseSteeringFields(toSseCronOrigin(message));
  if (!Array.isArray(withSteering.attachments)) return withSteering;
  return {
    ...withSteering,
    attachments: withSteering.attachments.map(toSseAttachment),
  };
}

function toSseSteeringFields(
  message: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const queryKey =
    typeof message.query_key === "string" ? message.query_key : undefined;
  return { ...message, ...queryCollapseSteeringProjection(queryKey) };
}

function toSseCronOrigin(
  message: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (
    message.source !== "cron" ||
    message.origin !== undefined ||
    !isRecord(message.sourceContext)
  ) {
    return message;
  }
  const cronId = firstString([message.sourceContext.cronId]);
  if (!cronId) return message;
  const runId = firstString([message.sourceContext.runId]);
  return {
    ...message,
    origin: { rawMeta: { cronId, ...(runId ? { runId } : {}) } },
  };
}

function toSseAttachment(value: unknown): unknown {
  const sanitized = sanitizeDisplayAttachment(value);
  if (!isRecord(sanitized)) return sanitized;
  const meta = isRecord(sanitized.meta) ? sanitized.meta : undefined;
  const local = isRecord(sanitized.local) ? sanitized.local : undefined;
  if (!meta && !local && !isRecord(sanitized.cloud)) return sanitized;

  return toFlatSseAttachment(sanitized, meta, local);
}

function toFlatSseAttachment(
  attachment: Readonly<Record<string, unknown>>,
  meta: Readonly<Record<string, unknown>> | undefined,
  local: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const filePath = firstString([
    attachment.file_path,
    attachment.filePath,
    local?.filePath,
    local?.file_path,
  ]);
  const fileName =
    firstString([
      attachment.file_name,
      attachment.fileName,
      meta?.fileName,
      meta?.file_name,
    ]) ??
    filePath?.split(/[\\/]/u).pop() ??
    "attachment";
  const mimeType = firstString([
    attachment.mime_type,
    attachment.mimeType,
    meta?.mimeType,
    meta?.mime_type,
  ]);
  const attachmentType = firstString([
    attachment.type,
    meta?.attachmentType,
    meta?.attachment_type,
  ]);
  const assetId = firstString([
    attachment.asset_id,
    attachment.assetId,
    local?.assetId,
    local?.asset_id,
  ]);
  const desktopPath = firstString([
    attachment.desktop_path,
    attachment.desktopPath,
    local?.desktopPath,
    local?.desktop_path,
  ]);
  const previewUrl = firstString([
    attachment.data_url,
    attachment.dataUrl,
    attachment.preview_url,
    attachment.previewUrl,
    local?.dataUrl,
    local?.data_url,
  ]);
  return {
    type:
      attachmentType === "image" || mimeType?.startsWith("image/")
        ? "image"
        : "file",
    file_path: filePath ?? "",
    file_name: fileName,
    mime_type: mimeType ?? "",
    ...stringFields([
      ["asset_id", assetId],
      ["desktop_path", desktopPath],
      ["data_url", previewUrl],
    ]),
  };
}

function firstString(values: readonly unknown[]): string | undefined {
  return values.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
}

function stringFields(
  entries: readonly (readonly [string, string | undefined])[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(entries.filter(hasStringValue));
}

function hasStringValue(
  entry: readonly [string, string | undefined],
): entry is readonly [string, string] {
  return entry[1] !== undefined;
}

function terminalStatus(status: string | undefined): string {
  if (status === "completed") return "finished";
  if (status === "aborted") return "aborted";
  return "error";
}

function terminalSessionStatus(
  data: unknown,
): Readonly<Record<string, unknown>> {
  const type = terminalStatus(recordString(data, "status"));
  if (type !== "error") return { type };
  const message = recordString(data, "error");
  const errorCode = recordNumber(data, "errorCode");
  const errorDetail = recordString(data, "detail");
  return {
    type,
    ...(message !== undefined ? { message } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorDetail !== undefined ? { errorDetail } : {}),
  };
}

function recordString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string"
    ? value[key]
    : undefined;
}

function recordNumber(value: unknown, key: string): number | undefined {
  return isRecord(value) && typeof value[key] === "number"
    ? value[key]
    : undefined;
}

function recordBoolean(value: unknown, key: string): boolean | undefined {
  return isRecord(value) && typeof value[key] === "boolean"
    ? value[key]
    : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function streamError(error: {
  readonly status: number;
  readonly key?: string;
  readonly message: string;
  readonly sseErrorCode?: number;
  readonly detail?: string;
}): ProcessLocalStreamResult<SessionStreamFrameView, SessionStreamErrorBody> {
  return {
    ok: false,
    status: error.status,
    body: {
      sseErrorCode: error.sseErrorCode ?? 0,
      code: error.status,
      key: error.key ?? "LOCAL_RUNTIME_STREAM_OPEN_FAILED",
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
    },
  };
}

/** Direct reason-to-error mappings that need no extra policy resolution. */
const DIRECT_SEND_ADMISSION_ERRORS: Record<
  string,
  { readonly status: number; readonly key: string; readonly message: string }
> = {
  "invalid-session": {
    status: 404,
    key: "local_session_not_found",
    message: "Session not found",
  },
  "priority-blocked": {
    status: 409,
    key: "local_session_has_queued_messages",
    message: "An earlier queued message has priority",
  },
  "queue-paused": {
    status: 409,
    key: "local_session_queue_paused",
    message: "The session Queue is paused",
  },
  "ingress-conflict": {
    status: 409,
    key: "local_turn_ingress_conflict",
    message: "Turn ingress conflicts",
  },
  duplicate: {
    status: 409,
    key: "local_turn_duplicate",
    message: "Turn was already accepted",
  },
  "session-deleting": {
    status: 409,
    key: "local_session_deleting",
    message: "Session is being deleted",
  },
  "compaction-active": {
    status: 409,
    key: "local_session_compacting",
    message: "Session compaction is active",
  },
};

function directSendAdmissionError(
  reason: Exclude<
    DirectSendResult | TurnContinuationDeliveryResult,
    { readonly accepted: true }
  >["reason"],
) {
  const admissionError = turnAdmissionError(reason);
  if (admissionError) return admissionError;
  if (isTurnContinuationAdmissionReason(reason)) {
    return turnContinuationAdmissionError(reason);
  }
  const policyError = planAdmissionError(reason);
  if (policyError) return policyError;
  return (
    DIRECT_SEND_ADMISSION_ERRORS[reason] ?? {
      status: 409,
      key: "local_session_busy",
      message:
        "Session already has an active Turn. Use queue send to deliver the message after it.",
    }
  );
}

function isTurnContinuationAdmissionReason(
  reason: Exclude<
    DirectSendResult | TurnContinuationDeliveryResult,
    { readonly accepted: true }
  >["reason"],
): reason is "unavailable" | "waiting-for-user" {
  return reason === "unavailable" || reason === "waiting-for-user";
}

function turnContinuationAdmissionError(
  reason: "unavailable" | "waiting-for-user",
) {
  if (reason === "unavailable") {
    return {
      status: 409,
      key: "local_turn_continuation_unavailable",
      message: "The current Turn is already complete or cannot be continued",
    };
  }
  return {
    status: 409,
    key: "local_turn_waiting_for_user",
    message: "The current Turn is waiting for user input",
  };
}

function planAdmissionError(
  reason: Exclude<DirectSendResult, { readonly accepted: true }>["reason"],
) {
  if (reason === "policy:plan:lifecycle-active") {
    return {
      status: 409,
      key: "local_plan_lifecycle_active",
      message: "Plan review processing must finish before this request can run",
    };
  }
  if (reason === "policy:plan:questionnaire-active") {
    return {
      status: 409,
      key: "local_plan_questionnaire_active",
      message: "Resolve the pending questionnaire before entering Plan Mode",
    };
  }
  if (reason === "policy:plan:entry-disabled") {
    return {
      status: 409,
      key: "local_plan_entry_disabled",
      message: "New Plan Mode entry is temporarily disabled",
    };
  }
  if (reason === "policy:plan:mode-conflict") {
    return {
      status: 409,
      key: "local_plan_mode_conflict",
      message: "Session mode changed before Plan Mode entry",
    };
  }
  return undefined;
}
