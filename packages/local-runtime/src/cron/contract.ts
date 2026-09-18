/**
 * Shared, transport-agnostic cron contract glue.
 *
 * Bridges the IDL-generated DesktopService cron contract (flat structs from
 * `matrix/api_common/cron.thrift`, addressed by cron_id) onto the internal
 * `@mavis/cron` engine model (tagged-union `CronConfig.session`, `disabled`
 * polarity). Kept free of any HTTP `Response` / Hono coupling so both the
 * generated DesktopService methods and unit tests can reuse the exact same
 * mapping + validation logic without duplication.
 *
 * Impedance handled here:
 *  - flat `CronSessionConfig` (mode?/sessionId?/keepSessions?) ↔ internal
 *    tagged-union `SessionConfig`.
 *  - contract `enabled` ↔ internal `disabled` (polarity flip).
 *  - i64 timestamps surface as `number` (Unix ms) — identity here.
 *  - `delivery` stays out of the unified contract. Legacy
 *    `report_to_root` fields only preserve bound-channel auto-delivery choice;
 *    `session.mode = 'root'` means the task itself runs in Root.
 */

import { Cron } from "croner";
import type {
  CronConfig,
  CronConfigUpdate,
  CronTaskState,
  SessionConfig,
} from "@mavis/cron";
import type {
  CreateCronInput as CreateCronInput,
  CronSessionConfig,
  CronTask,
  UpdateCronInput as UpdateCronInput,
} from "@mavis/protocol/local";

const CRON_NAME_RE = /^[^\s/\\:*?"<>|]+$/;
const ACTIVE_HOURS_RE = /^\d{2}:\d{2}$/;

/** Transport-agnostic error carrying the HTTP status + machine code to map. */
export class CronContractError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    /**
     * Optional numeric business code the UI maps to a localized string via
     * `errors.codes.<n>`. Only set for errors that need i18n treatment
     * (e.g. duplicate cron → 40903 → Cron task already exists); leaves the raw
     * daemon message otherwise.
     */
    readonly errorCode?: number,
  ) {
    super(message);
    this.name = "CronContractError";
  }
}

/** Map the internal runtime task state onto the generated flat CronTask. */
export function cronStateToCronTask(state: CronTaskState): CronTask {
  return {
    ...(state.cronId ? { cronId: state.cronId } : {}),
    cronName: state.cronName,
    agentName: state.agentName,
    schedule: state.config.schedule,
    ...(state.config.timezone !== undefined
      ? { timezone: state.config.timezone }
      : {}),
    enabled: state.enabled,
    prompt: state.config.prompt,
    session: sessionConfigToFlat(state.config.session),
    ...(state.config.activeHours
      ? {
          activeHours: {
            start: state.config.activeHours.start,
            end: state.config.activeHours.end,
          },
        }
      : {}),
    status: state.status,
    ...(state.lastRun !== null ? { lastRun: state.lastRun } : {}),
    ...(state.lastResult !== null ? { lastResult: state.lastResult } : {}),
    ...(state.lastError !== null ? { lastError: state.lastError } : {}),
    ...(state.nextRun !== null ? { nextRun: state.nextRun } : {}),
  };
}

/** Internal tagged-union session -> flat contract session. */
export function sessionConfigToFlat(session: SessionConfig): CronSessionConfig {
  if (session.mode === "sessionId") {
    return { mode: "sessionId", sessionId: session.sessionId };
  }
  if (session.mode === "new") {
    return {
      mode: "new",
      ...(session.keepSessions !== undefined && session.keepSessions !== null
        ? { keepSessions: session.keepSessions }
        : {}),
    };
  }
  return { mode: "root" };
}

/** Flat contract session -> internal tagged-union session (validating). */
export function sessionConfigFromFlat(
  flat: CronSessionConfig | undefined,
): SessionConfig {
  const mode = flat?.mode;
  if (mode === undefined) return { mode: "new" };
  if (mode === "root") return { mode: "root" };
  if (mode === "sessionId") {
    if (!flat?.sessionId) {
      throw new CronContractError(
        400,
        "session.session_id is required",
        "VALIDATION_ERROR",
      );
    }
    return { mode: "sessionId", sessionId: flat.sessionId };
  }
  if (mode === "new") {
    const keep = flat?.keepSessions;
    if (keep === undefined) return { mode: "new" };
    if (typeof keep === "number" && Number.isInteger(keep) && keep >= 1) {
      return { mode: "new", keepSessions: keep };
    }
    // keep_sessions = 0 / omitted means "keep all" per the contract comment;
    // model that as the engine's null = keep-all.
    if (keep === 0) return { mode: "new", keepSessions: null };
    throw new CronContractError(
      400,
      "session.keep_sessions must be a positive integer",
      "VALIDATION_ERROR",
    );
  }
  throw new CronContractError(
    400,
    `Invalid session mode: "${mode}"`,
    "VALIDATION_ERROR",
  );
}

/** Build an internal CronConfig from the generated CreateCronInput. */
export function createCronReqToConfig(req: CreateCronInput): CronConfig {
  const schedule = requireNonEmpty(req.schedule, "schedule");
  const prompt = requireNonEmpty(req.prompt, "prompt");
  return {
    schedule,
    scheduleType: "cron",
    prompt,
    ...(req.timezone ? { timezone: req.timezone } : {}),
    ...(req.activeHours
      ? { activeHours: parseActiveHours(req.activeHours) }
      : {}),
    session: sessionConfigFromFlat(req.session),
    disabled: req.enabled === undefined ? false : !req.enabled,
  };
}

/** Build an internal CronConfigUpdate from the generated UpdateCronInput. */
export function updateCronReqToConfigUpdate(
  req: UpdateCronInput,
): CronConfigUpdate {
  const update: CronConfigUpdate = {};
  if (req.enabled !== undefined) update.disabled = !req.enabled;
  if (req.schedule !== undefined)
    update.schedule = requireNonEmpty(req.schedule, "schedule");
  if (req.prompt !== undefined)
    update.prompt = requireNonEmpty(req.prompt, "prompt");
  if (req.timezone !== undefined)
    update.timezone = req.timezone === "" ? null : req.timezone;
  if (req.activeHours !== undefined)
    update.activeHours = parseActiveHours(req.activeHours);
  if (req.session !== undefined)
    update.session = sessionConfigFromFlat(req.session);
  return update;
}

/** Validate a cron name, throwing a contract error on failure. */
export function assertCronName(cronName: string): void {
  if (!cronName || cronName.length > 64 || !CRON_NAME_RE.test(cronName)) {
    throw new CronContractError(
      400,
      `Invalid cron name: "${cronName}"`,
      "VALIDATION_ERROR",
    );
  }
}

/** Validate that a config's schedule is parseable, throwing on failure. */
export function assertSchedulable(config: {
  schedule: string;
  timezone?: string;
}): void {
  try {
    const job = new Cron(config.schedule, {
      timezone: config.timezone,
      unref: true,
    });
    job.nextRun();
    job.stop();
  } catch (err) {
    throw new CronContractError(
      400,
      err instanceof Error ? err.message : String(err),
      "VALIDATION_ERROR",
    );
  }
}

/**
 * Map an arbitrary engine/registry error onto a CronContractError, mirroring
 * the legacy route's status derivation (already-exists -> 409, not-found ->
 * 404, otherwise honor an explicit statusCode or fall back to 500).
 */
export function toCronContractError(err: unknown): CronContractError {
  if (err instanceof CronContractError) return err;
  const candidate = err as {
    statusCode?: unknown;
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const message =
    typeof candidate.message === "string" ? candidate.message : String(err);
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  let status =
    typeof candidate.statusCode === "number"
      ? candidate.statusCode
      : typeof candidate.status === "number"
        ? candidate.status
        : 500;
  let errorCode: number | undefined;
  // Duplicate cron detection is independent of the incoming statusCode:
  //   - `agent-modules/cron`'s `AppError` throws with `statusCode = 409`
  //     already ("Cron task already registered: <a>/<n>", code
  //     "CRON_TASK_EXISTS").
  //   - Older store/registry paths throw a plain `Error` and the caller
  //     defaults status to 500 here.
  // Both must land on `errorCode = 40903` so the UI resolver picks up
  // `errors.codes.40903 = Cron task already exists` instead of showing the raw
  // English registry text. Prior code gated on `status === 500`, which
  // silently skipped the 409 branch — the exact reason zh users still
  // saw the English message end-to-end after this branch's earlier fix.
  const looksLikeDuplicate =
    code === "CRON_TASK_EXISTS" ||
    /already exists|already registered/i.test(message);
  if (looksLikeDuplicate) {
    status = 409;
    errorCode = 40903;
  } else if (status === 500 && /not found/i.test(message)) status = 404;
  return new CronContractError(status, message, code, errorCode);
}

function requireNonEmpty(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CronContractError(
      400,
      `${field} is required`,
      "VALIDATION_ERROR",
    );
  }
  return value;
}

function parseActiveHours(value: { start?: string; end?: string }): {
  start: string;
  end: string;
} {
  const { start, end } = value;
  if (!start || !end) {
    throw new CronContractError(
      400,
      "active_hours.start and active_hours.end are required",
      "VALIDATION_ERROR",
    );
  }
  if (!ACTIVE_HOURS_RE.test(start) || !ACTIVE_HOURS_RE.test(end)) {
    throw new CronContractError(
      400,
      "active_hours must use HH:MM format",
      "VALIDATION_ERROR",
    );
  }
  return { start, end };
}
