import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { digestThreadGoalObjective, type ThreadGoalState } from "@mavis/goal";

import { closeLocalRuntimeDb } from "../../../src/persistence/db.js";
import { LocalThreadGoalIntegration } from "../../../src/thread-goal/host-integration.js";
import { LocalActiveTurnTimingRegistry } from "../../../src/turns/active-turn-timing.js";

/**
 * Cross-fix combination coverage for the consolidated Goal MR.
 *
 * Each of the four fixes is already covered on its own source branch. What no
 * single branch could cover is the behaviour that only exists once they sit in
 * the same tree, because each one changed a touchpoint the others also use:
 *
 *   - the explicit-user-Turn breaker reset (M1) now also has to clear the
 *     no-tool counter (M3), and its re-arm has to survive an epoch that the
 *     breaker itself may have moved,
 *   - the breaker writes and advances the epoch at stage 8 (M3), which is
 *     exactly the epoch the re-arm generation guard (M1) compares against,
 *   - a verification wait (M2) is projected without advancing the epoch, so it
 *     must leave the breaker counters and the re-arm alone,
 *   - a dependency wait clears the streak before it enqueues the deferable
 *     continuation (M3), which is the ordering the Queue-local exclusion (M6)
 *     relies on to keep the deferred item while user work overtakes it.
 *
 * These drive the real SQLite store, so the epoch bumps, the breaker CAS and
 * the queue classification are the production ones rather than mocks.
 */

const NOW = 1_700_000_000_000;
const SESSION = "sess_four_fix_combination";
const OBJECTIVE = "Consolidate the Goal runtime fixes";

let dataDir: string;
let integration: LocalThreadGoalIntegration;
let turnTimings: LocalActiveTurnTimingRegistry;
let enqueuePostTurnContinuation: ReturnType<typeof vi.fn>;
let enqueueInitialContinuationTurn: ReturnType<typeof vi.fn>;
let cancelInitialContinuation: ReturnType<typeof vi.fn>;
let hasPendingInitialContinuation: ReturnType<typeof vi.fn>;
let reportFailure: ReturnType<typeof vi.fn>;
let kickoffQueued: boolean;
let permissionPending: boolean;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "goal-four-fix-combination-"));
  turnTimings = new LocalActiveTurnTimingRegistry(() => NOW);
  kickoffQueued = false;
  permissionPending = false;
  enqueuePostTurnContinuation = vi.fn(async () => undefined);
  enqueueInitialContinuationTurn = vi.fn(async () => {
    kickoffQueued = true;
  });
  cancelInitialContinuation = vi.fn(async () => {
    kickoffQueued = false;
  });
  hasPendingInitialContinuation = vi.fn(async () => kickoffQueued);
  reportFailure = vi.fn();
  integration = new LocalThreadGoalIntegration({
    dataDir,
    nowMs: () => NOW,
    turnTimingReader: turnTimings,
    publishGlobalEvent: () => undefined,
    isSessionBusy: (sessionId) =>
      turnTimings.getBySession(sessionId) !== undefined,
    hasPendingQuestionnaire: async () => false,
    retireGoalQuestionnaire: async () => false,
    hasPendingPermission: async () => permissionPending,
    hasAutomationOwnerConflict: async () => false,
    hasRequiredBackgroundWork: async () => false,
    startContinuationTurn: vi.fn(async () => undefined),
    enqueuePostTurnContinuation,
    enqueueInitialContinuationTurn,
    hasPendingInitialContinuation,
    cancelInitialContinuation,
    requestQueueDispatch: () => undefined,
    reportFailure,
    emitRuntimeEvent: vi.fn(),
    formatError: (error) =>
      error instanceof Error ? error.message : String(error),
    isEnabled: () => true,
  });
});

afterEach(async () => {
  closeLocalRuntimeDb(dataDir);
  await rm(dataDir, { recursive: true, force: true });
});

async function seedRunningGoal(): Promise<ThreadGoalState> {
  await integration.createGoal({ sessionId: SESSION, objective: OBJECTIVE });
  const enqueued = await integration.store.getBySession(SESSION);
  if (!enqueued) throw new Error("expected the seeded Goal to persist");
  await integration.store.transitionKickoffState(
    enqueued.goalId,
    enqueued.kickoffState,
    "consumed",
  );
  const goal = await integration.store.getBySession(SESSION);
  if (goal?.kickoffState !== "consumed") {
    throw new Error(
      `expected a kickoff-consumed Goal, got ${goal?.kickoffState}`,
    );
  }
  kickoffQueued = false;
  return goal;
}

function continuationOrigin(goal: ThreadGoalState): Record<string, unknown> {
  return {
    type: "thread-goal-continuation",
    goalId: goal.goalId,
    goalUpdatedAt: goal.updatedAt,
    objectiveDigest: digestThreadGoalObjective(goal.objective),
    kind: "active",
  };
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
      sourceContext: { origin: continuationOrigin(goal) },
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

/**
 * Admit an explicit user Turn the way TurnSystem does. `startTiming` stays off
 * while a Goal Turn is still in flight, so the in-flight binding is preserved
 * and only the committed breaker reset invalidates it.
 */
async function admitUserTurn(
  turnId: string,
  startTiming = true,
): Promise<void> {
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
  if (startTiming) turnTimings.begin(SESSION, turnId);
  await prepared.commit();
}

/** Settle a Goal-bound Turn that produced no tool call at all. */
async function settleToolLessGoalTurn(turnId: string, replyText: string) {
  const settled = await integration.settleInjectedTurn({
    sessionId: SESSION,
    turnId,
    status: "completed",
    tokens: 100,
    retracted: false,
    workSignals: { toolCalls: 0 },
    finalAssistantText: replyText,
  });
  turnTimings.finish(SESSION, turnId);
  return settled;
}

async function currentGoal(): Promise<ThreadGoalState> {
  const goal = await integration.store.getBySession(SESSION);
  if (!goal) throw new Error("expected the Goal to still exist");
  return goal;
}

describe("Goal consolidated MR cross-fix combination", () => {
  it("lets an explicit user Turn clear the no-tool streak and still re-arm the follow-up", async () => {
    // M1 owns the re-arm, M3 owns the no-tool counter, and the explicit reset
    // is the single write that has to do both. On either source branch alone
    // only half of this assertion could even be expressed.
    let goal = await seedRunningGoal();

    await admitGoalTurn(goal, "turn_goal_1");
    await settleToolLessGoalTurn("turn_goal_1", "still thinking about it");
    goal = await currentGoal();
    await admitGoalTurn(goal, "turn_goal_2");
    await settleToolLessGoalTurn("turn_goal_2", "still thinking about it");

    // One more tool-less Turn would pause the Goal on both conditions at once.
    const primed = await currentGoal();
    expect(primed).toMatchObject({
      noToolStreak: 2,
      noProgressStreak: 1,
      status: "active",
    });

    // Each Goal Turn above queued its own stage-10 follow-up, so measure the
    // re-arm as the delta this user Turn is responsible for.
    const enqueuedBeforeUserTurn =
      enqueuePostTurnContinuation.mock.calls.length;

    // The user intervenes. This single admission resets the breaker, advances
    // the epoch, and therefore owes the Goal a rebuilt follow-up.
    await admitUserTurn("turn_user");
    const afterReset = await currentGoal();
    expect(afterReset).toMatchObject({
      noToolStreak: 0,
      noProgressStreak: 0,
      replyFingerprint: null,
      status: "active",
    });

    await integration.settleInjectedTurn({
      sessionId: SESSION,
      turnId: "turn_user",
      status: "completed",
      tokens: 10,
      retracted: false,
    });
    turnTimings.finish(SESSION, "turn_user");

    // M1's half: the Goal did not lose its runner. Exactly one rebuilt
    // follow-up is attributable to the user Turn's reset.
    expect(enqueuePostTurnContinuation.mock.calls.length).toBe(
      enqueuedBeforeUserTurn + 1,
    );

    // M3's half: the next tool-less Turn restarts the streak at 1 instead of
    // completing an interrupted run of three and pausing.
    const rearmed = await currentGoal();
    await admitGoalTurn(rearmed, "turn_goal_3");
    await settleToolLessGoalTurn("turn_goal_3", "still thinking about it");
    expect(await currentGoal()).toMatchObject({
      noToolStreak: 1,
      status: "active",
    });
  });

  it("still pauses on three consecutive tool-less Turns once the user stops intervening", async () => {
    // The reset must interrupt the run, not disable the policy: the approved
    // threshold stays 3 and the outcome stays `paused`, never `complete`.
    let goal = await seedRunningGoal();
    for (const turnId of ["turn_a", "turn_b"]) {
      await admitGoalTurn(goal, turnId);
      await settleToolLessGoalTurn(turnId, `distinct reply ${turnId}`);
      goal = await currentGoal();
    }
    expect(goal).toMatchObject({ noToolStreak: 2, status: "active" });

    await admitGoalTurn(goal, "turn_c");
    await settleToolLessGoalTurn("turn_c", "distinct reply turn_c");

    const paused = await currentGoal();
    expect(paused).toMatchObject({ noToolStreak: 3, status: "paused" });
    expect(paused.status).not.toBe("completed");
  });

  it("keeps the breaker epoch advance from swallowing the re-arm a later user Turn installed", async () => {
    // M3 made stage 8 a writer, so a settling Turn now moves the epoch itself.
    // M1's generation guard is what stops that older settlement from clearing a
    // re-arm installed after it started.
    const goal = await seedRunningGoal();
    await admitGoalTurn(goal, "turn_goal");

    // The user's message lands while the Goal Turn is still in flight.
    await admitUserTurn("turn_user", false);

    // The Goal Turn is now stale, so it stops before stage 10 and schedules
    // nothing itself; only the drain can rebuild the follow-up.
    const stale = await integration.settleInjectedTurn({
      sessionId: SESSION,
      turnId: "turn_goal",
      status: "completed",
      tokens: 100,
      retracted: false,
      workSignals: { toolCalls: 0 },
      finalAssistantText: "superseded work",
    });
    expect(stale).toMatchObject({ action: "stale" });
    turnTimings.finish(SESSION, "turn_goal");

    // Exactly one follow-up, rebuilt at the current epoch so it admits cleanly.
    expect(enqueuePostTurnContinuation).toHaveBeenCalledOnce();
    const [submitted] = enqueuePostTurnContinuation.mock.calls[0] as [
      { readonly message: { readonly origin?: unknown } },
    ];
    const origin = submitted.message.origin as Record<string, unknown>;
    expect(origin).toMatchObject({
      goalUpdatedAt: (await currentGoal()).updatedAt,
    });
    await expect(
      integration.classifyQueuedItem({
        sessionId: SESSION,
        clientRequestId: "thread-goal-followup:turn_goal",
        message: { origin },
      }),
    ).resolves.toBe("ready");

    // The stale Turn's own settlement must not have counted toward the streak.
    expect(await currentGoal()).toMatchObject({
      noToolStreak: 0,
      status: "active",
    });
  });

  it("clears a live no-tool streak on a dependency wait before deferring the continuation", async () => {
    // M3 made the dependency wait a writer; M6 relies on the deferred item still
    // being enqueued afterwards so the Queue can retain it while user work
    // overtakes the blocked Goal.
    let goal = await seedRunningGoal();
    await admitGoalTurn(goal, "turn_1");
    await settleToolLessGoalTurn("turn_1", "no tools yet");
    goal = await currentGoal();
    expect(goal.noToolStreak).toBe(1);

    await admitGoalTurn(goal, "turn_2");
    // The dependency appears during the Turn, and that Turn really used tools.
    permissionPending = true;
    const deferred = await integration.settleInjectedTurn({
      sessionId: SESSION,
      turnId: "turn_2",
      status: "completed",
      tokens: 100,
      retracted: false,
      workSignals: { toolCalls: 2 },
    });
    turnTimings.finish(SESSION, "turn_2");

    // Stage 5 returned, and the real tool calls still interrupted the streak.
    expect(deferred).toMatchObject({ stage: 5 });
    const blocked = await currentGoal();
    expect(blocked).toMatchObject({ noToolStreak: 0, status: "active" });

    // The deferable continuation is still queued: that item is what M6 keeps.
    // turn_1 queued its own follow-up earlier, so this is the second call.
    expect(enqueuePostTurnContinuation).toHaveBeenCalledTimes(2);
  });

  it("does not let a verification wait disturb the breaker counters", async () => {
    // M2's wait projection is a visibility write that must not advance the
    // epoch, so it can neither score nor clear M3's counters.
    let goal = await seedRunningGoal();
    await admitGoalTurn(goal, "turn_1");
    await settleToolLessGoalTurn("turn_1", "no tools yet");
    goal = await currentGoal();
    const beforeWait = goal.updatedAt;
    expect(goal.noToolStreak).toBe(1);

    await integration.store.setExecutionWaitAtEpoch({
      goalId: goal.goalId,
      expectedUpdatedAt: beforeWait,
      reason: "verification",
    });
    const waiting = await currentGoal();
    expect(waiting).toMatchObject({ noToolStreak: 1, updatedAt: beforeWait });
    expect(waiting.executionWait?.reason).toBe("verification");

    await integration.store.clearExecutionWaitAtEpoch({
      goalId: goal.goalId,
      expectedUpdatedAt: beforeWait,
    });
    expect(await currentGoal()).toMatchObject({
      noToolStreak: 1,
      updatedAt: beforeWait,
    });
  });
});
