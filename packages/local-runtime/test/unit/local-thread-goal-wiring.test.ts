/**
 * Unit tests for the Thread Goal wiring helpers — SSE bus projection +
 * the codex `continue_if_idle` kick.
 *
 * Pins:
 * (a) external set-active on an idle session starts a hidden
 *     continuation turn with the rendered append-only prompt,
 * (b) a busy session is never double-driven (the in-stream
 *     orchestrator owns continuation mid-turn),
 * (c) non-active results and deletes never kick,
 * (d) kick failures are swallowed (busy-lock races are benign),
 * (e) handleThreadGoalChanged projects the bus event for every
 *     mutation type and only kicks on active.
 */

import { describe, expect, it, vi } from "vitest";

import type { ThreadGoalState } from "@mavis/goal";

import {
  buildThreadGoalRuntimeTools,
  handleThreadGoalChanged,
  maybeKickThreadGoalContinuation,
} from "../../src/thread-goal/wiring.js";

function goal(overrides: Partial<ThreadGoalState> = {}): ThreadGoalState {
  return {
    goalId: "tg_wiring_1",
    sessionId: "sess_wiring",
    objective: "Ship the wiring tests",
    status: "active",
    createdAt: 1_700_000_000_000,
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

describe("maybeKickThreadGoalContinuation", () => {
  it("starts a continuation turn when the session is idle and the goal is active", async () => {
    const startContinuationTurn = vi.fn(async () => undefined);
    await maybeKickThreadGoalContinuation(
      { type: "updated", goal: goal() },
      { isSessionBusy: () => false, startContinuationTurn },
    );
    expect(startContinuationTurn).toHaveBeenCalledTimes(1);
    const [sessionId, content] = startContinuationTurn.mock.calls[0] as [
      string,
      string,
    ];
    expect(sessionId).toBe("sess_wiring");
    expect(content).toContain("Continue working toward the active thread goal");
    expect(content).not.toContain("Ship the wiring tests");
    expect(content).not.toContain("<objective>");
  });

  it("kicks on created events too (POST /goal while idle = start working)", async () => {
    const startContinuationTurn = vi.fn(async () => undefined);
    await maybeKickThreadGoalContinuation(
      { type: "created", goal: goal() },
      { isSessionBusy: () => false, startContinuationTurn },
    );
    expect(startContinuationTurn).toHaveBeenCalledTimes(1);
    const [, content] = startContinuationTurn.mock.calls[0] as [string, string];
    expect(content).toContain(
      "<objective>\nShip the wiring tests\n</objective>",
    );
    expect(content).toContain("Completion audit:");
  });

  it("does not kick while the session has a running turn", async () => {
    const startContinuationTurn = vi.fn(async () => undefined);
    await maybeKickThreadGoalContinuation(
      { type: "updated", goal: goal() },
      { isSessionBusy: () => true, startContinuationTurn },
    );
    expect(startContinuationTurn).not.toHaveBeenCalled();
  });

  it.each([
    "paused",
    "blocked",
    "complete",
    "budget_limited",
    "usage_limited",
  ] as const)(
    "does not kick when the resulting status is %s",
    async (status) => {
      const startContinuationTurn = vi.fn(async () => undefined);
      await maybeKickThreadGoalContinuation(
        { type: "updated", goal: goal({ status }) },
        { isSessionBusy: () => false, startContinuationTurn },
      );
      expect(startContinuationTurn).not.toHaveBeenCalled();
    },
  );

  it("does not kick on delete events", async () => {
    const startContinuationTurn = vi.fn(async () => undefined);
    await maybeKickThreadGoalContinuation(
      { type: "deleted", goalId: "tg_wiring_1", sessionId: "sess_wiring" },
      { isSessionBusy: () => false, startContinuationTurn },
    );
    expect(startContinuationTurn).not.toHaveBeenCalled();
  });

  it("swallows turn-start failures (busy-lock race is benign)", async () => {
    const startContinuationTurn = vi.fn(async () => {
      throw new Error("local_session_busy");
    });
    await expect(
      maybeKickThreadGoalContinuation(
        { type: "updated", goal: goal() },
        { isSessionBusy: () => false, startContinuationTurn },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("handleThreadGoalChanged", () => {
  it("emits thread_goal.updated and kicks for an active mutation", async () => {
    const emitBusEvent = vi.fn();
    const startContinuationTurn = vi.fn(async () => undefined);
    handleThreadGoalChanged(
      { type: "updated", goal: goal() },
      {
        publishGlobalEvent: emitBusEvent,
        isSessionBusy: () => false,
        startContinuationTurn,
      },
    );
    expect(emitBusEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread_goal.updated",
        payload: expect.objectContaining({
          goal: expect.objectContaining({
            goalId: "tg_wiring_1",
            status: "active",
          }),
        }),
      }),
    );
    await vi.waitFor(() =>
      expect(startContinuationTurn).toHaveBeenCalledTimes(1),
    );
  });

  it("emits thread_goal.cleared and never kicks for deletes", () => {
    const emitBusEvent = vi.fn();
    const startContinuationTurn = vi.fn(async () => undefined);
    handleThreadGoalChanged(
      { type: "deleted", goalId: "tg_wiring_1", sessionId: "sess_wiring" },
      {
        publishGlobalEvent: emitBusEvent,
        isSessionBusy: () => false,
        startContinuationTurn,
      },
    );
    expect(emitBusEvent).toHaveBeenCalledWith({
      type: "thread_goal.cleared",
      payload: { goalId: "tg_wiring_1", sessionId: "sess_wiring" },
    });
    expect(startContinuationTurn).not.toHaveBeenCalled();
  });

  it("emits the bus event but does not kick for a paused mutation", () => {
    const emitBusEvent = vi.fn();
    const startContinuationTurn = vi.fn(async () => undefined);
    handleThreadGoalChanged(
      { type: "updated", goal: goal({ status: "paused" }) },
      {
        publishGlobalEvent: emitBusEvent,
        isSessionBusy: () => false,
        startContinuationTurn,
      },
    );
    expect(emitBusEvent).toHaveBeenCalledTimes(1);
    expect(startContinuationTurn).not.toHaveBeenCalled();
  });

  it("projects usage, reason, and verifier summary onto thread_goal.updated", () => {
    // MR-1 accounting parity: SSE payload must carry tokensUsed +
    // timeUsedSeconds + (MR-2) tokenBudget so the banner can render
    // `(12.5K / 50K)` or `(12.5K · 2m)` without a manual REST refresh.
    const emitBusEvent = vi.fn();
    const startContinuationTurn = vi.fn(async () => undefined);
    handleThreadGoalChanged(
      {
        type: "updated",
        goal: goal({
          status: "paused",
          tokensUsed: 12_500,
          turnsUsed: 4,
          timeUsedSeconds: 137,
          tokenBudget: 50_000,
          statusReason: "paused(no_progress)",
          lastVerification: {
            v: 1,
            backend: "evaluator",
            verdict: "not_met",
            reason: "Missing tests",
            missing: ["focused tests"],
            notMetStreak: 2,
            turnId: "turn_1",
            objectiveDigest: "digest",
            at: 1_700_000_000_000,
          },
          lastWorkerProposal: {
            v: 1,
            source: "worker",
            type: "blocked",
            turnId: "turn_1",
            summary: "private blocker detail",
            at: 1_700_000_000_001,
          },
        }),
      },
      {
        publishGlobalEvent: emitBusEvent,
        isSessionBusy: () => false,
        startContinuationTurn,
      },
    );
    expect(emitBusEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread_goal.updated",
        payload: expect.objectContaining({
          goal: expect.objectContaining({
            tokensUsed: 12_500,
            turnsUsed: 4,
            timeUsedSeconds: 137,
            tokenBudget: 50_000,
            statusReason: "paused(no_progress)",
            lastVerification: {
              backend: "evaluator",
              verdict: "not_met",
              reason: "Missing tests",
              missing: ["focused tests"],
              notMetStreak: 2,
              at: 1_700_000_000_000,
            },
          }),
        }),
      }),
    );
    expect(JSON.stringify(emitBusEvent.mock.calls[0]?.[0])).not.toContain(
      "private blocker detail",
    );
  });
});

describe("buildThreadGoalRuntimeTools", () => {
  const signalCollector = { collect: () => "accepted" as const };
  const fakeStore = {
    getBySession: async () => undefined,
    getById: async () => undefined,
    create: async () => goal(),
    patch: async () => goal(),
    updateBreaker: async () => ({
      action: "stale" as const,
      staleReason: "missing_goal" as const,
    }),
    delete: async () => undefined,
  };

  it("does not expose create_goal and returns only lifecycle tools when enabled", () => {
    const tools = buildThreadGoalRuntimeTools(
      fakeStore,
      false,
      signalCollector,
    );
    expect(tools.map((tool) => tool.def.name).sort()).toEqual([
      "get_goal",
      "update_goal",
    ]);
  });

  it("returns no tools when disabled", () => {
    expect(
      buildThreadGoalRuntimeTools(fakeStore, true, signalCollector),
    ).toEqual([]);
  });
});
