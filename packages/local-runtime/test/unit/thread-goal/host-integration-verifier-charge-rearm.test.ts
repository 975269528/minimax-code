import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  digestThreadGoalObjective,
  type ThreadGoalState,
  type TranscriptWindowReader,
  type VerificationResult,
  type VerifierPort,
} from "@mavis/goal";

import { closeLocalRuntimeDb } from "../../../src/persistence/db.js";
import { LocalThreadGoalIntegration } from "../../../src/thread-goal/host-integration.js";
import { LocalActiveTurnTimingRegistry } from "../../../src/turns/active-turn-timing.js";

/**
 * The combination !6769 left open: an explicit user message re-arms the
 * continuation and the rebuilt Turn is admitted, and only *then* does the
 * subagent verifier that was still running get charged.
 *
 * That charge is stale by construction — the user's breaker reset moved the
 * epoch out from under the verifier's binding — but it is not a decision: it
 * only records tokens that were already spent. While it also advanced the
 * decision epoch, it silently retired the binding of the Turn the queue had
 * just admitted, so that Turn's first tool call was refused with
 * `GOAL_TURN_NOT_CURRENT`, its own settlement stopped at the stale stage, and
 * the re-arm marker was already spent. The Goal was left `active` with an
 * empty queue and an idle session until the next process restart.
 *
 * These tests drive the real SQLite store and the real verifier dispatch so
 * the epoch writes, the tool gate and the settlement CAS are the production
 * ones, and they pin both interleavings of the charge against the admission.
 */

const SESSION = "sess_verifier_charge_rearm";
const OBJECTIVE = "Ship the release candidate";
const MAIN_TURN = "turn_goal_main";
const USER_TURN = "turn_user";
const REARMED_TURN = "turn_goal_rearmed";
const MAIN_TOKENS = 1_752;
const VERIFIER_TOKENS = 1_887;
const REARMED_TOKENS = 636;

let dataDir: string;
let now: number;
let integration: LocalThreadGoalIntegration;
let turnTimings: LocalActiveTurnTimingRegistry;
let enqueuePostTurnContinuation: ReturnType<typeof vi.fn>;
let verifierStarted: Deferred<void>;
let verifierVerdict: Deferred<VerificationResult>;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "goal-verifier-charge-rearm-"));
  now = 1_700_000_000_000;
  turnTimings = new LocalActiveTurnTimingRegistry(() => now);
  enqueuePostTurnContinuation = vi.fn(async () => undefined);
  verifierStarted = deferred<void>();
  verifierVerdict = deferred<VerificationResult>();
  const verifier: VerifierPort = {
    dispatch: vi.fn(async () => {
      verifierStarted.resolve();
      return verifierVerdict.promise;
    }),
  };
  const transcriptReader: TranscriptWindowReader = {
    capture: vi.fn(async () => ({
      messages: [{ role: "assistant", content: "Release checks finished." }],
      truncated: false,
    })),
  };
  integration = new LocalThreadGoalIntegration({
    dataDir,
    nowMs: () => now,
    turnTimingReader: turnTimings,
    publishGlobalEvent: vi.fn(),
    isSessionBusy: (sessionId) =>
      turnTimings.getBySession(sessionId) !== undefined,
    hasPendingQuestionnaire: async () => false,
    retireGoalQuestionnaire: async () => false,
    hasPendingPermission: async () => false,
    hasAutomationOwnerConflict: async () => false,
    hasRequiredBackgroundWork: async () => false,
    startContinuationTurn: async () => undefined,
    enqueueInitialContinuationTurn: async () => undefined,
    enqueuePostTurnContinuation,
    cancelInitialContinuation: async () => undefined,
    requestQueueDispatch: vi.fn(),
    hasPendingInitialContinuation: async () => false,
    reportFailure: vi.fn(),
    emitRuntimeEvent: vi.fn(),
    formatError: (error) =>
      error instanceof Error ? error.message : String(error),
    isEnabled: () => true,
  });
  integration.bindConfigGetter(() => ({
    goal: {
      verification: "subagent",
      budget: {
        defaultTokens: 5_000_000,
        defaultMainTurns: 50,
        defaultActiveSeconds: 14_400,
        graceSteps: 1,
      },
      verifier: { repeatedNotMetLimit: 5, evidence: "brief" },
      evaluator: { maxTokens: 32_000 },
      subagent: { maxTokens: 500_000 },
    },
  }));
  integration.bindVerifier(verifier, transcriptReader);
});

afterEach(async () => {
  closeLocalRuntimeDb(dataDir);
  await rm(dataDir, { recursive: true, force: true });
});

async function seedRunningGoal(): Promise<ThreadGoalState> {
  const created = await integration.store.create({
    sessionId: SESSION,
    objective: OBJECTIVE,
  });
  const enqueued = await integration.store.transitionKickoffState(
    created.goalId,
    created.kickoffState,
    "enqueued",
  );
  const consumed = await integration.store.transitionKickoffState(
    created.goalId,
    enqueued?.kickoffState ?? "enqueued",
    "consumed",
  );
  if (!consumed) throw new Error("expected a kickoff-consumed Goal");
  return consumed;
}

async function admitGoalTurn(
  goal: ThreadGoalState,
  turnId: string,
): Promise<void> {
  turnTimings.begin(SESSION, turnId);
  const prepared = await integration.prepareTurnAdmission({
    sessionId: SESSION,
    turnId,
    provenance: {
      source: "thread-goal",
      sourceContext: {
        origin: {
          type: "thread-goal-continuation",
          goalId: goal.goalId,
          goalUpdatedAt: goal.updatedAt,
          objectiveDigest: digestThreadGoalObjective(goal.objective),
          kind: "active",
        },
      },
    },
    hasPendingPlan: async () => false,
    hasPriorityMailboxWork: async () => false,
  });
  if (prepared?.status !== "ready") {
    throw new Error(
      `expected a ready Goal admission, got ${JSON.stringify(prepared)}`,
    );
  }
  await prepared.commit();
}

/** Admit the explicit user message exactly the way TurnSystem does. */
async function admitUserTurn(turnId: string): Promise<void> {
  const prepared = await integration.prepareTurnAdmission({
    sessionId: SESSION,
    turnId,
    provenance: { source: "api" },
    hasPendingPlan: async () => false,
    hasPriorityMailboxWork: async () => false,
  });
  if (prepared?.status !== "ready") {
    throw new Error(
      `expected a ready user admission, got ${JSON.stringify(prepared)}`,
    );
  }
  turnTimings.begin(SESSION, turnId);
  await prepared.commit();
}

async function proposeCompletion(turnId: string): Promise<void> {
  const updateGoal = (await integration.runtimeToolsFor(false, SESSION)).find(
    (tool) => tool.def.name === "update_goal",
  );
  if (!updateGoal) throw new Error("expected the update_goal tool");
  await updateGoal.impl.execute(
    { sessionId: SESSION, turnId },
    { status: "complete" },
  );
}

function settleInput(turnId: string, tokens: number) {
  return {
    sessionId: SESSION,
    turnId,
    status: "completed" as const,
    tokens,
    retracted: false,
    workerModelKey: "configured-provider/worker-model",
  };
}

/** The re-armed follow-up origin, as it was handed to the Queue transport. */
function rearmedOrigin(): Record<string, unknown> {
  const [submitted] = enqueuePostTurnContinuation.mock.calls.at(-1) as [
    { readonly message: { readonly origin?: unknown } },
  ];
  return submitted.message.origin as Record<string, unknown>;
}

/**
 * Run the shared prefix: main Turn settles into a subagent verification, the
 * user interrupts, and the drain rebuilds the follow-up at the new epoch.
 * Returns the in-flight main settlement so the caller can choose when the
 * verifier verdict — and with it the stale charge — lands.
 */
async function interruptVerifiedGoal(): Promise<{
  readonly settlement: Promise<unknown>;
  readonly rearmed: ThreadGoalState;
}> {
  const goal = await seedRunningGoal();
  await admitGoalTurn(goal, MAIN_TURN);
  await proposeCompletion(MAIN_TURN);

  now += 1;
  const settlement = integration.settleInjectedTurn(
    settleInput(MAIN_TURN, MAIN_TOKENS),
  );
  await verifierStarted.promise;
  turnTimings.finish(SESSION, MAIN_TURN);

  // The user types while the verifier is still running: the breaker reset
  // advances the epoch and arms the re-arm marker.
  now += 1;
  await admitUserTurn(USER_TURN);
  now += 1;
  await integration.settleInjectedTurn(settleInput(USER_TURN, 0));
  turnTimings.finish(SESSION, USER_TURN);
  expect(enqueuePostTurnContinuation).toHaveBeenCalled();

  const rearmed = await integration.store.getBySession(SESSION);
  if (!rearmed) throw new Error("expected the Goal to survive the user Turn");
  expect(rearmedOrigin()).toMatchObject({
    type: "thread-goal-continuation",
    goalId: rearmed.goalId,
    goalUpdatedAt: rearmed.updatedAt,
  });
  return { settlement, rearmed };
}

describe("LocalThreadGoalIntegration stale verifier charge vs. re-armed continuation", () => {
  it("keeps a re-armed continuation runnable when the stale verifier charge lands after it was admitted", async () => {
    const { settlement, rearmed } = await interruptVerifiedGoal();

    // The rebuilt follow-up is admitted at the current epoch and starts.
    now += 1;
    await admitGoalTurn(rearmed, REARMED_TURN);
    await expect(
      integration.checkTurnBudget({
        sessionId: SESSION,
        turnId: REARMED_TURN,
        observedTokens: 0,
      }),
    ).resolves.toMatchObject({ decision: "allow" });

    // Only now does the verifier finish. Its verdict is stale and rejected —
    // which is correct — but its charge must not retire the running Turn.
    now += 1;
    verifierVerdict.resolve({
      backend: "subagent",
      verdict: { verdict: "met", reason: "The release evidence is complete." },
      usage: {
        tokens: VERIFIER_TOKENS,
        activeSeconds: 4,
        incomplete: false,
        childTurns: 4,
      },
    });
    await settlement;

    const charged = await integration.store.getById(rearmed.goalId);
    // The stale verdict never completes the Goal, but the spend is recorded.
    expect(charged).toMatchObject({
      status: "active",
      tokensUsed: MAIN_TOKENS + VERIFIER_TOKENS,
    });
    expect(charged?.updatedAt).toBe(rearmed.updatedAt);

    // The running Turn keeps its tools ...
    await expect(
      integration.checkTurnBudget({
        sessionId: SESSION,
        turnId: REARMED_TURN,
        observedTokens: 0,
      }),
    ).resolves.toMatchObject({ decision: "allow" });

    // ... and settles as a real Turn, so something owns the next step.
    now += 1;
    enqueuePostTurnContinuation.mockClear();
    const decision = await integration.settleInjectedTurn(
      settleInput(REARMED_TURN, REARMED_TOKENS),
    );
    turnTimings.finish(SESSION, REARMED_TURN);
    expect(decision).not.toMatchObject({ action: "stale" });

    const final = await integration.store.getById(rearmed.goalId);
    // No token is lost: main Turn + verifier + re-armed Turn.
    expect(final?.tokensUsed).toBe(
      MAIN_TOKENS + VERIFIER_TOKENS + REARMED_TOKENS,
    );
    expect(final?.turnsUsed).toBe(2);
    // The Goal either moved on or has a follow-up queued — never `active`
    // with nothing left to run it.
    expect(
      final?.status !== "active" ||
        enqueuePostTurnContinuation.mock.calls.length > 0,
    ).toBe(true);
  });

  it("admits the re-armed continuation when the stale verifier charge lands first", async () => {
    // The other interleaving: the charge commits before the follow-up is
    // admitted. The admission then has to observe an epoch the charge did not
    // move, or the queue item is cancelled and nothing runs either.
    const { settlement } = await interruptVerifiedGoal();

    now += 1;
    verifierVerdict.resolve({
      backend: "subagent",
      verdict: { verdict: "met", reason: "The release evidence is complete." },
      usage: {
        tokens: VERIFIER_TOKENS,
        activeSeconds: 4,
        incomplete: false,
        childTurns: 4,
      },
    });
    await settlement;

    await expect(
      integration.classifyQueuedItem({
        sessionId: SESSION,
        clientRequestId: `thread-goal-followup:${MAIN_TURN}`,
        message: { origin: rearmedOrigin() },
      }),
    ).resolves.toBe("ready");

    const charged = await integration.store.getById(
      rearmedOrigin().goalId as string,
    );
    if (!charged) throw new Error("expected the charged Goal to persist");
    expect(charged).toMatchObject({
      status: "active",
      tokensUsed: MAIN_TOKENS + VERIFIER_TOKENS,
    });

    now += 1;
    await admitGoalTurn(charged, REARMED_TURN);
    await expect(
      integration.checkTurnBudget({
        sessionId: SESSION,
        turnId: REARMED_TURN,
        observedTokens: 0,
      }),
    ).resolves.toMatchObject({ decision: "allow" });
  });
});
