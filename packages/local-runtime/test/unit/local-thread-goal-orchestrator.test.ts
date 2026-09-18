/**
 * Tests for the Thread Goal continuation orchestrator.
 *
 * Mocks the `runOneTurn` callback and the `ThreadGoalStore` to verify:
 *   (a) active goal triggers continuation turns,
 *   (b) terminal status breaks the loop,
 *   (c) paused breaks the loop without marking blocked,
 *   (d) an unclassified legacy turn error pauses the goal as retryable,
 *   (e) safety retraction pauses the goal and short-circuits,
 *   (f) abort signal short-circuits.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ThreadGoalAlreadyExistsError,
  type ThreadGoalBreakerResult,
  type ThreadGoalCreateInput,
  type ThreadGoalPatchInput,
  type ThreadGoalState,
  type ThreadGoalStore,
} from "@mavis/goal";

import {
  createThreadGoalContinuationOrchestrator,
  type ThreadGoalTurnStatus,
} from "../../src/thread-goal/orchestrator.js";

class InMemoryThreadGoalStore implements ThreadGoalStore {
  private bySession = new Map<string, ThreadGoalState>();
  private byId = new Map<string, ThreadGoalState>();
  private seq = 0;
  public now = 1_700_000_000_000;

  async getBySession(sessionId: string): Promise<ThreadGoalState | undefined> {
    return this.bySession.get(sessionId);
  }
  async getById(goalId: string): Promise<ThreadGoalState | undefined> {
    return this.byId.get(goalId);
  }
  async create(input: ThreadGoalCreateInput): Promise<ThreadGoalState> {
    const existing = this.bySession.get(input.sessionId);
    // codex parity: only a complete goal is replaceable.
    if (existing && existing.status !== "complete") {
      throw new ThreadGoalAlreadyExistsError(existing.goalId);
    }
    if (existing) {
      this.byId.delete(existing.goalId);
    }
    this.seq += 1;
    const goal: ThreadGoalState = {
      goalId: `tg_${this.seq}`,
      sessionId: input.sessionId,
      objective: input.objective,
      status: "active",
      createdAt: this.now,
      updatedAt: this.now,
      tokensUsed: 0,
      turnsUsed: 0,
      timeUsedSeconds: 0,
      tokenBudget: input.tokenBudget ?? null,
      replyFingerprint: null,
      noProgressStreak: 0,
      noToolStreak: 0,
      lastVerification: undefined,
      statusReason: null,
      kickoffAttachments: (input.kickoffAttachments ?? []).map(
        (attachment) => ({
          ...attachment,
        }),
      ),
      kickoffState: "pending",
    };
    this.bySession.set(input.sessionId, goal);
    this.byId.set(goal.goalId, goal);
    return goal;
  }
  async patch(
    goalId: string,
    input: ThreadGoalPatchInput,
  ): Promise<ThreadGoalState> {
    const existing = this.byId.get(goalId);
    if (!existing) throw new Error(`goal ${goalId} not found`);
    this.now += 1;
    const next: ThreadGoalState = {
      ...existing,
      status: input.status ?? existing.status,
      objective: input.objective ?? existing.objective,
      statusReason:
        input.statusReason === undefined
          ? existing.statusReason
          : input.statusReason,
      updatedAt: this.now,
    };
    this.byId.set(goalId, next);
    this.bySession.set(existing.sessionId, next);
    return next;
  }
  async updateBreaker(): Promise<ThreadGoalBreakerResult> {
    return { action: "stale", staleReason: "missing_goal" };
  }
  async delete(goalId: string): Promise<void> {
    const existing = this.byId.get(goalId);
    if (!existing) return;
    this.byId.delete(goalId);
    this.bySession.delete(existing.sessionId);
  }
}

const SESSION_ID = "sess_orch_a";
let turnSeq = 0;
function nextTurn(): string {
  turnSeq += 1;
  return `turn_${turnSeq}`;
}

describe("ThreadGoalContinuationOrchestrator", () => {
  let store: InMemoryThreadGoalStore;
  beforeEach(() => {
    store = new InMemoryThreadGoalStore();
    turnSeq = 0;
  });

  it("runs exactly one turn when no goal exists", async () => {
    const runOneTurn = vi.fn(async () => "finished" as ThreadGoalTurnStatus);
    const orchestrator = createThreadGoalContinuationOrchestrator(store);
    const outcome = await orchestrator.run({
      sessionId: SESSION_ID,
      initialPromptText: "hello",
      initialTurnId: "turn_0",
      generateTurnId: nextTurn,
      runOneTurn,
    });
    expect(outcome).toEqual({
      outcome: "no-active-goal",
      turnsRun: 1,
      lastStatus: "finished",
    });
    expect(runOneTurn).toHaveBeenCalledTimes(1);
  });

  it("continues turns while the goal is active, then stops on complete", async () => {
    await store.create({ sessionId: SESSION_ID, objective: "x" });

    const runOneTurn = vi.fn(async (input) => {
      // On the SECOND turn the model "calls update_goal complete".
      if (input.turnId === "turn_1") {
        const g = await store.getBySession(SESSION_ID);
        if (g) await store.patch(g.goalId, { status: "complete" });
      }
      return "finished" as ThreadGoalTurnStatus;
    });

    const orchestrator = createThreadGoalContinuationOrchestrator(store);
    const outcome = await orchestrator.run({
      sessionId: SESSION_ID,
      initialPromptText: "kickoff",
      initialTurnId: "turn_0",
      generateTurnId: nextTurn,
      runOneTurn,
    });

    expect(outcome.outcome).toBe("goal-finalized");
    expect(runOneTurn).toHaveBeenCalledTimes(2);
    expect((outcome as { finalGoal: ThreadGoalState }).finalGoal.status).toBe(
      "complete",
    );

    // Turn #2 is a continuation — verify the prompt is the rendered template.
    const secondCall = runOneTurn.mock.calls[1][0];
    expect(secondCall.isContinuation).toBe(true);
    expect(secondCall.promptText).toContain(
      "Continue working toward the active thread goal",
    );
  });

  it("uses the provided renderContinuation override for continuation turns (objective edit pivot)", async () => {
    await store.create({ sessionId: SESSION_ID, objective: "x" });

    const runOneTurn = vi.fn(async (input) => {
      // Stop after the continuation turn so the loop is bounded.
      if (input.isContinuation) {
        const g = await store.getBySession(SESSION_ID);
        if (g) await store.patch(g.goalId, { status: "complete" });
      }
      return "finished" as ThreadGoalTurnStatus;
    });

    const orchestrator = createThreadGoalContinuationOrchestrator(
      store,
      undefined,
      (g) => `OBJECTIVE_UPDATED_PROMPT for ${g.objective}`,
    );
    await orchestrator.run({
      sessionId: SESSION_ID,
      initialPromptText: "kickoff",
      initialTurnId: "turn_0",
      generateTurnId: nextTurn,
      runOneTurn,
    });

    // The continuation turn used the override, not the default template.
    const secondCall = runOneTurn.mock.calls[1][0];
    expect(secondCall.isContinuation).toBe(true);
    expect(secondCall.promptText).toBe("OBJECTIVE_UPDATED_PROMPT for x");
  });

  it("stops when goal status flips to paused mid-loop (user paused)", async () => {
    const goal = await store.create({ sessionId: SESSION_ID, objective: "x" });

    const runOneTurn = vi.fn(async () => {
      // Simulate the user pausing via UI: store flips status, the
      // orchestrator notices on the next iteration.
      await store.patch(goal.goalId, { status: "paused" });
      return "finished" as ThreadGoalTurnStatus;
    });

    const orchestrator = createThreadGoalContinuationOrchestrator(store);
    const outcome = await orchestrator.run({
      sessionId: SESSION_ID,
      initialPromptText: "x",
      initialTurnId: "turn_0",
      generateTurnId: nextTurn,
      runOneTurn,
    });
    expect(outcome.outcome).toBe("goal-finalized");
    expect((outcome as { finalGoal: ThreadGoalState }).finalGoal.status).toBe(
      "paused",
    );
    expect(runOneTurn).toHaveBeenCalledTimes(1);
  });

  it("stops without blocking when the turn is waiting for the user", async () => {
    await store.create({ sessionId: SESSION_ID, objective: "x" });
    const runOneTurn = vi.fn(
      async () => "waiting_for_user" as ThreadGoalTurnStatus,
    );

    const orchestrator = createThreadGoalContinuationOrchestrator(store);
    const outcome = await orchestrator.run({
      sessionId: SESSION_ID,
      initialPromptText: "x",
      initialTurnId: "turn_0",
      generateTurnId: nextTurn,
      runOneTurn,
    });

    expect(outcome).toEqual({ outcome: "waiting-for-user", turnsRun: 1 });
    expect(runOneTurn).toHaveBeenCalledTimes(1);
    expect((await store.getBySession(SESSION_ID))?.status).toBe("active");
  });

  it("pauses and stops after one turn when output safety retracts the turn", async () => {
    const active = await store.create({
      sessionId: SESSION_ID,
      objective: "x",
    });
    const onTurnRetracted = vi.fn(async (sessionId: string) => {
      expect(sessionId).toBe(SESSION_ID);
      return store.patch(active.goalId, { status: "paused" });
    });
    const runOneTurn = vi.fn(async () => "retracted" as ThreadGoalTurnStatus);

    const orchestrator = createThreadGoalContinuationOrchestrator(
      store,
      undefined,
      undefined,
      onTurnRetracted,
    );
    const outcome = await orchestrator.run({
      sessionId: SESSION_ID,
      initialPromptText: "x",
      initialTurnId: "turn_0",
      generateTurnId: nextTurn,
      runOneTurn,
    });

    expect(outcome).toEqual({
      outcome: "turn-retracted",
      turnsRun: 1,
      finalGoal: expect.objectContaining({ status: "paused" }),
    });
    expect(runOneTurn).toHaveBeenCalledTimes(1);
    expect(onTurnRetracted).toHaveBeenCalledTimes(1);
    expect((await store.getBySession(SESSION_ID))?.status).toBe("paused");
  });

  it("pauses the goal as retryable when the legacy loop sees an unclassified error", async () => {
    await store.create({ sessionId: SESSION_ID, objective: "x" });
    const runOneTurn = vi.fn(async () => "error" as ThreadGoalTurnStatus);

    const orchestrator = createThreadGoalContinuationOrchestrator(store);
    const outcome = await orchestrator.run({
      sessionId: SESSION_ID,
      initialPromptText: "x",
      initialTurnId: "turn_0",
      generateTurnId: nextTurn,
      runOneTurn,
    });
    expect(outcome.outcome).toBe("turn-errored");
    const goal = await store.getBySession(SESSION_ID);
    expect(goal).toMatchObject({
      status: "paused",
      statusReason: "paused(infra_retryable)",
    });
  });

  it("does NOT block when the abort signal fires after a clean turn (codex on_turn_abort)", async () => {
    const goal = await store.create({ sessionId: SESSION_ID, objective: "x" });

    const abort = new AbortController();
    const runOneTurn = vi.fn(async () => {
      // Trip the abort signal during the first turn; the orchestrator
      // should detect it before scheduling a continuation.
      abort.abort();
      return "finished" as ThreadGoalTurnStatus;
    });

    const orchestrator = createThreadGoalContinuationOrchestrator(store);
    const outcome = await orchestrator.run({
      sessionId: SESSION_ID,
      initialPromptText: "x",
      initialTurnId: "turn_0",
      generateTurnId: nextTurn,
      runOneTurn,
      signal: abort.signal,
    });
    expect(outcome.outcome).toBe("aborted");
    expect(runOneTurn).toHaveBeenCalledTimes(1);
    const after = await store.getBySession(SESSION_ID);
    // codex parity: an abort accounts progress but never blocks — the goal
    // stays active for the next kick / objective-edit restart.
    expect(after?.status).toBe("active");
    expect(after?.goalId).toBe(goal.goalId);
  });

  it("does NOT block the goal when a turn returns aborted (user cancel or objective-edit restart)", async () => {
    await store.create({ sessionId: SESSION_ID, objective: "x" });
    const runOneTurn = vi.fn(async () => "aborted" as ThreadGoalTurnStatus);

    const orchestrator = createThreadGoalContinuationOrchestrator(store);
    const outcome = await orchestrator.run({
      sessionId: SESSION_ID,
      initialPromptText: "x",
      initialTurnId: "turn_0",
      generateTurnId: nextTurn,
      runOneTurn,
    });
    expect(outcome.outcome).toBe("aborted");
    // Stays active — this is the regression fix: editing an objective aborts
    // the turn to restart, and that must NOT leave the goal stuck on blocked.
    expect((await store.getBySession(SESSION_ID))?.status).toBe("active");
  });

  it("does not loop when goal status is already terminal at turn #1", async () => {
    const goal = await store.create({ sessionId: SESSION_ID, objective: "x" });
    await store.patch(goal.goalId, { status: "complete" });
    const runOneTurn = vi.fn(async () => "finished" as ThreadGoalTurnStatus);

    const orchestrator = createThreadGoalContinuationOrchestrator(store);
    const outcome = await orchestrator.run({
      sessionId: SESSION_ID,
      initialPromptText: "x",
      initialTurnId: "turn_0",
      generateTurnId: nextTurn,
      runOneTurn,
    });
    expect(outcome.outcome).toBe("goal-finalized");
    expect(runOneTurn).toHaveBeenCalledTimes(1);
  });
});
