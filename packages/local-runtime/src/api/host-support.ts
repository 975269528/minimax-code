import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { classifyLLMErrorToCode } from "@mavis/agent-core/event-bridge";
import {
  allowsManagedMinimaxProviderOverride,
  getRuntimePresetKey,
  resolveLocalRuntimeAuthContextPath,
  resolveModelAvailability,
  resolveProviderAuthMode,
  type ProviderAuthModeSource,
} from "@mavis/config";
import { parseSourceQualifiedModelKey } from "../config/model-key.js";
import { LegacyOpencodeMigrationError } from "../legacy-opencode/legacy-opencode-migrator.js";
import type { LegacyMigrationRecord } from "../persistence/migration/legacy-migration-store.js";
import type { LocalRuntimeConfig } from "../config/types.js";
import type { LocalRuntimeAuthContext } from "../runtime/model-resolver.js";
import type {
  LocalSessionController,
  LocalSessionListOptions,
  LocalSessionRecord,
  LocalSessionStatus,
} from "../sessions/controller.js";
import type { LocalRuntimeTurnOutcome } from "../runtime/host.js";
import { parseByokErrorStatus } from "../runtime/byok-error-attribution.js";
import { resolveV2DirectoryContract } from "../persistence/layout/v2-paths.js";
import { collectV2SessionArtifactDiagnostics } from "../persistence/layout/v2-session-artifacts.js";
import {
  json,
  sanitizeConfigValue,
  splitModelId,
  type LocalPermissionDecision,
} from "./host-helpers.js";
import {
  applyLocalSessionListOptions,
  withoutLocalSessionPagination,
} from "../sessions/list-options.js";
import {
  replyLocalPermissionRequests,
  type LocalPermissionRouteContext,
} from "./routes/permissions.js";
import type {
  LocalRuntimeCapabilities,
  LocalRuntimeSurfaceCapabilities,
} from "../runtime/mode.js";
import type { LegacyHistoryReader } from "../legacy-opencode/legacy-history-reader.js";
import type { LocalRuntimeTelemetrySink } from "../sessions/router.js";
import { getLocalRuntimeSqliteTableRoleLegend } from "../persistence/sqlite-table-roles.js";
import { routeLocalCronApi, type LocalCronRuntime } from "../cron/index.js";
import type {
  LocalTeamTaskCancelInput,
  LocalTeamTaskCancelResult,
  LocalTeamTaskDispatchInput,
  LocalTeamTaskDispatchResult,
} from "../team/api.js";
import {
  builtinProviderKind,
  buildModelEntry,
  listByokRuntimeModels,
  routeModelEntries,
} from "../model-provider/list-models.js";
import {
  modelCacheStatusFor,
  type ModelCacheData,
} from "../model-provider/model-cache.js";
import { resolveChildModelSelection } from "./child-model-config.js";

export function makeRuntimeOwnerId(kind: string): string {
  const pid =
    typeof process !== "undefined" && typeof process.pid === "number"
      ? process.pid
      : "unknown";
  return `${kind}:${pid}:${Math.random().toString(36).slice(2)}`;
}

export function localSessionUpdateFromTurnOutcome(
  outcome: LocalRuntimeTurnOutcome,
): Pick<
  LocalSessionRecord,
  | "status"
  | "errorMessage"
  | "errorCode"
  | "errorSource"
  | "errorDetail"
  | "errorProviderId"
  | "canRetry"
> {
  const status: LocalSessionStatus =
    outcome.status === "completed"
      ? "finished"
      : outcome.status === "aborted"
        ? "aborted"
        : "error";
  return {
    status,
    errorMessage: outcome.errorMessage,
    errorCode: outcome.errorCode,
    errorSource: outcome.errorSource,
    errorDetail: outcome.errorDetail,
    errorProviderId: outcome.errorProviderId,
    canRetry: outcome.canRetry,
  };
}

export function localSessionUpdateFromError(
  err: unknown,
): Pick<
  LocalSessionRecord,
  | "status"
  | "errorMessage"
  | "errorCode"
  | "errorSource"
  | "errorDetail"
  | "errorProviderId"
  | "canRetry"
> {
  const message = err instanceof Error ? err.message : String(err);
  const byok = parseByokErrorStatus(err);
  if (byok) {
    return {
      status: "error",
      errorMessage: byok.message,
      errorCode: byok.errorCode,
      errorSource: byok.errorSource,
      errorDetail: byok.errorDetail,
      errorProviderId: byok.errorProviderId,
      canRetry: false,
    };
  }
  const classified = classifyLLMErrorToCode(err);
  return {
    status: "error",
    errorMessage: classified?.message ?? message,
    errorCode: classified?.status_code,
    errorSource: undefined,
    errorDetail: undefined,
    errorProviderId: undefined,
    canRetry: true,
  };
}

export function localErrorChunkFromSessionUpdate(
  message: string,
  update: Pick<
    LocalSessionRecord,
    "errorCode" | "errorSource" | "errorDetail" | "errorProviderId"
  >,
) {
  return {
    type: "error" as const,
    error: message,
    errorCode: update.errorCode,
    errorSource: update.errorSource,
    errorDetail: update.errorDetail,
    errorProviderId: update.errorProviderId,
  };
}

export function buildLegacyRuntimeUnavailableResponse(input: {
  root: string;
  apiPath: string;
  runtimeMode: string;
}): Response {
  return json(
    {
      success: false,
      error: `Local runtime clean mode does not support legacy ${input.root} API: ${input.apiPath}`,
      code: "LOCAL_RUNTIME_LEGACY_UNAVAILABLE",
      runtimeMode: input.runtimeMode,
      capability: input.root,
    },
    { status: 501 },
  );
}

export function serializeLegacyMigrationFailure(
  error: LegacyOpencodeMigrationError,
): Record<string, unknown> {
  const record = error.record;
  return {
    error: "legacy_session_migration_failed",
    code: "legacy_session_migration_failed",
    message: error.message,
    legacySessionId: record.legacySessionId,
    localSessionId: record.localSessionId,
    diagnosticError: record.error ?? {
      message: formatUnknownError(error.cause),
    },
    migration: record,
  };
}

export function serializeMigrationMetadata(
  migration: LegacyMigrationRecord,
): Record<string, unknown> {
  return {
    migratedFromRuntime: migration.sourceRuntime,
    legacySessionId: migration.legacySessionId,
    legacyDaemonSessionId:
      migration.legacyDaemonSessionId ?? migration.legacySessionId,
    ...(migration.legacyFrameworkSessionId
      ? { legacyFrameworkSessionId: migration.legacyFrameworkSessionId }
      : {}),
    status: migration.status,
    migratedAtMs: migration.migratedAtMs,
    ...(migration.sourceUpdatedAtMs
      ? { sourceUpdatedAtMs: migration.sourceUpdatedAtMs }
      : {}),
    ...(migration.sourceFingerprint
      ? { sourceFingerprint: migration.sourceFingerprint }
      : {}),
    ...(migration.sourceSchemaFingerprint
      ? { sourceSchemaFingerprint: migration.sourceSchemaFingerprint }
      : {}),
    ...(migration.sourceChecksum
      ? { sourceChecksum: migration.sourceChecksum }
      : {}),
    ...(migration.displayChecksum
      ? { displayChecksum: migration.displayChecksum }
      : {}),
    ...(migration.piHistoryStrategy
      ? { piHistoryStrategy: migration.piHistoryStrategy }
      : {}),
    ...(migration.displayReadyAtMs
      ? { displayReadyAtMs: migration.displayReadyAtMs }
      : {}),
    ...(migration.piHistoryReadyAtMs
      ? { piHistoryReadyAtMs: migration.piHistoryReadyAtMs }
      : {}),
    ...(migration.sourceMessageCount !== undefined
      ? { sourceMessageCount: migration.sourceMessageCount }
      : {}),
    ...(migration.importedMessageCount !== undefined
      ? { importedMessageCount: migration.importedMessageCount }
      : {}),
    ...(migration.warnings?.length ? { warnings: migration.warnings } : {}),
    ...(migration.error !== undefined ? { error: migration.error } : {}),
  };
}

export function buildFailedLegacyMigrationStub(
  session: LocalSessionRecord,
  err: unknown,
  record = err instanceof LegacyOpencodeMigrationError ? err.record : undefined,
): LocalSessionRecord {
  const diagnosticError = record?.error ?? { message: formatUnknownError(err) };
  return {
    ...session,
    sessionId: record?.localSessionId ?? session.sessionId,
    parentSessionId: null,
    runtime: "pi-agent",
    status: "error",
    errorMessage: `legacy_session_migration_failed: ${formatUnknownError(diagnosticError)}`,
  };
}

/**
 * Present a clean-mode legacy discovery-only stub to the wire as a pi-agent
 * session. In clean local-runtime mode the user-visible model is "no legacy
 * concept" — mutation gates (PATCH / DELETE / archive / pin / queue /
 * POST /message) all accept every migration status, and
 * `resolveLocalSessionById` lazily materializes a real pi-agent row on first
 * open. The wire representation must reflect that same invariant, otherwise
 * downstream `frameworkType: session.runtime` in `serialization.ts` leaks
 * `'opencode'` to the UI for every discovery-only stub and the sidebar-
 * / composer-side `isReadOnlyLegacySession` guard (which after MR !4076
 * only looks at `frameworkType === 'opencode'`) hides the input box on
 * every legacy session the user has never opened.
 *
 * When `options.primaryAgentName`/`options.legacyPrimaryAgentName` are
 * provided, the helper also folds the legacy `main` alias into the current
 * primary agent name (mirrors the previous in-place rewrite that lived in
 * `listSessionsForTree`) so the same helper covers both concerns and cannot
 * drift out of sync.
 *
 * Sessions already carrying `runtime === 'pi-agent'` (successfully
 * materialized rows, failed stubs from `buildFailedLegacyMigrationStub`)
 * pass through unchanged so the helper is idempotent and safe to call in
 * every clean-mode list path.
 *
 * Rollback mode must NOT call this helper — legacy sessions there are
 * still owned by the legacy daemon and the read-only guard on
 * `session.runtime === 'opencode'` is the intended behavior.
 */
export function presentLegacyStubAsPiAgent(
  session: LocalSessionRecord,
  options?: { primaryAgentName?: string; legacyPrimaryAgentName?: string },
): LocalSessionRecord {
  if (session.runtime !== "opencode") return session;
  const shouldRewriteAgentName =
    options?.primaryAgentName !== undefined &&
    options?.legacyPrimaryAgentName !== undefined &&
    session.agentName === options.legacyPrimaryAgentName &&
    options.primaryAgentName !== options.legacyPrimaryAgentName;
  return {
    ...session,
    runtime: "pi-agent",
    ...(shouldRewriteAgentName
      ? { agentName: options!.primaryAgentName! }
      : {}),
  };
}

export function presentLegacyStubsAsPiAgent(
  sessions: LocalSessionRecord[],
  options?: { primaryAgentName?: string; legacyPrimaryAgentName?: string },
): LocalSessionRecord[] {
  return sessions.map((session) =>
    presentLegacyStubAsPiAgent(session, options),
  );
}

export function formatUnknownError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    return typeof message === "string" ? message : JSON.stringify(err);
  }
  return String(err);
}

export async function mapWithConcurrency<TInput, TOutput>(
  inputs: TInput[],
  concurrency: number,
  mapper: (input: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const output = new Array<TOutput>(inputs.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), inputs.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < inputs.length) {
        const index = nextIndex;
        nextIndex += 1;
        output[index] = await mapper(inputs[index]!, index);
      }
    }),
  );
  return output;
}

export function countLegacyMigrationStatuses(
  records: Array<{
    status: "discovered" | "metadata" | "migrated" | "failed" | "deleted";
  }>,
): {
  discovered: number;
  metadata: number;
  migrated: number;
  failed: number;
  deleted: number;
} {
  const counts = {
    discovered: 0,
    metadata: 0,
    migrated: 0,
    failed: 0,
    deleted: 0,
  };
  for (const record of records) {
    counts[record.status] += 1;
  }
  return counts;
}

export async function resolveLocalSessionById(input: {
  controller: LocalSessionController;
  runtimeMode: string;
  legacyMigrator?: {
    getMigrationRecordForLocalSession(
      sessionId: string,
    ): Promise<LegacyMigrationRecord | undefined>;
    migrateSession(
      sessionId: string,
      options?: { materialize?: boolean },
    ): Promise<{ session?: LocalSessionRecord | undefined } | undefined>;
  };
  normalizeStalePiSession(
    session: LocalSessionRecord,
  ): Promise<LocalSessionRecord>;
  getLegacyRuntime(): LegacyHistoryReader;
  sessionId: string;
}): Promise<LocalSessionRecord | undefined> {
  const local = await input.controller.getSession(input.sessionId);
  if (input.runtimeMode === "clean") {
    if (local) {
      const record =
        await input.legacyMigrator?.getMigrationRecordForLocalSession(
          local.sessionId,
        );
      if (record?.status === "deleted") return undefined;
      // Failed migrations stay visible and mutable from the user's perspective —
      // after the compat boundary there is no "legacy session" concept exposed.
      // Read paths (GET) still see the failed stub through the diagnostic chain,
      // but mutation paths (PATCH/DELETE/archive/pin/queue/abort) keep working on
      // the local row. We deliberately skip the lazy migrate hop because the
      // record already reports failure; POST /message will retry through
      // ensureLegacyPiHistoryMigrated and surface its own error envelope.
      if (record?.status === "failed") {
        return input.normalizeStalePiSession(local);
      }
      if (!record) {
        // No record but a local row exists — schedule a discovery upsert
        // (cheap) so downstream diagnostics see this session in
        // `local_runtime_legacy_migrations`. This is the pre-discovery
        // era of dev baselines; a native pi-agent session will short-circuit
        // inside the migrator (no legacy row → returns empty).
        const migrated = await input.legacyMigrator?.migrateSession(
          local.sessionId,
        );
        return migrated?.session
          ? input.normalizeStalePiSession(migrated.session)
          : input.normalizeStalePiSession(local);
      }
      return input.normalizeStalePiSession(local);
    }
    // No local pi-agent row yet. Either this id was surfaced from a
    // discovery-only listing (record.status === 'discovered', no local row
    // built yet) or the caller is asking about an id we've never seen.
    // Either way, ask the migrator to materialize (build local session +
    // agent rows without importing messages). Message / pi-history imports
    // still stay lazy behind their own ensure hooks.
    const migrated = await input.legacyMigrator?.migrateSession(
      input.sessionId,
      {
        materialize: true,
      },
    );
    return migrated?.session
      ? input.normalizeStalePiSession(migrated.session)
      : undefined;
  }
  if (local) return input.normalizeStalePiSession(local);
  return input.getLegacyRuntime().getSession(input.sessionId);
}

export async function resolveLocalTeamTaskAgentName(input: {
  requestedAgent: string | undefined;
  fallbackAgentName: string;
  primaryAgentName: string;
  primaryAgentDisplayName: string;
  listLocalAgents(): Promise<Array<{ name: string; displayName: string }>>;
}): Promise<string> {
  const requested = input.requestedAgent?.trim();
  if (!requested) return input.fallbackAgentName;
  if (
    requested === input.primaryAgentName ||
    requested === input.primaryAgentDisplayName ||
    requested.toLowerCase() === input.primaryAgentName.toLowerCase() ||
    requested.toLowerCase() === input.primaryAgentDisplayName.toLowerCase()
  ) {
    return input.primaryAgentName;
  }
  const localAgents = await input.listLocalAgents();
  const exact = localAgents.find(
    (agent) => agent.name === requested || agent.displayName === requested,
  );
  if (exact) return exact.name;
  const normalized = requested.toLowerCase();
  const caseInsensitive = localAgents.find(
    (agent) =>
      agent.name.toLowerCase() === normalized ||
      agent.displayName.toLowerCase() === normalized,
  );
  return caseInsensitive?.name ?? requested;
}

export async function dispatchLocalTeamTask(input: {
  task: LocalTeamTaskDispatchInput;
  teamDefaultModelConfigId?: string;
  resolveAgentName(
    requestedAgent: string | undefined,
    fallbackAgentName: string,
  ): Promise<string>;
  createSession(input: {
    agentName: string;
    workspaceDir: string;
    sessionType: "branch";
    sessionKind: "task";
    parentSessionId: string;
    title: string;
    visibility: "hidden";
    purpose: string;
    appMode?: LocalSessionRecord["appMode"];
    isDefaultWorkspace?: LocalSessionRecord["isDefaultWorkspace"];
    effectiveModel?: LocalSessionRecord["effectiveModel"];
    effectiveModelVariant?: LocalSessionRecord["effectiveModelVariant"];
  }): Promise<LocalSessionRecord>;
  resolveDefaultWorkspaceDir(): string;
  enqueue(
    session: LocalSessionRecord,
    body: { content: string },
  ): Promise<{ itemId: string } | undefined>;
}): Promise<LocalTeamTaskDispatchResult> {
  const agentName = await input.resolveAgentName(
    input.task.task.assignedTo,
    input.task.ownerSession.agentName,
  );
  const modelSelection = resolveChildModelSelection({
    taskModelConfigId: input.task.modelConfigId,
    teamDefaultModelConfigId: input.teamDefaultModelConfigId,
    parentEffectiveModel: input.task.ownerSession.effectiveModel,
    parentEffectiveModelVariant: input.task.ownerSession.effectiveModelVariant,
  });
  const session = await input.createSession({
    agentName,
    workspaceDir:
      input.task.ownerSession.workspaceDir ||
      input.resolveDefaultWorkspaceDir(),
    sessionType: "branch",
    sessionKind: "task",
    parentSessionId: input.task.ownerSession.sessionId,
    title: `Team ${input.task.planId}: ${input.task.task.title ?? input.task.task.id}`,
    visibility: "hidden",
    purpose: `team-plan:${input.task.planId}:task:${input.task.task.id}`,
    appMode: input.task.ownerSession.appMode,
    isDefaultWorkspace: input.task.ownerSession.isDefaultWorkspace,
    ...modelSelection,
  });
  const queued = await input.enqueue(session, { content: input.task.prompt });
  if (!queued) {
    throw new Error(
      `Failed to enqueue local team task ${input.task.task.id} for ${session.sessionId}.`,
    );
  }
  return {
    sessionId: session.sessionId,
    queueItemId: queued.itemId,
    agentName,
  };
}

export async function cancelLocalTeamTask(input: {
  task: LocalTeamTaskCancelInput;
  cancelQueue(
    sessionId: string,
    queueItemId: string,
  ): Promise<{ itemId: string } | undefined>;
  activePiTurns: { has(sessionId: string): boolean };
  abortSessionTurn(sessionId: string): void;
}): Promise<LocalTeamTaskCancelResult> {
  const queueCancelled = input.task.queueItemId
    ? Boolean(
        await input.cancelQueue(input.task.sessionId, input.task.queueItemId),
      )
    : false;
  const turnAborted = input.activePiTurns.has(input.task.sessionId);
  input.abortSessionTurn(input.task.sessionId);
  return { sessionId: input.task.sessionId, queueCancelled, turnAborted };
}

export async function listAllLocalSessions(input: {
  agentName?: string;
  options?: LocalSessionListOptions;
  runtimeMode: string;
  controller: LocalSessionController;
  legacyMigrator?: {
    listLegacySessions(agentName?: string): Promise<LocalSessionRecord[]>;
    getMigrationRecordForLocalSession(
      sessionId: string,
    ): Promise<LegacyMigrationRecord | undefined>;
    migrateSession(
      sessionId: string,
      options?: { materialize?: boolean },
    ): Promise<{ session?: LocalSessionRecord | undefined } | undefined>;
    getMigrationRecordForLegacySession(
      sessionId: string,
    ): Promise<LegacyMigrationRecord | undefined>;
  };
  normalizeCleanLocalSession(
    session: LocalSessionRecord,
  ): Promise<LocalSessionRecord | undefined>;
  normalizeStalePiSession(
    session: LocalSessionRecord,
  ): Promise<LocalSessionRecord>;
  getLegacyRuntime(): LegacyHistoryReader;
  emitLegacyMigrationTelemetry(
    sessionId: string,
    err: LegacyOpencodeMigrationError,
  ): void;
}): Promise<LocalSessionRecord[]> {
  const queryOptions =
    input.options || input.agentName
      ? {
          ...(input.options ?? {}),
          ...(input.agentName ? { agentName: input.agentName } : {}),
        }
      : undefined;
  if (input.runtimeMode === "clean") {
    const legacy = await input.legacyMigrator?.listLegacySessions(
      input.agentName,
    );
    const legacyById = new Map(
      (legacy ?? []).map((session) => [session.sessionId, session]),
    );
    const local = await Promise.all(
      (
        await input.controller.listSessions(
          withoutLocalSessionPagination(queryOptions),
        )
      ).map((session) => input.normalizeCleanLocalSession(session)),
    );
    const byId = new Map<string, LocalSessionRecord>();
    for (const session of legacy ?? []) byId.set(session.sessionId, session);
    for (const session of local) {
      if (session) byId.set(session.sessionId, session);
    }
    const page = applyLocalSessionListOptions([...byId.values()], queryOptions);
    const pageLegacy = page.filter((session) =>
      legacyById.has(session.sessionId),
    );
    const failedLegacy = await migrateLegacySessionsForList({
      sessions: pageLegacy,
      legacyMigrator: input.legacyMigrator,
      controller: input.controller,
      normalizeStalePiSession: input.normalizeStalePiSession,
      emitLegacyMigrationTelemetry: input.emitLegacyMigrationTelemetry,
    });
    const failedById = new Map(
      failedLegacy.map((session) => [session.sessionId, session]),
    );
    const migratedById = new Map<string, LocalSessionRecord>();
    await Promise.all(
      pageLegacy.map(async (session) => {
        if (failedById.has(session.sessionId)) return;
        const migrated = await input.controller.getSession(session.sessionId);
        if (migrated) {
          migratedById.set(
            session.sessionId,
            await input.normalizeStalePiSession(migrated),
          );
        }
      }),
    );
    return page.map(
      (session) =>
        failedById.get(session.sessionId) ??
        migratedById.get(session.sessionId) ??
        // Legacy discovery-only stub (no local pi-agent row, not failed) —
        // present it as pi-agent so the wire `frameworkType` reflects the
        // clean-mode "no legacy concept" invariant and the UI composer stays
        // visible even before the user opens the session. Kept last in the
        // fallback chain so materialized rows and failed stubs win first.
        presentLegacyStubAsPiAgent(session),
    );
  }
  const local = await Promise.all(
    (
      await input.controller.listSessions(
        withoutLocalSessionPagination(queryOptions),
      )
    ).map((session) => input.normalizeStalePiSession(session)),
  );
  const legacy = applyLocalSessionListOptions(
    await input.getLegacyRuntime().listSessions(input.agentName),
    withoutLocalSessionPagination(queryOptions),
  );
  const byId = new Map<string, LocalSessionRecord>();
  for (const session of legacy) byId.set(session.sessionId, session);
  for (const session of local) byId.set(session.sessionId, session);
  return applyLocalSessionListOptions([...byId.values()], queryOptions);
}

export async function migrateLegacySessionsForList(input: {
  sessions: LocalSessionRecord[];
  legacyMigrator?: {
    migrateSession(
      sessionId: string,
      options?: { materialize?: boolean },
    ): Promise<{ session?: LocalSessionRecord | undefined } | undefined>;
    getMigrationRecordForLegacySession(
      sessionId: string,
    ): Promise<LegacyMigrationRecord | undefined>;
  };
  controller: LocalSessionController;
  normalizeStalePiSession(
    session: LocalSessionRecord,
  ): Promise<LocalSessionRecord>;
  emitLegacyMigrationTelemetry(
    sessionId: string,
    err: LegacyOpencodeMigrationError,
  ): void;
}): Promise<LocalSessionRecord[]> {
  if (!input.legacyMigrator || input.sessions.length === 0) return [];
  const migrated = await mapWithConcurrency(
    input.sessions,
    4,
    async (session) => {
      try {
        // Discovery-only: cheap fingerprint upsert per legacy session. No
        // local pi-agent row / agent row / message import — those are lazily
        // materialized when the user actually opens the session
        // (`resolveLocalSessionById` → materialize:true) or sends a message
        // (`ensureLegacyPiHistoryMigrated` → includeMessages+includePiHistory).
        await input.legacyMigrator!.migrateSession(session.sessionId);
        return undefined;
      } catch (err) {
        if (err instanceof LegacyOpencodeMigrationError) {
          input.emitLegacyMigrationTelemetry(session.sessionId, err);
          return buildFailedLegacyMigrationStub(session, err);
        }
        const record =
          await input.legacyMigrator!.getMigrationRecordForLegacySession(
            session.sessionId,
          );
        return buildFailedLegacyMigrationStub(session, err, record);
      }
    },
  );
  return migrated.filter((session): session is LocalSessionRecord =>
    Boolean(session),
  );
}

export function emitLocalLegacyMigrationTelemetry(input: {
  telemetry?: LocalRuntimeTelemetrySink;
  sessionId: string;
  error: LegacyOpencodeMigrationError;
}): void {
  input.telemetry?.({
    runtime: "pi-agent",
    sessionId: input.sessionId,
    phase: "failure",
    message: `legacy_session_migration_failed:${formatUnknownError(input.error.record.error ?? input.error)}`,
  });
}

export async function getFirstLocalSessionForAgent(input: {
  agentName: string;
  listAllSessions(agentName: string): Promise<LocalSessionRecord[]>;
}): Promise<LocalSessionRecord | undefined> {
  const sessions = await input.listAllSessions(input.agentName);
  return (
    sessions.find((session) => session.sessionType === "root") ?? sessions[0]
  );
}

export function routeLocalRuntimeCronApi(input: {
  runtime: LocalCronRuntime;
  listAllSessions(
    agentName?: string,
    options?: LocalSessionListOptions,
  ): Promise<LocalSessionRecord[]>;
  method: string;
  request: Request;
  parts: string[];
}): Promise<Response> {
  return routeLocalCronApi(input);
}

export function rejectLegacyQueueRoute(): Response {
  return json(
    {
      error:
        "Legacy opencode sessions do not support local-runtime queue routes.",
    },
    { status: 409 },
  );
}

export async function normalizeCleanLocalSession(input: {
  session: LocalSessionRecord;
  legacyMigrator?: {
    getMigrationRecordForLocalSession(
      sessionId: string,
    ): Promise<LegacyMigrationRecord | undefined>;
  };
  normalizeStalePiSession(
    session: LocalSessionRecord,
  ): Promise<LocalSessionRecord>;
}): Promise<LocalSessionRecord | undefined> {
  const record = await input.legacyMigrator?.getMigrationRecordForLocalSession(
    input.session.sessionId,
  );
  if (record?.status === "deleted") return undefined;
  return input.normalizeStalePiSession(input.session);
}

export async function normalizeStalePiSession(input: {
  session: LocalSessionRecord;
  activePiTurns: Map<string, unknown>;
  isSessionLockedByOtherOwner(sessionId: string): Promise<boolean>;
  controller: LocalSessionController;
}): Promise<LocalSessionRecord> {
  if (
    input.session.runtime !== "pi-agent" ||
    input.session.status !== "started" ||
    input.activePiTurns.has(input.session.sessionId)
  ) {
    return input.session;
  }
  if (await input.isSessionLockedByOtherOwner(input.session.sessionId))
    return input.session;
  return (
    (await input.controller.updateSession(input.session.sessionId, {
      status: "interrupted",
      errorMessage: "Local runtime restarted before this turn completed.",
    })) ?? {
      ...input.session,
      status: "interrupted",
      errorMessage: "Local runtime restarted before this turn completed.",
    }
  );
}

export async function replyLocalPermissionRequestResponse(input: {
  requestId: string;
  decision: LocalPermissionDecision;
  routeContext: LocalPermissionRouteContext;
}): Promise<Response> {
  const result = await replyLocalPermissionRequests(
    input.routeContext,
    [input.requestId],
    input.decision,
  );
  if (result.processed.length === 0) {
    return json({ success: false, ...result }, { status: 404 });
  }
  return json({ success: true, ...result });
}

export function buildLocalRuntimeStatus(input: {
  runtimeMode: string;
  runtimeOwnerKind: string;
  capabilities: LocalRuntimeCapabilities;
  surfaces: LocalRuntimeSurfaceCapabilities;
  config: LocalRuntimeConfig;
  runtimeStartupToken?: string;
}): Record<string, unknown> {
  return {
    status: "ok",
    runtime: "local-runtime",
    mode: input.runtimeMode,
    ownerKind: input.runtimeOwnerKind,
    capabilities: input.capabilities,
    surfaces: input.surfaces,
    dataDir: input.config.dataDir,
    ...(input.runtimeStartupToken
      ? { startupToken: input.runtimeStartupToken }
      : {}),
  };
}

export async function buildLocalLegacyMigrationCheck(input: {
  runtimeMode: string;
  dataDir?: string;
  agentName?: string;
  verbose?: boolean;
  legacyMigrator?: {
    listLegacySessions(agentName?: string): Promise<LocalSessionRecord[]>;
    listMigrationRecords(): Promise<LegacyMigrationRecord[]>;
    getSourceManifest?(): Promise<unknown>;
  };
}): Promise<Record<string, unknown>> {
  const persistence = {
    sqlite: {
      tableRoleLegend: getLocalRuntimeSqliteTableRoleLegend(),
    },
    ...(input.verbose && input.dataDir
      ? {
          artifacts: redactMigrationDiagnosticValue(
            collectV2SessionArtifactDiagnostics(input.dataDir, {
              maxSessions: 50,
            }),
            input.dataDir,
          ),
        }
      : {}),
  };
  if (!input.legacyMigrator) {
    return {
      mode: input.runtimeMode,
      legacyImport: false,
      persistence,
      totals: {
        legacySessions: 0,
        pending: 0,
        metadata: 0,
        migrated: 0,
        failed: 0,
        deleted: 0,
        records: 0,
      },
      failed: [],
    };
  }
  const legacySessions = await input.legacyMigrator.listLegacySessions(
    input.agentName,
  );
  const records = await input.legacyMigrator.listMigrationRecords();
  const sourceManifest = input.verbose
    ? await input.legacyMigrator.getSourceManifest?.()
    : undefined;
  const legacyIds = new Set(legacySessions.map((session) => session.sessionId));
  const relevantRecords = input.agentName
    ? records.filter((record) => legacyIds.has(record.legacySessionId))
    : records;
  const recordByLegacyId = new Map(
    relevantRecords.map((record) => [record.legacySessionId, record] as const),
  );
  const pending = legacySessions.filter(
    (session) => !recordByLegacyId.has(session.sessionId),
  ).length;
  const byStatus = countLegacyMigrationStatuses(relevantRecords);
  const artifactSessionIds = [
    ...legacySessions.map((session) => session.sessionId),
    ...relevantRecords.map((record) => record.localSessionId),
  ];
  return {
    mode: input.runtimeMode,
    legacyImport: true,
    ...(input.agentName ? { agentName: input.agentName } : {}),
    persistence: {
      ...persistence,
      ...(input.verbose && input.dataDir
        ? {
            artifacts: redactMigrationDiagnosticValue(
              collectV2SessionArtifactDiagnostics(input.dataDir, {
                sessionIds: artifactSessionIds,
                maxSessions: 200,
              }),
              input.dataDir,
            ),
          }
        : {}),
    },
    totals: {
      legacySessions: legacySessions.length,
      pending,
      metadata: byStatus.metadata,
      migrated: byStatus.migrated,
      failed: byStatus.failed,
      deleted: byStatus.deleted,
      records: relevantRecords.length,
    },
    ...(input.verbose && sourceManifest !== undefined
      ? {
          sourceManifest: redactMigrationDiagnosticValue(
            sourceManifest,
            input.dataDir,
          ),
        }
      : {}),
    messages: summarizeLegacyMigrationMessages(relevantRecords),
    records: relevantRecords.slice(0, 200).map((record) => ({
      legacySessionId: record.legacySessionId,
      localSessionId: record.localSessionId,
      legacyDaemonSessionId:
        record.legacyDaemonSessionId ?? record.legacySessionId,
      legacyFrameworkSessionId: record.legacyFrameworkSessionId,
      status: record.status,
      migratedAtMs: record.migratedAtMs,
      sourceUpdatedAtMs: record.sourceUpdatedAtMs,
      sourceFingerprint: record.sourceFingerprint,
      sourceSchemaFingerprint: record.sourceSchemaFingerprint,
      sourceChecksum: record.sourceChecksum,
      displayChecksum: record.displayChecksum,
      piHistoryStrategy: record.piHistoryStrategy,
      sourceMessageCount: record.sourceMessageCount,
      importedMessageCount: record.importedMessageCount,
      ledgerImportedAtMs: record.ledgerImportedAtMs,
      projectionReadyAtMs: record.projectionReadyAtMs,
      displayReadyAtMs: record.displayReadyAtMs,
      piHistoryReadyAtMs: record.piHistoryReadyAtMs,
      warnings: redactMigrationDiagnosticValue(record.warnings, input.dataDir),
      ...(input.verbose && record.report !== undefined
        ? {
            report: redactMigrationDiagnosticValue(
              record.report,
              input.dataDir,
            ),
          }
        : {}),
    })),
    failed: relevantRecords
      .filter((record) => record.status === "failed")
      .slice(0, 20)
      .map((record) => ({
        legacySessionId: record.legacySessionId,
        localSessionId: record.localSessionId,
        legacyFrameworkSessionId: record.legacyFrameworkSessionId,
        sourceSchemaFingerprint: record.sourceSchemaFingerprint,
        sourceChecksum: record.sourceChecksum,
        displayChecksum: record.displayChecksum,
        piHistoryStrategy: record.piHistoryStrategy,
        migratedAtMs: record.migratedAtMs,
        sourceMessageCount: record.sourceMessageCount,
        importedMessageCount: record.importedMessageCount,
        warnings: redactMigrationDiagnosticValue(
          record.warnings,
          input.dataDir,
        ),
        error: redactMigrationDiagnosticValue(record.error, input.dataDir),
      })),
  };
}

function redactMigrationDiagnosticValue(
  value: unknown,
  dataDir?: string,
): unknown {
  const roots: Array<[string, string]> = [];
  if (dataDir) roots.push([path.resolve(dataDir), "<dataDir>"]);
  roots.push([os.homedir(), "<home>"]);
  return redactDiagnosticValue(value, roots);
}

function redactDiagnosticValue(
  value: unknown,
  roots: Array<[string, string]>,
): unknown {
  if (typeof value === "string") return redactDiagnosticString(value, roots);
  if (Array.isArray(value))
    return value.map((item) => redactDiagnosticValue(item, roots));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      redactDiagnosticValue(child, roots),
    ]),
  );
}

function redactDiagnosticString(
  value: string,
  roots: Array<[string, string]>,
): string {
  let output = value;
  for (const [root, label] of roots) {
    if (!root || root === path.sep) continue;
    const normalizedRoot = path
      .resolve(root)
      .replace(new RegExp(`${escapeRegExp(path.sep)}+$`), "");
    if (!normalizedRoot) continue;
    output = output.replace(
      new RegExp(`${escapeRegExp(normalizedRoot)}(?=$|[\\\\/])`, "g"),
      label,
    );
  }
  return output;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function summarizeLegacyMigrationMessages(
  records: LegacyMigrationRecord[],
): Record<string, number> {
  return records.reduce(
    (summary, record) => {
      summary.sourceCount += record.sourceMessageCount ?? 0;
      summary.importedCount += record.importedMessageCount ?? 0;
      if (record.sourceMessageCount !== undefined)
        summary.recordedSourceSessions += 1;
      if (record.importedMessageCount !== undefined)
        summary.recordedImportedSessions += 1;
      return summary;
    },
    {
      sourceCount: 0,
      importedCount: 0,
      recordedSourceSessions: 0,
      recordedImportedSessions: 0,
    },
  );
}

export interface LocalRuntimeModelSelection {
  providerId?: string;
  modelId?: string;
  variant?: string | null;
}

export function listLocalRuntimeModels(
  config: LocalRuntimeConfig,
  selection?: LocalRuntimeModelSelection,
  options?: {
    cache?: ModelCacheData;
    implicitCustomProviderThinking?: boolean;
  },
): Array<Record<string, unknown>> {
  const defaultModel = config.defaultModel ?? "";
  const [defaultProviderId, defaultModelId] = splitModelId(defaultModel);
  const selectedProviderId = selection?.providerId ?? defaultProviderId;
  const selectedModelId = selection?.modelId ?? defaultModelId;
  const selectionVariant = selection
    ? selection.variant
    : config.defaultModelVariant;
  const hasSelectionVariant = selection
    ? selection.variant !== undefined
    : config.defaultModelVariant !== undefined;
  // Listed per source/route rather than flattening the whole provider tree:
  // a model the current route cannot call must not be offered for selection.
  const builtin = Object.entries(config.provider ?? {}).flatMap(
    ([providerId, provider]) =>
      routeModelEntries(config, providerId, provider).map(
        ([modelId, model]) => {
          return buildModelEntry({
            providerId,
            modelId,
            model,
            selected:
              providerId === selectedProviderId && modelId === selectedModelId,
            selectionVariant,
            hasSelectionVariant,
            providerSource: "provider",
            providerKind: builtinProviderKind(config, providerId, provider),
            providerName: provider.name ?? providerId,
            status: options?.cache
              ? modelCacheStatusFor(options.cache, providerId, modelId)
              : undefined,
          });
        },
      ),
  );
  const byok = listByokRuntimeModels(
    config,
    {
      providerId: selectedProviderId,
      modelId: selectedModelId,
      variant: selectionVariant,
      hasVariant: hasSelectionVariant,
    },
    options?.cache,
    {
      ...(options?.implicitCustomProviderThinking === true
        ? { implicitCustomProviderThinking: true }
        : {}),
    },
  );
  return [...builtin, ...byok];
}

export function resolveDefaultLocalWorkspaceDir(
  defaultWorkspaceDir: string | undefined,
  config: LocalRuntimeConfig,
): string {
  if (defaultWorkspaceDir) return defaultWorkspaceDir;
  return `${config.dataDir}/workspace`;
}

export function buildRuntimeDoctorSnapshot(input: {
  config: LocalRuntimeConfig;
  authContext?: LocalRuntimeAuthContext;
  runtimeMode: string;
  runtimeOwnerKind: string;
  runtimeOwnerId: string;
  runtimeStartupToken?: string;
  capabilities: Record<string, unknown>;
  surfaces: Record<string, unknown>;
  hostDiagnosticsAvailable?: boolean;
}): Record<string, unknown> {
  const dataDir = input.config.dataDir;
  const configPath = path.join(dataDir, "config.yaml");
  const authCachePath = resolveLocalRuntimeAuthContextPath(dataDir);
  const v2 = resolveV2DirectoryContract(dataDir);
  const logsDir = v2.logs;
  const runtimeEventsDir = v2.events;
  const [providerId, modelId] = splitModelId(input.config.defaultModel ?? "");
  const provider = providerId ? input.config.provider?.[providerId] : undefined;
  const providerOptions = provider?.options;
  const authModeResolution = resolveProviderAuthMode({
    authMode: providerOptions?.authMode,
    baseURL: providerOptions?.baseURL,
    allowManagedBaseURLOverride:
      providerId === "minimax" && allowsManagedMinimaxProviderOverride(),
  });
  const warnings = validateRuntimeConfigFile(configPath, input.config);
  const tokenPresent = Boolean(input.authContext?.accessToken?.trim());
  const apiKeyPresent = Boolean(
    typeof providerOptions?.apiKey === "string" &&
      providerOptions.apiKey.trim().length > 0,
  );

  return {
    status: warnings.length === 0 ? "ok" : "error",
    runtime: "local-runtime",
    surface: doctorSurfaceForOwnerKind(input.runtimeOwnerKind),
    runtimeMode: input.runtimeMode,
    runtimeOwner: {
      kind: input.runtimeOwnerKind,
      id: input.runtimeOwnerId,
    },
    runtimeHttp: {
      startupTokenPresent: Boolean(input.runtimeStartupToken),
    },
    paths: {
      dataDir,
      configPath,
      authCachePath,
      configPresent: existsSync(configPath),
      authCachePresent: existsSync(authCachePath),
    },
    selection: {
      defaultModel: input.config.defaultModel ?? null,
      providerId: providerId ?? null,
      modelId: modelId ?? null,
    },
    provider: {
      id: providerId ?? null,
      baseURL:
        providerOptions?.baseURL === undefined
          ? null
          : (sanitizeConfigValue("baseURL", providerOptions.baseURL) as string),
      authMode: authModeResolution.authMode,
      authModeSource: authModeResolution.source,
      authModeSourceLabel: formatAuthModeSource(authModeResolution.source),
      managedBaseURL: authModeResolution.managedBaseURL,
      apiKeyPresent,
    },
    auth: {
      tokenPresent,
      realUserIDPresent: Boolean(input.authContext?.realUserID?.trim()),
      userEmailPresent: Boolean(input.authContext?.userEmail?.trim()),
      userNamePresent: Boolean(input.authContext?.userName?.trim()),
      subUserNamePresent: Boolean(input.authContext?.subUserName?.trim()),
    },
    // Presence booleans / counts only — BYOK trees hold plaintext keys.
    byok: {
      minimaxApiKeyPresent: Boolean(input.config.minimax_api?.apiKey?.trim()),
      customProviderCount: Object.keys(input.config.custom_provider ?? {})
        .length,
    },
    observability: {
      eventLogEnabled: true,
      runtimeLogDir: logsDir,
      runtimeEventsDir,
    },
    diagnostics: {
      bundleAvailable: true,
      hostProvider: input.hostDiagnosticsAvailable
        ? input.runtimeOwnerKind
        : null,
      hostCaptures: {
        upload: Boolean(input.hostDiagnosticsAvailable),
      },
    },
    capabilities: input.capabilities,
    surfaces: input.surfaces,
    warnings,
  };
}

function validateRuntimeConfigFile(
  configPath: string,
  effectiveConfig?: LocalRuntimeConfig,
): string[] {
  if (!existsSync(configPath)) return ["Config file does not exist."];

  let parsed: unknown;
  try {
    parsed = yaml.load(readFileSync(configPath, "utf-8"));
  } catch (error) {
    if (error instanceof yaml.YAMLException) {
      const line = error.mark?.line;
      const column = error.mark?.column;
      if (typeof line === "number" && typeof column === "number") {
        return [
          `Config file is not valid YAML at line ${line + 1}, column ${column + 1}.`,
        ];
      }
      return ["Config file is not valid YAML."];
    }
    return ["Config file cannot be read."];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ["Config root must be a YAML object."];
  }

  const fileConfig = parsed as LocalRuntimeConfig;
  const defaultModel = fileConfig.defaultModel?.trim();
  const selection = parseSourceQualifiedModelKey(defaultModel);
  if (!defaultModel || !selection) {
    return ['defaultModel must use the "provider/model" format.'];
  }
  const availability = resolveModelAvailability({
    config: fileConfig,
    providerId: selection.providerId,
    modelId: selection.modelId,
    preset: getRuntimePresetKey(),
    source: "config_default",
  });
  if (!availability.available) {
    const effectiveProvider = effectiveConfig?.provider?.[selection.providerId];
    const effectiveAuthMode = resolveProviderAuthMode({
      authMode: effectiveProvider?.options?.authMode,
      baseURL: effectiveProvider?.options?.baseURL,
    }).authMode;

    // Managed runtime deliberately keeps the protected provider on disk untouched.
    // Validate the raw file for syntax, but use the already-resolved managed provider
    // for this route so Doctor agrees with the process that executes turns.
    const rawProviderIsObject =
      fileConfig.provider === undefined || isRecord(fileConfig.provider);
    if (
      selection.providerId === "minimax" &&
      effectiveAuthMode === "managed-login" &&
      rawProviderIsObject
    ) {
      const effectiveAvailability = resolveModelAvailability({
        config: {
          ...fileConfig,
          ...(effectiveConfig?.minimaxModelSource !== undefined
            ? { minimaxModelSource: effectiveConfig.minimaxModelSource }
            : {}),
          provider: {
            ...(isRecord(fileConfig.provider) ? fileConfig.provider : {}),
            minimax: effectiveProvider,
          } as LocalRuntimeConfig["provider"],
        },
        providerId: selection.providerId,
        modelId: selection.modelId,
        preset: getRuntimePresetKey(),
        source: "config_default",
      });
      if (effectiveAvailability.available) return [];
    }

    return [
      `defaultModel "${defaultModel}" is not available; choose a configured provider/model.`,
    ];
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatAuthModeSource(source: ProviderAuthModeSource): string {
  if (source === "explicit") return "explicit";
  if (source === "inferred-managed-base-url")
    return "compatibility inference from managed baseURL";
  return "default api-key behavior";
}

function doctorSurfaceForOwnerKind(kind: string): string {
  if (kind === "electron") return "electron";
  if (kind === "cli") return "cli-standalone";
  return kind;
}
