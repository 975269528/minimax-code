import type {
  CronDeliveryRequest as CronTurnDeliveryRequest,
  CronDeliveryResult as CronTurnDeliveryResult,
} from "@mavis/protocol/local";

export const CRON_SCHEDULER_HANDLER_KEY = "cron.run";

export type CronSchedule =
  | {
      readonly kind: "recurring";
      readonly expression: string;
      readonly timezone?: string;
      readonly maxRuns?: number;
    }
  | {
      readonly kind: "once";
      readonly runAtMs: number;
    };

export type CronSessionTarget =
  | { readonly mode: "new" }
  | { readonly mode: "sessionId"; readonly sessionId?: string };

export type CronSessionTargetInput =
  | { readonly mode: "new" }
  | { readonly mode: "sessionId"; readonly sessionId?: string };

/** Public-contract Cron definition. Runtime state is resolved by Scheduler capabilities. */
export interface CronDefinitionView {
  readonly cronId: string;
  readonly name: string;
  readonly agentName: string;
  readonly schedule: CronSchedule;
  readonly enabled: boolean;
  readonly prompt: string;
  readonly sessionTarget: CronSessionTarget;
  readonly project?: string | null;
  readonly model?: string | null;
  readonly nextRunAtMs?: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly consumedAtMs?: number;
  readonly deletedAtMs?: number;
}

export type CronRunViewStatus = "pending" | "delivered" | "failed";
export type CronRunViewTriggerSource = "manual" | "scheduled";

/** Public-contract Cron run. `sessionId` may be absent if the run fails before session creation. */
export interface CronRunView {
  readonly runId: string;
  readonly cronId: string;
  readonly triggerSource: CronRunViewTriggerSource;
  readonly sessionId?: string;
  readonly status: CronRunViewStatus;
  readonly createdAtMs: number;
  readonly deliveredAtMs?: number;
  readonly failedAtMs?: number;
  readonly errorCode?: string;
  readonly error?: string;
}

export interface CronPage<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface ListCronDefinitionsQuery {
  readonly cursor?: string;
  readonly limit?: number;
  readonly includeDeleted?: boolean;
  readonly agentName?: string;
}

export interface CreateCronDefinitionCommand {
  readonly name: string;
  readonly agentName: string;
  readonly schedule: CronSchedule;
  readonly prompt: string;
  readonly enabled?: boolean;
  readonly sessionTarget: CronSessionTargetInput;
  readonly project?: string | null;
  readonly model?: string | null;
}

export interface UpdateCronDefinitionCommand {
  readonly cronId: string;
  readonly name?: string;
  readonly schedule?: CronSchedule;
  readonly prompt?: string;
  readonly enabled?: boolean;
  readonly sessionTarget?: CronSessionTarget;
  readonly model?: string | null;
  readonly project?: string | null;
}

export interface DeleteCronDefinitionCommand {
  readonly cronId: string;
}

export type CronMutationMetricSource =
  | "ui"
  | "agent_tool"
  | "http_api"
  | "system";
export type CronTriggerMetricSource = CronMutationMetricSource | "schedule";
export type CronTriggerMetricOutcome =
  | "executed"
  | "enqueued"
  | "error"
  | "skipped";
export type CronExecutionMetricResult = "success" | "skipped" | "failure";

export interface CronMetricTask {
  readonly agentName: string;
  readonly schedule: CronSchedule;
  readonly sessionTarget: CronSessionTarget;
}

export interface CronMetricsClient {
  counter(name: string, delta?: number, labels?: Record<string, string>): void;
  histogram(name: string, value: number, labels?: Record<string, string>): void;
}

export interface CronMetrics {
  engineStarted(): void;
  taskCreated(task: CronMetricTask, source: CronMutationMetricSource): void;
  taskUpdated(task: CronMetricTask, source: CronMutationMetricSource): void;
  taskDeleted(task: CronMetricTask, source: CronMutationMetricSource): void;
  taskTriggered(
    task: CronMetricTask,
    source: CronTriggerMetricSource,
    outcome: CronTriggerMetricOutcome,
  ): void;
  taskExecuted(
    agentName: string,
    result: CronExecutionMetricResult,
    durationMs: number,
  ): void;
  taskFailed(agentName: string, errorCode: string): void;
}

export interface CronMutationMetricContext {
  readonly mutationSource: CronMutationMetricSource;
}

type CronModelSelectionResolution =
  | { readonly kind: "resolved"; readonly modelKey: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "not_found" };

/** Resolves user-authored model text against the current Runtime model catalog. */
export interface CronModelSelectionPort {
  resolve(model: string): CronModelSelectionResolution;
}

export interface CronManualTriggerMetricContext {
  readonly triggerSource: Exclude<CronTriggerMetricSource, "schedule">;
  /** Stable request identity reused across retries to converge on one manual Run. */
  readonly requestId?: string;
}

export interface ListCronRunsQuery {
  readonly cronId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/** Shared Cron business entry point for HTTP, Agent cleanup, and other callers. */
export interface CronService {
  listDefinitions(
    query: ListCronDefinitionsQuery,
  ): CronPage<CronDefinitionView>;
  getDefinition(cronId: string): CronDefinitionView | undefined;
  createDefinition(
    command: CreateCronDefinitionCommand,
    context?: CronMutationMetricContext,
  ): Promise<CronDefinitionView>;
  updateDefinition(
    command: UpdateCronDefinitionCommand,
    context?: CronMutationMetricContext,
  ): Promise<CronDefinitionView>;
  deleteDefinition(
    command: DeleteCronDefinitionCommand,
    context?: CronMutationMetricContext,
  ): void | Promise<void>;
  deleteDefinitionsByAgent(agentName: string): void;
  triggerManualRun(
    cronId: string,
    context?: CronManualTriggerMetricContext,
  ): Promise<CronRunView>;
  listRuns(query: ListCronRunsQuery): CronPage<CronRunView>;
}

export interface CronSessionCreationRequest {
  readonly agentName: string;
  readonly cronId: string;
  readonly cronName: string;
  readonly runId: string;
  readonly runCreatedAtMs: number;
  readonly sessionTarget: CronSessionTarget;
  /** Definition-scoped overrides apply only when a fresh session is created. */
  readonly project?: string | null;
  readonly model?: string | null;
}

export interface CronSessionCreationResult {
  readonly sessionId: string;
}

export interface CronSessionCreationPort {
  create(
    request: CronSessionCreationRequest,
  ): Promise<CronSessionCreationResult>;
  /** Keep the dedicated Single-run conversation title aligned with its Cron definition. */
  rename?(sessionId: string, title: string): Promise<void>;
  discard?(sessionId: string): Promise<void>;
  /** Preserve execution conversations while removing their scheduled-task ownership. */
  detach?(cronId: string, targetSessionId?: string): Promise<void>;
}

export interface CronDeliveryRequest {
  readonly cronId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly agentName: string;
  readonly cronName: string;
  readonly text: string;
}

export type CronDeliveryResult =
  | { readonly delivered: true }
  | {
      readonly delivered: false;
      readonly errorCode: string;
      readonly error?: string;
    };

export interface CronSessionDeliveryPort {
  deliver(request: CronDeliveryRequest): Promise<CronDeliveryResult>;
}

export interface CronSessionPorts {
  readonly sessionCreation: CronSessionCreationPort;
  readonly delivery: CronSessionDeliveryPort;
}

/** Narrow delivery capability used by the generated DeliverCron RPC. */
export interface CronTurnDeliveryPort {
  deliver(request: CronTurnDeliveryRequest): Promise<CronTurnDeliveryResult>;
}

export interface CronDefinitionRecord {
  readonly cronId: string;
  readonly schedulerId: string;
  readonly agentName: string;
  readonly name: string;
  readonly prompt: string;
  readonly sessionTarget: CronSessionTarget;
  readonly project?: string | null;
  readonly model?: string | null;
  readonly revision: number;
  readonly deletedAtMs?: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** Execution input resolved by the executor from the current Definition. */
export interface CronExecutionInput {
  readonly agentName: string;
  readonly cronName: string;
  readonly prompt: string;
  readonly sessionTarget: CronSessionTarget;
  readonly project?: string | null;
  readonly model?: string | null;
}

export interface NewCronDefinitionRecord {
  readonly cronId?: string;
  readonly schedulerId: string;
  readonly agentName: string;
  readonly name: string;
  readonly prompt: string;
  readonly sessionTarget: CronSessionTarget;
  readonly project?: string | null;
  readonly model?: string | null;
  readonly createdAtMs: number;
}

export interface CronDefinitionPatch {
  readonly name?: string;
  readonly prompt?: string;
  readonly sessionTarget?: CronSessionTarget;
  readonly model?: string | null;
  readonly project?: string | null;
}

export interface CronDefinitionRepository {
  insert(input: NewCronDefinitionRecord): CronDefinitionRecord;
  get(
    cronId: string,
    includeDeleted?: boolean,
  ): CronDefinitionRecord | undefined;
  getBySchedulerId(
    schedulerId: string,
    includeDeleted?: boolean,
  ): CronDefinitionRecord | undefined;
  listPage(query: CronDefinitionPageQuery): CronDefinitionRecord[];
  update(
    cronId: string,
    expectedRevision: number,
    patch: CronDefinitionPatch,
    nowMs: number,
  ): CronDefinitionRecord;
  /** Bind the first created Session; concurrent callers converge on the stored winner. */
  bindPendingTargetSession(
    cronId: string,
    sessionId: string,
    nowMs: number,
  ): CronDefinitionRecord;
  tombstone(
    cronId: string,
    expectedRevision: number,
    nowMs: number,
  ): CronDefinitionRecord;
  hardDelete(cronId: string): boolean;
}

export interface CronDefinitionPageQuery {
  readonly agentName?: string;
  readonly includeDeleted?: boolean;
  readonly before?: { readonly createdAtMs: number; readonly cronId: string };
  readonly take: number;
}

type CronRunStatus = "pending" | "delivered" | "failed";
export type CronRunTriggerSource = "manual" | "scheduled";

export interface CronRun {
  readonly runId: string;
  readonly cronId: string;
  readonly schedulerTriggerId?: string;
  readonly requestId?: string;
  readonly triggerSource: CronRunTriggerSource;
  readonly sessionId?: string;
  readonly status: CronRunStatus;
  readonly createdAtMs: number;
  readonly executionClaimedAtMs?: number;
  readonly deliveredAtMs?: number;
  readonly failedAtMs?: number;
  readonly errorCode?: string;
  readonly error?: string;
}

export interface CronRunRepository {
  insertPendingManualForDefinition(
    cronId: string,
    createdAtMs: number,
    requestId?: string,
  ): CronRun;
  insertPendingScheduled(
    cronId: string,
    schedulerTriggerId: string,
    createdAtMs: number,
  ): CronRun;
  get(runId: string): CronRun | undefined;
  getByManualRequestId(requestId: string): CronRun | undefined;
  getBySchedulerTriggerId(schedulerTriggerId: string): CronRun | undefined;
  listPage(query: CronRunPageQuery): CronRun[];
  listPending(): CronRun[];
  hasPendingForCronId(cronId: string): boolean;
  claimExecution(runId: string, claimedAtMs: number): CronRun | undefined;
  attachSession(runId: string, sessionId: string): boolean;
  markDelivered(runId: string, deliveredAtMs: number): boolean;
  markFailed(input: MarkCronRunFailedInput): boolean;
  deleteByCronId(cronId: string): number;
}

export interface CronRunPageQuery {
  readonly cronId: string;
  readonly before?: { readonly createdAtMs: number; readonly runId: string };
  readonly take: number;
}

export interface MarkCronRunFailedInput {
  readonly runId: string;
  readonly failedAtMs: number;
  readonly errorCode: string;
  readonly error?: string;
}

export interface CreateCronDefinitionInput {
  readonly cronId?: string;
  readonly schedulerId?: string;
  readonly agentName: string;
  readonly name: string;
  readonly prompt: string;
  readonly sessionTarget: CronSessionTarget;
  readonly project?: string | null;
  readonly model?: string | null;
  readonly schedule: CronSchedule;
  readonly active?: boolean;
  readonly nowMs: number;
}

export interface UpdateCronDefinitionInput {
  readonly cronId: string;
  readonly name?: string;
  readonly prompt?: string;
  readonly sessionTarget?: CronSessionTarget;
  readonly schedule?: CronSchedule;
  readonly active?: boolean;
  readonly model?: string | null;
  readonly project?: string | null;
  readonly nowMs: number;
}

export interface DeleteCronDefinitionInput {
  readonly cronId: string;
  readonly nowMs: number;
  readonly deleteRuns?: boolean;
}
