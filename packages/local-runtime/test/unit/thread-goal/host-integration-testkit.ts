/**
 * `LocalThreadGoalIntegration` — host-side wiring for steering injection.
 *
 * Targets the MR-2/3/4 surfaces in isolation: the integration class
 * doesn't depend on `LocalApiHost`, so we can drive it with vi.fn() deps
 * and pin the codex-parity behaviour without a SQLite round trip.
 *
 * Pins:
 *   - PATCH with `objectiveChanged: true` steers the codex
 *     `objective_updated` prompt into a busy Turn immediately
 *   - The edited objective invalidates model-authored completion from the
 *     pre-edit Turn, while a successor Turn can finalize normally
 *   - PATCH with `objectiveChanged: true` and an idle session does NOT
 *     abort; instead the next `continue_if_idle` kick swaps in the
 *     objective_updated prompt (consumed once)
 *   - settlement that observes `budget_limited` queues one hidden summary
 *     using a restart-stable idempotency key
 *   - a later ordinary Turn is never attributed to a Goal that had already
 *     stopped before that Turn began, while a mid-Turn completion still keeps
 *     the usage accrued before its status boundary
 *   - Budget summary delivery is reconstructed from durable status and keyed
 *     by Goal id + epoch; repeated settlement does not enqueue twice
 */

import { describe, expect, it, vi } from "vitest";
import type {
  InternalTurnPromptReadRegistry,
  PromptSnapshotSource,
} from "@mavis/agent-core";

import {
  digestThreadGoalObjective,
  type GoalTurnBinding,
  type ThreadGoalBoundStoreOperations,
  type ThreadGoalBoundUsageDelta,
  type ThreadGoalBoundUsageResult,
  type ThreadGoalDecisionResult,
  type ThreadGoalPatchInput,
  type ThreadGoalState,
  type ThreadGoalStore,
} from "@mavis/goal";

import { LocalThreadGoalIntegration } from "../../../src/thread-goal/host-integration.js";
import type { LocalQueuedMessage } from "../../../src/messages/queue.js";
import { LocalActiveTurnTimingRegistry } from "../../../src/turns/active-turn-timing.js";

function goal(overrides: Partial<ThreadGoalState> = {}): ThreadGoalState {
  return {
    goalId: "tg_int_1",
    sessionId: "sess_int",
    objective: "Audit the build pipeline",
    status: "active",
    createdAt: 0,
    updatedAt: 1_700_000_000_000,
    tokensUsed: 0,
    turnsUsed: 0,
    timeUsedSeconds: 0,
    tokenBudget: null,
    replyFingerprint: null,
    noProgressStreak: 0,
    noToolStreak: 0,
    lastVerification: undefined,
    statusReason: null,
    kickoffAttachments: [],
    kickoffState: "consumed",
    executionWait: null,
    ...overrides,
  };
}

type HostGoalStore = ThreadGoalStore &
  ThreadGoalBoundStoreOperations & {
    patchByUser(
      goalId: string,
      input: ThreadGoalPatchInput,
    ): Promise<ThreadGoalState>;
    resetBreakerAtEpoch(
      goalId: string,
      expectedEpoch: number,
    ): Promise<ThreadGoalState | undefined>;
    transitionActiveAtEpoch(
      goalId: string,
      expectedEpoch: number,
      input: {
        readonly status: "paused" | "budget_limited";
        readonly statusReason: NonNullable<ThreadGoalState["statusReason"]>;
      },
    ): Promise<ThreadGoalState | undefined>;
    setExecutionWaitAtEpoch(input: {
      readonly goalId: string;
      readonly expectedUpdatedAt: number;
      readonly reason: NonNullable<ThreadGoalState["executionWait"]>["reason"];
    }): Promise<ThreadGoalState | undefined>;
    clearExecutionWaitAtEpoch(input: {
      readonly goalId: string;
      readonly expectedUpdatedAt: number;
    }): Promise<ThreadGoalState | undefined>;
    pauseActiveBySession(): Promise<ThreadGoalState | undefined>;
    listRecoverableKickoffs(): Promise<ThreadGoalState[]>;
    listRecoverableActiveGoals(): Promise<ThreadGoalState[]>;
    listRecoverableBudgetLimitSummaries(): Promise<ThreadGoalState[]>;
    transitionKickoffState(): Promise<ThreadGoalState | undefined>;
  };

type StoreOverrides = Partial<HostGoalStore>;

function makeStore(overrides: StoreOverrides = {}): HostGoalStore {
  const getBySession = overrides.getBySession ?? (async () => undefined);
  const getById =
    overrides.getById ??
    (async (goalId: string) => {
      const current = await getBySession("sess_int");
      return current?.goalId === goalId ? current : undefined;
    });
  const patch = overrides.patch ?? (async () => goal());
  return {
    getBySession,
    getById,
    create: async () => goal(),
    patch,
    patchByUser: overrides.patchByUser ?? patch,
    bumpBoundUsage: async () => ({ staleReason: "missing_goal" }),
    settleBoundTurn: async () => ({
      status: "stale",
      staleReason: "missing_goal",
    }),
    updateBreaker: async () => ({
      action: "stale",
      staleReason: "missing_goal",
    }),
    resetBreakerAtEpoch: async () => undefined,
    transitionActiveAtEpoch: async () => undefined,
    setExecutionWaitAtEpoch: async () => undefined,
    clearExecutionWaitAtEpoch: async () => undefined,
    pauseActiveBySession: async () => undefined,
    delete: async () => undefined,
    listRecoverableKickoffs: async () => [],
    listRecoverableActiveGoals: async () => [],
    listRecoverableBudgetLimitSummaries: async () => [],
    transitionKickoffState: async () => undefined,
    ...overrides,
  } as HostGoalStore;
}

function makeIntegration(
  opts: {
    store?: HostGoalStore;
    dataDir?: string;
    isSessionBusy?: () => boolean;
    useTurnTimingBusyFallback?: boolean;
    startContinuationTurn?: ReturnType<typeof vi.fn>;
    steerContinuationTurn?: ReturnType<typeof vi.fn>;
    emitBusEvent?: ReturnType<typeof vi.fn>;
    emitRuntimeEvent?: ReturnType<typeof vi.fn>;
    reportFailure?: ReturnType<typeof vi.fn>;
    enqueueInitialContinuationTurn?: ReturnType<typeof vi.fn>;
    enqueuePostTurnContinuation?: ReturnType<typeof vi.fn>;
    abortThreadGoalTurn?: ReturnType<typeof vi.fn>;
    requestQueueDispatch?: ReturnType<typeof vi.fn>;
    cancelInitialContinuation?: ReturnType<typeof vi.fn>;
    hasPendingInitialContinuation?: (
      sessionId: string,
      clientRequestId: string,
    ) => Promise<boolean> | boolean;
    hasPendingQuestionnaire?: (
      sessionId: string,
      expectedGoalId: string,
    ) => Promise<boolean> | boolean;
    retireGoalQuestionnaire?: (
      sessionId: string,
      goalId: string,
    ) => Promise<boolean> | boolean;
    hasPendingPermission?: () => Promise<boolean> | boolean;
    hasAutomationOwnerConflict?: () => Promise<boolean> | boolean;
    hasRequiredBackgroundWork?: () => Promise<boolean> | boolean;
    now?: () => number;
    turnTimings?: LocalActiveTurnTimingRegistry;
    isEnabled?: () => boolean;
    promptSnapshots?: () => PromptSnapshotSource | undefined;
    internalTurnPromptReads?: () => InternalTurnPromptReadRegistry | undefined;
  } = {},
): {
  integration: LocalThreadGoalIntegration;
  startContinuationTurn: ReturnType<typeof vi.fn>;
  steerContinuationTurn?: ReturnType<typeof vi.fn>;
  emitBusEvent: ReturnType<typeof vi.fn>;
  emitRuntimeEvent: ReturnType<typeof vi.fn>;
  reportFailure: ReturnType<typeof vi.fn>;
  enqueueInitialContinuationTurn: ReturnType<typeof vi.fn>;
  enqueuePostTurnContinuation: ReturnType<typeof vi.fn>;
  cancelInitialContinuation: ReturnType<typeof vi.fn>;
  requestQueueDispatch: ReturnType<typeof vi.fn>;
  turnTimings: LocalActiveTurnTimingRegistry;
} {
  const startContinuationTurn =
    opts.startContinuationTurn ?? vi.fn(async () => undefined);
  const emitBusEvent = opts.emitBusEvent ?? vi.fn();
  const emitRuntimeEvent = opts.emitRuntimeEvent ?? vi.fn();
  const reportFailure = opts.reportFailure ?? vi.fn();
  const enqueueInitialContinuationTurn =
    opts.enqueueInitialContinuationTurn ?? vi.fn(async () => undefined);
  const enqueuePostTurnContinuation =
    opts.enqueuePostTurnContinuation ?? vi.fn(async () => undefined);
  const requestQueueDispatch = opts.requestQueueDispatch ?? vi.fn();
  const cancelInitialContinuation =
    opts.cancelInitialContinuation ?? vi.fn(async () => undefined);
  const store = opts.store ?? makeStore();
  const now = opts.now ?? (() => 1_700_000_000_000);
  const turnTimings =
    opts.turnTimings ?? new LocalActiveTurnTimingRegistry(now);
  if (!opts.turnTimings) turnTimings.begin("sess_int", "turn_int");
  const integration = new LocalThreadGoalIntegration({
    dataDir: opts.dataDir ?? "unused",
    nowMs: now,
    turnTimingReader: turnTimings,
    publishGlobalEvent: emitBusEvent,
    ...(opts.promptSnapshots ? { promptSnapshots: opts.promptSnapshots } : {}),
    ...(opts.internalTurnPromptReads
      ? { internalTurnPromptReads: opts.internalTurnPromptReads }
      : {}),
    emitRuntimeEvent,
    isSessionBusy: opts.useTurnTimingBusyFallback
      ? (sessionId) => turnTimings.getBySession(sessionId) !== undefined
      : (opts.isSessionBusy ?? (() => false)),
    hasPendingQuestionnaire:
      opts.hasPendingQuestionnaire ?? (async () => false),
    retireGoalQuestionnaire:
      opts.retireGoalQuestionnaire ?? (async () => false),
    hasPendingPermission: opts.hasPendingPermission ?? (async () => false),
    hasAutomationOwnerConflict:
      opts.hasAutomationOwnerConflict ?? (async () => false),
    hasRequiredBackgroundWork:
      opts.hasRequiredBackgroundWork ?? (async () => false),
    startContinuationTurn,
    enqueueInitialContinuationTurn,
    enqueuePostTurnContinuation,
    ...(opts.abortThreadGoalTurn
      ? { abortThreadGoalTurn: opts.abortThreadGoalTurn }
      : {}),
    ...(opts.steerContinuationTurn
      ? { steerContinuationTurn: opts.steerContinuationTurn }
      : {}),
    cancelInitialContinuation,
    requestQueueDispatch,
    hasPendingInitialContinuation:
      opts.hasPendingInitialContinuation ?? (async () => false),
    reportFailure,
    formatError: (err) => (err instanceof Error ? err.message : String(err)),
    isEnabled: opts.isEnabled ?? (() => true),
  });
  // Test seam — replace the constructor-built SQLite store with the fake
  // so the deterministic behaviour under test doesn't touch disk.
  (integration as unknown as { store: HostGoalStore }).store = store;
  return {
    integration,
    startContinuationTurn,
    steerContinuationTurn: opts.steerContinuationTurn,
    emitBusEvent,
    emitRuntimeEvent,
    reportFailure,
    enqueueInitialContinuationTurn,
    enqueuePostTurnContinuation,
    cancelInitialContinuation,
    requestQueueDispatch,
    turnTimings,
  };
}

function kickoffQueueItem(
  overrides: Partial<LocalQueuedMessage> = {},
): LocalQueuedMessage {
  return {
    itemId: "queue_goal_1",
    sessionId: "sess_int",
    agentName: "mavis",
    source: "api",
    status: "queued",
    message: {
      content: "hidden continuation prompt",
      attachments: [],
      source: "thread-goal",
      origin: {
        type: "thread-goal-kickoff",
        goalId: "tg_int_1",
        goalUpdatedAt: 1_700_000_000_000,
        objectiveDigest: digestThreadGoalObjective("Audit the build pipeline"),
        displayContent: "Audit the build pipeline",
      },
    },
    clientRequestId: "thread-goal-kickoff:tg_int_1",
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function continuationQueueItem(
  overrides: Partial<LocalQueuedMessage> = {},
): LocalQueuedMessage {
  return {
    itemId: "queue_goal_followup_1",
    sessionId: "sess_int",
    agentName: "mavis",
    source: "thread-goal",
    status: "queued",
    message: {
      content: "hidden continuation prompt",
      attachments: [],
      source: "thread-goal",
      origin: {
        type: "thread-goal-continuation",
        goalId: "tg_int_1",
        goalUpdatedAt: 1_700_000_000_000,
        objectiveDigest: digestThreadGoalObjective("Audit the build pipeline"),
        kind: "active",
      },
    },
    clientRequestId: "thread-goal-followup:turn_int",
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function flushContinuationKick(): Promise<void> {
  // handleChanged/injectObjectiveUpdatedSteering fire-and-forget the async
  // maybeKickContinuation path; keep this helper resilient as guards are added.
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

async function admitGoalTurn(
  integration: LocalThreadGoalIntegration,
  current: ThreadGoalState,
  turnId: string,
  kind: "active" | "budget-limit" = "active",
): Promise<void> {
  const prepared = await integration.prepareTurnAdmission({
    sessionId: current.sessionId,
    turnId,
    provenance: {
      source: "thread-goal",
      sourceContext: {
        origin: {
          type: "thread-goal-continuation",
          goalId: current.goalId,
          goalUpdatedAt: current.updatedAt,
          objectiveDigest: digestThreadGoalObjective(current.objective),
          kind,
        },
      },
    },
    hasPendingPlan: async () => false,
    hasPriorityMailboxWork: async () => false,
  });
  if (prepared?.status !== "ready") {
    throw new Error(`expected ready Goal admission for ${turnId}`);
  }
  await prepared.commit();
}

async function submitGoalProposal(
  integration: LocalThreadGoalIntegration,
  status: "complete" | "blocked",
  turnId = "turn_int",
  summary?: string,
) {
  const updateGoal = (
    await integration.runtimeToolsFor(false, "sess_int")
  ).find((tool) => tool.def.name === "update_goal");
  if (!updateGoal) throw new Error("expected update_goal tool");
  return updateGoal.impl.execute(
    { sessionId: "sess_int", turnId },
    { status, ...(summary ? { summary } : {}) },
  );
}

function boundUsageResult(
  state: ThreadGoalState,
  overrides: Partial<ThreadGoalBoundUsageResult> = {},
): ThreadGoalBoundUsageResult {
  return {
    goal: state,
    decisionEpoch: state.updatedAt,
    transitioned: null,
    ...overrides,
  };
}

function settledDecision(state: ThreadGoalState): ThreadGoalDecisionResult {
  return { status: "settled", goal: state, decisionEpoch: state.updatedAt };
}

export {
  LocalActiveTurnTimingRegistry,
  LocalThreadGoalIntegration,
  admitGoalTurn,
  boundUsageResult,
  continuationQueueItem,
  describe,
  digestThreadGoalObjective,
  expect,
  flushContinuationKick,
  goal,
  it,
  kickoffQueueItem,
  makeIntegration,
  makeStore,
  settledDecision,
  submitGoalProposal,
  vi,
};

export type {
  GoalTurnBinding,
  HostGoalStore,
  LocalQueuedMessage,
  StoreOverrides,
  ThreadGoalBoundStoreOperations,
  ThreadGoalBoundUsageDelta,
  ThreadGoalBoundUsageResult,
  ThreadGoalDecisionResult,
  ThreadGoalPatchInput,
  ThreadGoalState,
  ThreadGoalStore,
};
