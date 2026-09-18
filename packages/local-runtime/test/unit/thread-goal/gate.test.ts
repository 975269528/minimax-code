import { describe, expect, it } from "vitest";

import { digestThreadGoalObjective, type ThreadGoalState } from "@mavis/goal";

import {
  finalRecheck,
  threadGoalSubagentMaxTokens,
  type ThreadGoalFinalRecheckDeps,
} from "../../../src/thread-goal/gate.js";

describe("Thread Goal subagent limits", () => {
  it("leaves the verifier token cap absent until it is configured", () => {
    expect(threadGoalSubagentMaxTokens()).toBeUndefined();
    expect(threadGoalSubagentMaxTokens(() => ({ goal: {} }))).toBeUndefined();
    expect(
      threadGoalSubagentMaxTokens(() => ({
        goal: { subagent: { maxTokens: 123_456 } },
      })),
    ).toBe(123_456);
  });
});

describe("Thread Goal final recheck", () => {
  it("captures an exact binding only after every pre-LLM guard is clear", async () => {
    const current = goal();
    await expect(finalRecheck(deps(current), input(current))).resolves.toEqual({
      decision: "ready",
      binding: {
        goalId: current.goalId,
        admittedGoalUpdatedAt: current.updatedAt,
        objectiveDigest: digestThreadGoalObjective(current.objective),
        turnId: "turn-final",
      },
    });
  });

  it.each([
    [
      "pause",
      goal({ status: "paused" }),
      {},
      "defer",
      "deferred(goal_not_active)",
    ],
    [
      "edit",
      goal({ updatedAt: 101, objective: "edited" }),
      {},
      "cancel",
      "stale(goal_epoch)",
    ],
    [
      "replace",
      goal({ goalId: "goal-replaced" }),
      {},
      "cancel",
      "stale(turn_binding)",
    ],
    [
      "user message",
      goal(),
      { hasPriorityMailboxWork: true },
      "cancel",
      "deferred(user_work)",
    ],
  ] as const)(
    "does not admit after a classify/start race: %s",
    async (_case, current, guards, decision, reason) => {
      await expect(
        finalRecheck(deps(current, guards), input(goal())),
      ).resolves.toMatchObject({
        decision,
        reason,
      });
    },
  );

  it.each([
    ["hasPendingQuestionnaire", "deferred(questionnaire)", "questionnaire"],
    ["hasPendingPermission", "deferred(permission)", "permission"],
    ["hasPendingPlan", "deferred(plan)", "plan"],
    [
      "hasRequiredBackgroundWork",
      "deferred(required_background)",
      "required_background",
    ],
    [
      "hasAutomationOwnerConflict",
      "deferred(automation_owner_conflict)",
      "automation_owner_conflict",
    ],
  ] as const)(
    "defers while %s is unresolved",
    async (guard, reason, waitReason) => {
      await expect(
        finalRecheck(deps(goal(), { [guard]: true }), input(goal())),
      ).resolves.toMatchObject({ decision: "defer", reason, waitReason });
    },
  );

  it("pauses a token-budget state before admission", async () => {
    const exhausted = goal({ tokensUsed: 10, tokenBudget: 10 });
    await expect(
      finalRecheck(deps(exhausted), input(exhausted)),
    ).resolves.toMatchObject({
      decision: "pause",
      reason: "budget_limited(token)",
    });
  });

  it("does not stop admission when no default limits are configured", async () => {
    const current = goal({
      tokensUsed: 10_000_000,
      turnsUsed: 10_000,
      timeUsedSeconds: 10_000_000,
      tokenBudget: null,
    });

    await expect(
      finalRecheck(deps(current), input(current)),
    ).resolves.toMatchObject({
      decision: "ready",
    });
  });

  it.each([
    [
      "default token",
      goal({ tokensUsed: 10, tokenBudget: null }),
      { defaultTokens: 10, defaultMainTurns: 50, defaultActiveSeconds: 100 },
      "budget_limited(token)",
    ],
    [
      "main turn",
      goal({ turnsUsed: 2 }),
      { defaultTokens: 100, defaultMainTurns: 2, defaultActiveSeconds: 100 },
      "budget_limited(main_turn)",
    ],
    [
      "active time",
      goal({ timeUsedSeconds: 30 }),
      { defaultTokens: 100, defaultMainTurns: 5, defaultActiveSeconds: 30 },
      "budget_limited(active_time)",
    ],
  ] as const)(
    "stops admission when the %s budget is exhausted",
    async (_label, current, budget, reason) => {
      await expect(
        finalRecheck(deps(current), input(current), () => ({
          goal: { budget },
        })),
      ).resolves.toMatchObject({ decision: "pause", reason });
    },
  );

  it("rejects an objective digest mismatch even when the epoch was not advanced", async () => {
    const current = goal({ objective: "silently changed" });
    await expect(
      finalRecheck(deps(current), input(goal())),
    ).resolves.toMatchObject({
      decision: "cancel",
      reason: "stale(objective_digest)",
    });
  });
});

function goal(overrides: Partial<ThreadGoalState> = {}): ThreadGoalState {
  return {
    goalId: "goal-1",
    sessionId: "session-1",
    objective: "Ship the release",
    status: "active",
    createdAt: 1,
    updatedAt: 100,
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

function input(expected: ThreadGoalState) {
  return {
    sessionId: expected.sessionId,
    goalId: expected.goalId,
    expectedUpdatedAt: expected.updatedAt,
    expectedObjectiveDigest: digestThreadGoalObjective(expected.objective),
    turnId: "turn-final",
  };
}

type GuardName = Exclude<keyof ThreadGoalFinalRecheckDeps, "getGoalBySession">;

function deps(
  current: ThreadGoalState,
  guards: Partial<Record<GuardName, boolean>> = {},
): ThreadGoalFinalRecheckDeps {
  return {
    getGoalBySession: async () => current,
    hasPendingQuestionnaire: async () =>
      guards.hasPendingQuestionnaire ?? false,
    hasPendingPermission: async () => guards.hasPendingPermission ?? false,
    hasPendingPlan: async () => guards.hasPendingPlan ?? false,
    hasRequiredBackgroundWork: async () =>
      guards.hasRequiredBackgroundWork ?? false,
    hasAutomationOwnerConflict: async () =>
      guards.hasAutomationOwnerConflict ?? false,
    hasPriorityMailboxWork: async () => guards.hasPriorityMailboxWork ?? false,
  };
}
