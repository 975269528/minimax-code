/**
 * Shared, transport-agnostic thread-goal contract glue.
 *
 * Bridges the IDL-generated DesktopService goal contract (flat structs from
 * `matrix/api_common/goal.thrift`, addressed by session_id) onto the internal
 * `@mavis/goal` `ThreadGoalStore` model. Kept free of any HTTP `Response` /
 * Hono coupling so both the generated DesktopService methods and unit tests
 * can reuse the exact same mapping + validation logic without duplication.
 *
 * Impedance handled here:
 *  - i64 timestamps / token counters surface as `number` (Unix ms / raw) —
 *    identity here.
 *  - `token_budget` tri-state on PATCH: field omitted (`undefined`) = leave
 *    as-is; `0` = clear the cap (→ `null`); positive integer = set the cap.
 *    This mirrors the store's `positiveOrNull` (any non-positive value =
 *    "no cap"), the same trick as cron `keep_sessions=0 = keep-all` — so no
 *    dedicated `clear_token_budget` flag is needed.
 *  - Status transitions are validated here only against the enum. The one
 *    real guard — no re-entry into `active` from `complete` or
 *    `budget_limited` — lives in the store and surfaces as 409
 *    `GOAL_STATUS_CONFLICT` / `GOAL_BUDGET_LIMITED`. Objective length is
 *    unrestricted.
 */

import {
  validateThreadGoalObjective,
  type ThreadGoalAttachment,
  type ThreadGoalCreateInput,
  type ThreadGoalPatchInput,
  type ThreadGoalState,
  type ThreadGoalStatus,
} from "@mavis/goal";
import type {
  AttachmentInput,
  CreateGoalInput as CreateGoalInput,
  GoalState,
  PatchGoalInput as PatchGoalInput,
} from "@mavis/protocol/local";

const VALID_STATUSES: ReadonlySet<ThreadGoalStatus> = new Set([
  "active",
  "paused",
  "complete",
  "blocked",
  "budget_limited",
  "usage_limited",
]);

export interface ThreadGoalContractPolicy {
  /** Optional objective length cap. Absent means unlimited. */
  readonly objectiveMaxChars?: number;
}

const DEFAULT_GOAL_CONTRACT_POLICY: ThreadGoalContractPolicy = {};

const UNREADABLE_ATTACHMENT_MESSAGES: ReadonlySet<string> = new Set([
  "invalid_asset_data_url",
  "asset_source_required",
  "asset_source_not_file",
  "asset_remote_url_invalid",
  "asset_remote_unreadable",
  "Local attachment source is unreadable or invalid",
]);

const UNREADABLE_ATTACHMENT_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOTDIR",
  "EISDIR",
]);

/** Transport-agnostic error carrying the HTTP status + machine code to map. */
export class ThreadGoalContractError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ThreadGoalContractError";
  }
}

/** Map the internal canonical goal record onto the generated flat GoalState. */
export function goalStateToGoalState(state: ThreadGoalState): GoalState {
  return {
    goalId: state.goalId,
    sessionId: state.sessionId,
    objective: state.objective,
    objectiveResources: (state.objectiveResources ?? []).map((resource) => ({
      meta: {
        attachmentType: resource.type,
        fileName: resource.fileName,
        mimeType: resource.mimeType,
      },
      local: { assetId: resource.assetId, filePath: resource.filePath },
    })),
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    tokensUsed: state.tokensUsed,
    turnsUsed: state.turnsUsed,
    timeUsedSeconds: state.timeUsedSeconds,
    hasKickoffAttachments: state.kickoffAttachments.length > 0,
    ...(state.statusReason !== null
      ? { statusReason: state.statusReason }
      : {}),
    ...(state.lastVerification !== undefined
      ? {
          lastVerification: {
            backend: state.lastVerification.backend,
            verdict: state.lastVerification.verdict,
            reason: state.lastVerification.reason,
            missing: [...state.lastVerification.missing],
            notMetStreak: state.lastVerification.notMetStreak,
            at: state.lastVerification.at,
          },
        }
      : {}),
    // `null` cap surfaces as omitted (0 / absent = uncapped on the wire).
    ...(state.tokenBudget !== null ? { tokenBudget: state.tokenBudget } : {}),
    // Omitted entirely when nothing blocks the Goal, so an unblocked Goal looks
    // identical to one from a runtime that predates this field.
    ...(state.executionWait !== null
      ? {
          execution: {
            waitReason: state.executionWait.reason,
            waitSince: state.executionWait.sinceMs,
          },
        }
      : {}),
  };
}

/**
 * Build an internal `ThreadGoalCreateInput` from the generated CreateGoalInput.
 * `objective` is required + validated; `token_budget` is `0`/omitted = no cap,
 * positive = cap. The store treats `undefined` and `null` identically on
 * create, so we only pass a positive budget through.
 */
export function createGoalReqToCreateInput(
  req: CreateGoalInput,
  policy: ThreadGoalContractPolicy = DEFAULT_GOAL_CONTRACT_POLICY,
): ThreadGoalCreateInput {
  const sessionId = requireNonEmpty(req.sessionId, "session_id");
  const objective = (req.objective ?? "").trim();
  assertObjective(objective, policy.objectiveMaxChars);
  const tokenBudget = budgetFromWire(req.tokenBudget);
  const kickoffAttachments = (req.attachments ?? []).flatMap((attachment) => {
    const mapped = toKickoffAttachment(attachment);
    return mapped ? [mapped] : [];
  });
  return {
    sessionId,
    objective,
    ...(req.objectiveResources !== undefined
      ? { objectiveResources: mapObjectiveResources(req.objectiveResources) }
      : {}),
    ...(tokenBudget !== null ? { tokenBudget } : {}),
    ...(kickoffAttachments.length > 0 ? { kickoffAttachments } : {}),
  };
}

/**
 * Build an internal `ThreadGoalPatchInput` from the generated PatchGoalInput.
 * Tri-state token_budget:
 *   - field omitted (`undefined`) → key absent → store leaves it alone.
 *   - `0` → `null` → store clears the cap.
 *   - positive integer → set the cap.
 * `status` is enum-validated; `objective` (when present) is non-empty +
 * length validated. The transition guard itself belongs to the store.
 *
 * This translator deliberately does not derive `statusReason`. `PatchGoalInput`
 * has no such field, so anything written here is invented domain state — and
 * an invented reason previously made every wire pause fail the lifecycle's
 * user-pause check, silently downgrading it to a plain field patch. Reason
 * derivation now lives in `GoalLifecycle`.
 *
 * Returns the patch shape plus:
 *   - `hasChange`, used to reject an empty PATCH with 400 (mirrors the legacy
 *     route's "must include status, objective, or tokenBudget" guard);
 *   - `isUserPause`, the explicit intent the route uses to select
 *     `pauseGoalByUser` over the generic field patch.
 */
export function patchGoalReqToPatchInput(
  req: PatchGoalInput,
  policy: ThreadGoalContractPolicy = DEFAULT_GOAL_CONTRACT_POLICY,
): {
  patch: ThreadGoalPatchInput;
  hasChange: boolean;
  isUserPause: boolean;
} {
  let patch: ThreadGoalPatchInput = {};
  let hasChange = false;
  if (
    (req.expectedGoalId === undefined) !==
    (req.expectedUpdatedAt === undefined)
  ) {
    throw new ThreadGoalContractError(
      400,
      "Goal concurrency fields must be supplied together.",
      "VALIDATION_ERROR",
    );
  }
  if (req.expectedGoalId !== undefined) {
    requireNonEmpty(req.expectedGoalId, "expected_goal_id");
    if (
      !Number.isSafeInteger(req.expectedUpdatedAt) ||
      (req.expectedUpdatedAt ?? -1) < 0
    ) {
      throw new ThreadGoalContractError(
        400,
        "Invalid expected_updated_at.",
        "VALIDATION_ERROR",
      );
    }
    patch = {
      ...patch,
      expectedGoalId: req.expectedGoalId,
      rejectIfUpdatedAtChangedFrom: req.expectedUpdatedAt,
    };
  }
  if (req.objectiveResources !== undefined) {
    if (req.objective === undefined) {
      throw new ThreadGoalContractError(
        400,
        "objective_resources requires objective.",
        "VALIDATION_ERROR",
      );
    }
    patch = {
      ...patch,
      objectiveResources: mapObjectiveResources(req.objectiveResources),
    };
  }

  if (req.status !== undefined) {
    if (!VALID_STATUSES.has(req.status as ThreadGoalStatus)) {
      throw new ThreadGoalContractError(
        400,
        `Invalid status: "${req.status}"`,
        "VALIDATION_ERROR",
      );
    }
    patch = { ...patch, status: req.status as ThreadGoalStatus };
    hasChange = true;
  }

  if (req.objective !== undefined) {
    const objective = req.objective.trim();
    assertObjective(objective, policy.objectiveMaxChars);
    patch = { ...patch, objective };
    hasChange = true;
  }

  if (req.tokenBudget !== undefined) {
    // 0 → clear (null); positive → set. (Negative is coerced to clear too,
    // matching the store's `positiveOrNull` defence-in-depth.)
    patch = {
      ...patch,
      tokenBudget: req.tokenBudget > 0 ? Math.floor(req.tokenBudget) : null,
    };
    hasChange = true;
  }

  // A bare `status: paused` is the user leaving the Goal. Anything paired with
  // an objective or budget edit is a field patch that merely happens to also
  // pause, and must keep the generic path's compare-and-set semantics.
  const isUserPause =
    req.status === "paused" &&
    req.objective === undefined &&
    req.tokenBudget === undefined &&
    req.expectedGoalId === undefined;

  return { patch, hasChange, isUserPause };
}

/** Validate a goal status string, throwing a contract error on failure. */
export function assertGoalStatus(
  status: string,
): asserts status is ThreadGoalStatus {
  if (!VALID_STATUSES.has(status as ThreadGoalStatus)) {
    throw new ThreadGoalContractError(
      400,
      `Invalid status: "${status}"`,
      "VALIDATION_ERROR",
    );
  }
}

/**
 * Map an arbitrary store error onto a ThreadGoalContractError. The
 * already-exists sentinel (`ThreadGoalAlreadyExistsError`) carries
 * `name === 'ThreadGoalAlreadyExistsError'`, mapped to 409; "not found" →
 * 404; otherwise honor an explicit statusCode or fall back to 500.
 */
export function toThreadGoalContractError(
  err: unknown,
): ThreadGoalContractError {
  if (err instanceof ThreadGoalContractError) return err;
  const candidate = err as {
    name?: unknown;
    statusCode?: unknown;
    code?: unknown;
    key?: unknown;
    message?: unknown;
    reason?: unknown;
  };
  const message =
    typeof candidate.message === "string" ? candidate.message : String(err);
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  const attachmentError = toGoalAttachmentContractError(
    candidate,
    message,
    code,
  );
  if (attachmentError) return attachmentError;
  if (candidate.name === "ThreadGoalAlreadyExistsError") {
    return new ThreadGoalContractError(409, message, "GOAL_EXISTS");
  }
  if (candidate.name === "ThreadGoalBudgetLimitedError") {
    return new ThreadGoalContractError(409, message, "GOAL_BUDGET_LIMITED");
  }
  if (candidate.name === "ThreadGoalStatusConflictError") {
    return new ThreadGoalContractError(409, message, "GOAL_STATUS_CONFLICT");
  }
  if (candidate.name === "ThreadGoalEpochConflictError") {
    return new ThreadGoalContractError(409, message, "GOAL_CHANGED");
  }
  let status =
    typeof candidate.statusCode === "number" ? candidate.statusCode : 500;
  if (status === 500 && /already exists/i.test(message)) status = 409;
  else if (status === 500 && /not found/i.test(message)) status = 404;
  return new ThreadGoalContractError(status, message, code);
}

function assertObjective(objective: string, maxChars?: number): void {
  const invalid = validateThreadGoalObjective(objective, maxChars);
  if (invalid) {
    throw new ThreadGoalContractError(
      400,
      invalid,
      maxChars !== undefined && objective.length > maxChars
        ? "GOAL_OBJECTIVE_TOO_LONG"
        : "VALIDATION_ERROR",
    );
  }
}

/**
 * Coerce a wire `token_budget` (create path) into `number | null`: positive
 * integer = cap; `0` / omitted / non-positive = `null` (no cap).
 */
function budgetFromWire(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return null;
  return Math.floor(value);
}

function mapObjectiveResources(
  inputs: AttachmentInput[],
): ThreadGoalAttachment[] {
  return inputs.map((input) => {
    const resource = toKickoffAttachment({
      ...input,
      local: {
        ...input.local,
        dataUrl:
          input.local?.dataUrl || input.cloud?.dataUrl || input.cloud?.url,
      },
    });
    if (!resource)
      throw new ThreadGoalContractError(
        415,
        "Local attachment source is unreadable or invalid",
        "local_attachment_unreadable",
      );
    return resource;
  });
}

function toKickoffAttachment(
  input: AttachmentInput,
): ThreadGoalAttachment | undefined {
  const local = input.local;
  const filePath = local?.filePath?.trim() ?? "";
  const desktopPath = local?.desktopPath?.trim() ?? "";
  const dataUrl = local?.dataUrl?.trim() || undefined;
  const assetId = local?.assetId?.trim() || undefined;

  // `filePath` is also used as a display-oriented placeholder by clipboard and
  // inline-comment producers. Prefer a durable registered asset, then a real
  // desktop path. A remaining inline data URL must enter Queue admission with
  // an empty path so the existing attachment materializer persists it instead
  // of asking AgentHost to stat the synthetic display name.
  const sourcePath =
    assetId && filePath
      ? filePath
      : desktopPath || (isInlineDataUrl(dataUrl) ? "" : filePath);
  if (!sourcePath && !dataUrl) return undefined;
  return {
    type: input.meta?.attachmentType === "image" ? "image" : "file",
    filePath: sourcePath,
    fileName: input.meta?.fileName ?? "",
    mimeType: input.meta?.mimeType ?? "",
    ...(dataUrl ? { dataUrl } : {}),
    ...(assetId ? { assetId } : {}),
  };
}

function isInlineDataUrl(value: string | undefined): boolean {
  return value?.toLowerCase().startsWith("data:") === true;
}

function toGoalAttachmentContractError(
  candidate: {
    name?: unknown;
    code?: unknown;
    key?: unknown;
    reason?: unknown;
  },
  message: string,
  code: string | undefined,
): ThreadGoalContractError | undefined {
  const key = typeof candidate.key === "string" ? candidate.key : undefined;
  const reason =
    typeof candidate.reason === "string" ? candidate.reason : undefined;
  const tooLarge =
    key === "local_attachment_too_large" ||
    code === "local_attachment_too_large" ||
    (candidate.name === "AttachmentRegistrationError" &&
      reason === "too-large") ||
    message === "asset_too_large" ||
    message === "Local attachment is too large to persist";
  if (tooLarge) {
    return new ThreadGoalContractError(
      413,
      "Local attachment is too large to persist",
      "local_attachment_too_large",
    );
  }

  const unreadable =
    key === "local_attachment_unreadable" ||
    code === "local_attachment_unreadable" ||
    (candidate.name === "AttachmentRegistrationError" &&
      reason === "unreadable") ||
    UNREADABLE_ATTACHMENT_MESSAGES.has(message) ||
    (code !== undefined && UNREADABLE_ATTACHMENT_CODES.has(code));
  if (!unreadable) return undefined;
  return new ThreadGoalContractError(
    415,
    "Local attachment source is unreadable or invalid",
    "local_attachment_unreadable",
  );
}

function requireNonEmpty(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ThreadGoalContractError(
      400,
      `${field} is required`,
      "VALIDATION_ERROR",
    );
  }
  return value;
}
