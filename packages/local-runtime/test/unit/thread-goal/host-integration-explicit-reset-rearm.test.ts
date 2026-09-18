import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { digestThreadGoalObjective, type ThreadGoalState } from "@mavis/goal";

import { closeLocalRuntimeDb } from "../../../src/persistence/db.js";
import { LocalThreadGoalIntegration } from "../../../src/thread-goal/host-integration.js";
import { LocalActiveTurnTimingRegistry } from "../../../src/turns/active-turn-timing.js";

/**
 * Every explicit user Turn commits a breaker reset, and that reset advances the
 * Goal decision epoch. Like a user PATCH, one write invalidates every runner the
 * Goal had at once:
 *
 *   1. the running bound Turn's binding, so its settlement stops at the stale
 *      stage and never reaches stage 10,
 *   2. the post-turn continuation already queued at the old epoch
 *      (`classifyQueuedItem` -> 'cancel'), and
 *   3. any verifier verdict still in flight, whose write-back CAS now misses.
 *
 * Unlike PATCH, nothing downstream of the reset even observes it: it is a bare
 * store write that publishes an SSE `updated` event, not the internal lifecycle
 * event `maybeKick` listens on. Before this fix an `active` Goal was therefore
 * left with no source of further execution the moment its user typed anything,
 * which is what stranded the reported sessions.
 *
 * These tests drive the real SQLite store so the epoch bump, the staleness
 * predicate and the queue classification are the production ones, and they pin
 * who owns the follow-up in each way a user Turn can end: it settles normally,
 * it never starts at all, its Goal is no longer continuable, or a second writer
 * races the drain.
 */

const NOW = 1_700_000_000_000;
const SESSION = "sess_explicit_reset_rearm";
const OBJECTIVE = "Ship the release train";

let dataDir: string;
let integration: LocalThreadGoalIntegration;
let turnTimings: LocalActiveTurnTimingRegistry;
let enqueuePostTurnContinuation: ReturnType<typeof vi.fn>;
let enqueueInitialContinuationTurn: ReturnType<typeof vi.fn>;
let cancelInitialContinuation: ReturnType<typeof vi.fn>;
let hasPendingInitialContinuation: ReturnType<typeof vi.fn>;
let startContinuationTurn: ReturnType<typeof vi.fn>;
let reportFailure: ReturnType<typeof vi.fn>;
/** Mirrors the Queue's own view of the pending kickoff item. */
let kickoffQueued: boolean;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "goal-explicit-reset-rearm-"));
  turnTimings = new LocalActiveTurnTimingRegistry(() => NOW);
  kickoffQueued = false;
  enqueuePostTurnContinuation = vi.fn(async () => undefined);
  enqueueInitialContinuationTurn = vi.fn(async () => {
    kickoffQueued = true;
  });
  cancelInitialContinuation = vi.fn(async () => {
    kickoffQueued = false;
  });
  hasPendingInitialContinuation = vi.fn(async () => kickoffQueued);
  startContinuationTurn = vi.fn(async () => undefined);
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
    hasPendingPermission: async () => false,
    hasAutomationOwnerConflict: async () => false,
    hasRequiredBackgroundWork: async () => false,
    startContinuationTurn,
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

/** Create an active Goal whose kickoff has already been delivered. */
async function seedRunningGoal(): Promise<ThreadGoalState> {
  const created = await integration.createGoal({
    sessionId: SESSION,
    objective: OBJECTIVE,
  });
  const enqueued = await integration.store.getBySession(SESSION);
  if (!enqueued) throw new Error("expected the seeded Goal to persist");
  await integration.store.transitionKickoffState(
    created.goalId,
    enqueued.kickoffState,
    "consumed",
  );
  const goal = await integration.store.getBySession(SESSION);
  if (goal?.kickoffState !== "consumed") {
    throw new Error(
      `expected a kickoff-consumed Goal, got ${goal?.kickoffState}`,
    );
  }
  // The kickoff was delivered, so the Queue no longer holds its item.
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

/** Bind and start a Goal continuation Turn, making the session busy. */
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

type ReadyPreparation = Extract<
  Awaited<ReturnType<LocalThreadGoalIntegration["prepareTurnAdmission"]>>,
  { readonly status: "ready" }
>;

/**
 * Admit an explicit user Turn exactly the way TurnSystem does, and hand the
 * preparation back so a test can choose between `commit`-then-settle and the
 * `commit`-then-`compensate` path a failed Turn start takes.
 */
async function prepareUserTurn(
  turnId: string,
  source = "api",
): Promise<ReadyPreparation | undefined> {
  const prepared = await integration.prepareTurnAdmission({
    sessionId: SESSION,
    turnId,
    provenance: { source },
    hasPendingPlan: async () => false,
    hasPriorityMailboxWork: async () => false,
  });
  if (prepared !== undefined && prepared.status !== "ready") {
    throw new Error(
      `expected a ready user admission, got ${JSON.stringify(prepared)}`,
    );
  }
  return prepared;
}

async function admitUserTurn(
  turnId: string,
  source = "api",
): Promise<ReadyPreparation> {
  const prepared = await prepareUserTurn(turnId, source);
  if (!prepared)
    throw new Error("expected the breaker reset preparation to be present");
  turnTimings.begin(SESSION, turnId);
  await prepared.commit();
  return prepared;
}

function settleInput(turnId: string) {
  return {
    sessionId: SESSION,
    turnId,
    status: "completed" as const,
    tokens: 1_200,
    retracted: false,
  };
}

/** The re-armed follow-up, as it was handed to the Queue transport. */
function enqueuedOrigin(call = 0): Record<string, unknown> {
  const [submitted] = enqueuePostTurnContinuation.mock.calls[call] as [
    { readonly message: { readonly origin?: unknown } },
  ];
  return submitted.message.origin as Record<string, unknown>;
}

describe("LocalThreadGoalIntegration explicit-reset continuation re-arm", () => {
  it("re-arms the follow-up a user message stole from a running Goal Turn", async () => {
    const goal = await seedRunningGoal();
    await admitGoalTurn(goal, "turn_goal");

    // The verifier shape: the Goal Turn is still in flight — or already inside
    // settlement, awaiting a verdict — when the user's message is admitted.
    const prepared = await prepareUserTurn("turn_user");
    if (!prepared)
      throw new Error("expected the breaker reset preparation to be present");
    await prepared.commit();

    // The epoch moved, so the Goal Turn is stale: its settlement stops before
    // stage 10 and continues nothing on its own. The drain is what saves it.
    const stale = await integration.settleInjectedTurn(
      settleInput("turn_goal"),
    );
    expect(stale).toMatchObject({ action: "stale" });
    expect(enqueuePostTurnContinuation).toHaveBeenCalledOnce();

    const current = await integration.store.getBySession(SESSION);
    if (!current) throw new Error("expected the Goal to survive the user Turn");
    // Rebuilt from durable state at the *current* epoch, so it admits cleanly.
    expect(enqueuedOrigin()).toMatchObject({
      type: "thread-goal-continuation",
      goalId: goal.goalId,
      goalUpdatedAt: current.updatedAt,
      kind: "active",
    });
    await expect(
      integration.classifyQueuedItem({
        sessionId: SESSION,
        clientRequestId: "thread-goal-followup:turn_goal",
        message: { origin: enqueuedOrigin() },
      }),
    ).resolves.toBe("ready");

    // The user Turn settling afterwards must not add a second follow-up.
    turnTimings.finish(SESSION, "turn_goal");
    await integration.settleInjectedTurn(settleInput("turn_user"));
    expect(enqueuePostTurnContinuation).toHaveBeenCalledOnce();
  });

  it("re-arms from the user Turn when the stale Goal Turn settles last", async () => {
    // The other interleaving: the user Turn reaches settlement first, so it is
    // the owner, and the late stale settlement must stay a no-op.
    const goal = await seedRunningGoal();
    await admitGoalTurn(goal, "turn_goal");
    turnTimings.finish(SESSION, "turn_goal");
    await admitUserTurn("turn_user");

    turnTimings.finish(SESSION, "turn_user");
    await integration.settleInjectedTurn(settleInput("turn_user"));
    expect(enqueuePostTurnContinuation).toHaveBeenCalledOnce();
    expect(enqueuedOrigin()).toMatchObject({
      goalId: goal.goalId,
      kind: "active",
    });

    await integration.settleInjectedTurn(settleInput("turn_goal"));
    expect(enqueuePostTurnContinuation).toHaveBeenCalledOnce();
  });

  it("rebuilds the follow-up from compensate when the user Turn never starts", async () => {
    // `commit` landed, so the epoch already moved, but TurnSystem failed to start
    // the Turn. No settlement will ever come, so compensate is the only owner.
    const goal = await seedRunningGoal();
    await admitGoalTurn(goal, "turn_goal");
    turnTimings.finish(SESSION, "turn_goal");

    const prepared = await prepareUserTurn("turn_user");
    if (!prepared)
      throw new Error("expected the breaker reset preparation to be present");
    await prepared.commit();
    await prepared.compensate?.();

    expect(enqueuePostTurnContinuation).toHaveBeenCalledOnce();
    expect(enqueuedOrigin()).toMatchObject({
      goalId: goal.goalId,
      kind: "active",
    });

    // And the marker is spent: a late settlement of the same Turn adds nothing.
    await integration.settleInjectedTurn(settleInput("turn_user"));
    expect(enqueuePostTurnContinuation).toHaveBeenCalledOnce();
  });

  it("rebuilds an unconsumed kickoff as a kickoff, not as an active continuation", async () => {
    // The queued kickoff carries the one-shot attachment snapshot, so an epoch
    // advance that strands it has to be repaired by re-issuing the kickoff.
    await integration.createGoal({ sessionId: SESSION, objective: OBJECTIVE });
    const goal = await integration.store.getBySession(SESSION);
    if (!goal) throw new Error("expected the seeded Goal to persist");
    expect(goal.kickoffState).not.toBe("consumed");
    expect(kickoffQueued).toBe(true);
    enqueueInitialContinuationTurn.mockClear();

    await admitUserTurn("turn_user");
    turnTimings.finish(SESSION, "turn_user");
    await integration.settleInjectedTurn(settleInput("turn_user"));

    expect(cancelInitialContinuation).toHaveBeenCalled();
    expect(enqueueInitialContinuationTurn).toHaveBeenCalledOnce();
    const [, message] = enqueueInitialContinuationTurn.mock.calls[0] as [
      string,
      { readonly origin?: Record<string, unknown> },
    ];
    expect(message.origin).toMatchObject({
      type: "thread-goal-kickoff",
      goalId: goal.goalId,
    });
    // The kickoff owns execution; no duplicate `active` continuation.
    expect(enqueuePostTurnContinuation).not.toHaveBeenCalled();
  });

  it("keeps the kickoff delivery responsibility when the rewrite fails mid-way", async () => {
    /*
     * The rewrite cancels the queued kickoff and then re-enqueues it. If the
     * re-enqueue fails, the old item is already gone while the kickoff — and
     * the one-shot attachment snapshot it carries — has never run. Two things
     * used to go wrong at once: the failure was swallowed, so the drain dropped
     * the marker, and the next reconcile read `enqueued` with an empty Queue as
     * "already delivered" and consumed it. The input was then never delivered.
     */
    await integration.createGoal({ sessionId: SESSION, objective: OBJECTIVE });
    const seeded = await integration.store.getBySession(SESSION);
    if (!seeded) throw new Error("expected the seeded Goal to persist");
    expect(seeded.kickoffState).not.toBe("consumed");
    enqueueInitialContinuationTurn.mockClear();

    await admitUserTurn("turn_user");
    turnTimings.finish(SESSION, "turn_user");

    // The cancel lands, the first re-enqueue does not.
    enqueueInitialContinuationTurn.mockRejectedValueOnce(
      new Error("queue unavailable"),
    );
    await expect(
      integration.settleInjectedTurn(settleInput("turn_user")),
    ).rejects.toThrow("queue unavailable");
    expect(cancelInitialContinuation).toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith(
      SESSION,
      expect.stringContaining("thread_goal_kickoff_refresh_failed"),
    );

    // The undelivered kickoff must not be inferred as consumed just because the
    // Queue no longer holds it.
    const stranded = await integration.store.getBySession(SESSION);
    expect(stranded?.kickoffState).not.toBe("consumed");
    expect(kickoffQueued).toBe(false);

    // The retry re-delivers the original kickoff, attachments and all.
    await integration.settleInjectedTurn(settleInput("turn_user"));
    expect(enqueueInitialContinuationTurn).toHaveBeenCalledTimes(2);
    const [, redelivered] = enqueueInitialContinuationTurn.mock.calls[1] as [
      string,
      {
        readonly origin?: Record<string, unknown>;
        readonly attachments?: readonly unknown[];
      },
    ];
    expect(redelivered.origin).toMatchObject({
      type: "thread-goal-kickoff",
      goalId: seeded.goalId,
    });
    expect(kickoffQueued).toBe(true);
    const recovered = await integration.store.getBySession(SESSION);
    expect(recovered?.kickoffState).not.toBe("consumed");
  });

  it("still consumes a kickoff that was genuinely delivered and drained", async () => {
    // The guard above must not keep a normally delivered kickoff alive forever:
    // an `enqueued` Goal whose item left the Queue by being executed is still
    // consumed, exactly as before.
    await integration.createGoal({ sessionId: SESSION, objective: OBJECTIVE });
    const seeded = await integration.store.getBySession(SESSION);
    if (!seeded) throw new Error("expected the seeded Goal to persist");
    // The Queue delivered it: the item is gone and no rewrite is outstanding.
    kickoffQueued = false;

    await integration.recoverInitialContinuation(seeded);
    const current = await integration.store.getBySession(SESSION);
    expect(current?.kickoffState).toBe("consumed");
  });

  it("does not re-arm a Goal the user paused in the same Turn", async () => {
    const goal = await seedRunningGoal();
    await admitGoalTurn(goal, "turn_goal");
    turnTimings.finish(SESSION, "turn_goal");
    await admitUserTurn("turn_user");

    await integration.patchGoal(SESSION, { status: "paused" });
    turnTimings.finish(SESSION, "turn_user");
    await integration.settleInjectedTurn(settleInput("turn_user"));

    expect(enqueuePostTurnContinuation).not.toHaveBeenCalled();
    expect(startContinuationTurn).not.toHaveBeenCalled();
  });

  it("prepares nothing when the session has no active Goal", async () => {
    await expect(prepareUserTurn("turn_user")).resolves.toBeUndefined();

    await integration.settleInjectedTurn(settleInput("turn_user"));
    expect(enqueuePostTurnContinuation).not.toHaveBeenCalled();
  });

  it("does not re-arm when the reset CAS lost to a concurrent epoch advance", async () => {
    const goal = await seedRunningGoal();
    const prepared = await prepareUserTurn("turn_user");
    if (!prepared)
      throw new Error("expected the breaker reset preparation to be present");

    // Another writer advances the epoch between preparation and commit, so the
    // reset CAS misses and this preparation never owned a follow-up. The PATCH
    // path that won the race owns it instead.
    await integration.patchGoal(SESSION, { tokenBudget: 400_000 });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    enqueuePostTurnContinuation.mockClear();
    startContinuationTurn.mockClear();

    await prepared.commit();
    const afterCommit = await integration.store.getBySession(SESSION);
    expect(afterCommit?.goalId).toBe(goal.goalId);

    await integration.settleInjectedTurn(settleInput("turn_user"));
    expect(enqueuePostTurnContinuation).not.toHaveBeenCalled();
  });

  it("stays armed when the Queue rejects the rebuilt follow-up", async () => {
    const goal = await seedRunningGoal();
    await admitGoalTurn(goal, "turn_goal");
    turnTimings.finish(SESSION, "turn_goal");
    await admitUserTurn("turn_user");
    turnTimings.finish(SESSION, "turn_user");

    enqueuePostTurnContinuation.mockRejectedValueOnce(
      new Error("queue closed"),
    );
    await expect(
      integration.settleInjectedTurn(settleInput("turn_user")),
    ).rejects.toThrow("queue closed");
    expect(reportFailure).toHaveBeenCalledWith(
      SESSION,
      expect.stringContaining("thread_goal_continuation_enqueue_failed"),
    );

    // The settle retry finds the marker still armed and rebuilds the follow-up.
    await integration.settleInjectedTurn(settleInput("turn_user"));
    expect(enqueuePostTurnContinuation).toHaveBeenCalledTimes(2);
    expect(enqueuedOrigin(1)).toMatchObject({
      goalId: goal.goalId,
      kind: "active",
    });
  });

  it("does not let a failed drain overwrite a newer epoch writer", async () => {
    // The failing drain must not restore its own (now older) claim on top of the
    // arm a later writer installed while the enqueue was in flight, or the newer
    // epoch's follow-up would be silently rebuilt from the wrong Goal.
    const first = await seedRunningGoal();
    await admitUserTurn("turn_user");
    turnTimings.finish(SESSION, "turn_user");

    let recreated: ThreadGoalState | undefined;
    enqueuePostTurnContinuation.mockImplementationOnce(async () => {
      await integration.deleteGoal(SESSION);
      recreated = await integration.createGoal({
        sessionId: SESSION,
        objective: "A new goal",
      });
      const seeded = await integration.store.getBySession(SESSION);
      if (!seeded) throw new Error("expected the recreated Goal to persist");
      await integration.store.transitionKickoffState(
        recreated.goalId,
        seeded.kickoffState,
        "consumed",
      );
      await integration
        .prepareTurnAdmission({
          sessionId: SESSION,
          turnId: "turn_user_2",
          provenance: { source: "api" },
          hasPendingPlan: async () => false,
          hasPriorityMailboxWork: async () => false,
        })
        .then((prepared) =>
          prepared?.status === "ready" ? prepared.commit() : undefined,
        );
      throw new Error("queue closed");
    });

    await expect(
      integration.settleInjectedTurn(settleInput("turn_user")),
    ).rejects.toThrow("queue closed");

    // The next settlement must rebuild the *recreated* Goal's follow-up.
    await integration.settleInjectedTurn(settleInput("turn_user_2"));
    expect(enqueuePostTurnContinuation).toHaveBeenCalledTimes(2);
    expect(recreated?.goalId).not.toBe(first.goalId);
    expect(enqueuedOrigin(1)).toMatchObject({
      goalId: recreated?.goalId,
      kind: "active",
    });
  });

  it("re-arms for channel-sourced user Turns too", async () => {
    const goal = await seedRunningGoal();
    await admitUserTurn("turn_channel", "channel:lark");
    turnTimings.finish(SESSION, "turn_channel");
    await integration.settleInjectedTurn(settleInput("turn_channel"));

    expect(enqueuePostTurnContinuation).toHaveBeenCalledOnce();
    expect(enqueuedOrigin()).toMatchObject({
      goalId: goal.goalId,
      kind: "active",
    });
  });

  it("rebuilds under an epoch-scoped key so the Queue cannot fold it onto the stale row", async () => {
    /*
     * The rebuild carries the settling Turn's id, and the Host's default
     * follow-up key is derived from exactly that id. Reusing it makes the Queue
     * replay onto the row that belongs to the epoch just invalidated, which
     * final recheck then cancels for being stale — so the Goal stops even though
     * the marker did its job. The rebuild has to name the epoch it is rebuilt at.
     */
    const goal = await seedRunningGoal();
    await admitGoalTurn(goal, "turn_goal");

    enqueuePostTurnContinuation.mockImplementationOnce(async () => {
      const prepared = await prepareUserTurn("turn_user");
      if (!prepared)
        throw new Error("expected the breaker reset preparation to be present");
      await prepared.commit();
    });

    await integration.settleInjectedTurn(settleInput("turn_goal"));
    expect(enqueuePostTurnContinuation).toHaveBeenCalledTimes(2);

    const staleSubmission = enqueuePostTurnContinuation.mock.calls[0]?.[0] as {
      readonly clientRequestId?: string;
    };
    const rebuiltSubmission = enqueuePostTurnContinuation.mock
      .calls[1]?.[0] as {
      readonly clientRequestId?: string;
    };
    const current = await integration.store.getBySession(SESSION);
    if (!current) throw new Error("expected the Goal to survive the user Turn");

    // Stage 10 keeps the default per-Turn key, which the Host derives from the
    // settling turnId; the rebuild must not reuse it.
    expect(staleSubmission.clientRequestId).toBeUndefined();
    expect(rebuiltSubmission.clientRequestId).toBe(
      `thread-goal-followup:rearm:${goal.goalId}:${current.updatedAt}`,
    );
    expect(rebuiltSubmission.clientRequestId).not.toBe(
      "thread-goal-followup:turn_goal",
    );
  });

  it("reuses one key when the same epoch rebuild is retried", async () => {
    // Retrying the same rebuild must stay idempotent: at-least-once delivery is
    // the contract, but it may not cost a second admissible row per attempt.
    const goal = await seedRunningGoal();
    await admitGoalTurn(goal, "turn_goal");
    await admitUserTurn("turn_user");
    turnTimings.finish(SESSION, "turn_goal");

    enqueuePostTurnContinuation.mockRejectedValueOnce(
      new Error("queue unavailable"),
    );
    await expect(
      integration.settleInjectedTurn(settleInput("turn_user")),
    ).rejects.toThrow("queue unavailable");
    await integration.settleInjectedTurn(settleInput("turn_user"));

    const keys = enqueuePostTurnContinuation.mock.calls.map(
      (call) =>
        (call[0] as { readonly clientRequestId?: string }).clientRequestId,
    );
    const current = await integration.store.getBySession(SESSION);
    if (!current) throw new Error("expected the Goal to survive");
    const expected = `thread-goal-followup:rearm:${goal.goalId}:${current.updatedAt}`;
    expect(keys.filter((key) => key !== undefined)).toEqual([
      expected,
      expected,
    ]);
  });

  it("does not let an old-epoch stage 10 submission swallow a newer arm", async () => {
    // Scheduling a follow-up is asynchronous: the Goal is read and a prompt is
    // built before the Queue submission lands. A user message admitted inside
    // that window resets the breaker and arms for the new epoch, while the item
    // this settlement is handing over still carries the old one and will be
    // cancelled by final recheck. Clearing the marker unconditionally afterwards
    // would leave the Goal with no runner at all — the exact bug this suite
    // exists for, reintroduced through the back door.
    const goal = await seedRunningGoal();
    await admitGoalTurn(goal, "turn_goal");

    enqueuePostTurnContinuation.mockImplementationOnce(async () => {
      const prepared = await prepareUserTurn("turn_user");
      if (!prepared)
        throw new Error("expected the breaker reset preparation to be present");
      await prepared.commit();
    });

    // Stage 10 continues normally and submits the (now old-epoch) follow-up,
    // then the same settlement's tail drain finds the surviving marker and
    // rebuilds a second follow-up at the current epoch.
    const decision = await integration.settleInjectedTurn(
      settleInput("turn_goal"),
    );
    expect(decision).toMatchObject({ stage: 10, action: "continued" });
    expect(enqueuePostTurnContinuation).toHaveBeenCalledTimes(2);

    // The old-epoch item is the one final recheck throws away...
    await expect(
      integration.classifyQueuedItem({
        sessionId: SESSION,
        clientRequestId: "thread-goal-followup:turn_goal",
        message: { origin: enqueuedOrigin(0) },
      }),
    ).resolves.toBe("cancel");

    // ...and the rebuilt one is what actually keeps the Goal running. Without
    // the generation guard the marker would have been deleted here and only the
    // cancelled item would exist.
    const current = await integration.store.getBySession(SESSION);
    expect(enqueuedOrigin(1)).toMatchObject({
      goalId: goal.goalId,
      goalUpdatedAt: current?.updatedAt,
      kind: "active",
    });
    await expect(
      integration.classifyQueuedItem({
        sessionId: SESSION,
        clientRequestId: "thread-goal-followup:turn_goal",
        message: { origin: enqueuedOrigin(1) },
      }),
    ).resolves.toBe("ready");

    // The debt is settled: the user Turn adds no third item.
    turnTimings.finish(SESSION, "turn_goal");
    await integration.settleInjectedTurn(settleInput("turn_user"));
    expect(enqueuePostTurnContinuation).toHaveBeenCalledTimes(2);
  });
});
