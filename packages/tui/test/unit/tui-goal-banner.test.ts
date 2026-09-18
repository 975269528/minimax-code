import { describe, expect, it, vi } from "vitest";
import type { GlobalThreadGoal } from "@mavis/shared/global-events";
import { createTuiChalk } from "../../src/tui/theme/runtime.js";
import {
  TuiGoalBanner,
  formatGoalElapsed,
  formatGoalCompletionReceipt,
  formatGoalSummary,
} from "../../src/tui/features/goal/banner.js";
import { visibleWidth } from "../../src/tui/rendering/text.js";

const activeGoal: GlobalThreadGoal = {
  goalId: "goal-1",
  sessionId: "session-1",
  objective: "Ship TUI Goal support with client-aligned interactions",
  status: "active",
  createdAt: 10,
  updatedAt: 20,
  tokensUsed: 1200,
  turnsUsed: 3,
  timeUsedSeconds: 42,
  tokenBudget: null,
  statusReason: null,
  hasKickoffAttachments: true,
};

describe("TuiGoalBanner", () => {
  it("stops elapsed-time renders while an interaction owns the viewport", () => {
    vi.useFakeTimers();
    try {
      const requestRender = vi.fn();
      const banner = new TuiGoalBanner({ requestRender });
      banner.setGoal(activeGoal);
      requestRender.mockClear();

      vi.advanceTimersByTime(1_000);
      expect(requestRender).toHaveBeenCalledOnce();

      banner.setAnimationPaused(true);
      requestRender.mockClear();
      vi.advanceTimersByTime(2_000);
      expect(requestRender).not.toHaveBeenCalled();

      banner.setAnimationPaused(false);
      vi.advanceTimersByTime(1_000);
      expect(requestRender).toHaveBeenCalledOnce();

      banner.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows status, monotonic elapsed time, attachments, objective, and lifecycle actions", () => {
    let now = 100_000;
    const requestRender = vi.fn();
    const banner = new TuiGoalBanner({
      now: () => now,
      animate: false,
      requestRender,
      chalk: createTuiChalk({ noColor: true }),
    });

    expect(banner.render(100)).toEqual([]);
    banner.setGoal(activeGoal);
    now += 3_000;

    const lines = banner.render(100);
    expect(lines[0]).toContain("Goal · Active · 45s active · Attachment");
    expect(lines[1]).toContain("1.2K tokens");
    expect(lines[1]).toContain("3 turns");
    expect(lines.join("\n")).toContain(activeGoal.objective);
    expect(lines.join("\n")).toContain("/goal pause");
    expect(lines.join("\n")).toContain("/goal edit");
    expect(lines.join("\n")).toContain("/goal clear");
    expect(requestRender).toHaveBeenCalled();
  });

  it("keeps the hour rollover and Goal receipts in the same format", () => {
    let now = 100_000;
    const banner = new TuiGoalBanner({ now: () => now, animate: false });
    banner.setGoal({ ...activeGoal, timeUsedSeconds: 3_599 });
    expect(banner.render(100).join("\n")).toContain("59min59s active");
    now += 1_000;
    expect(banner.render(100).join("\n")).toContain("1h0min0s active");

    const goal = { ...activeGoal, timeUsedSeconds: 7_770 };
    banner.setGoal(goal);
    expect(banner.render(100).join("\n")).toContain("2h9min30s active");
    expect(banner.render(24).every((line) => visibleWidth(line) <= 24)).toBe(
      true,
    );
    expect(formatGoalSummary(goal)).toContain("Time used: 2h9min30s");
    expect(
      formatGoalCompletionReceipt({ ...goal, status: "complete" }),
    ).toContain("2h9min30s");
  });

  it("keeps paused time still and fits narrow terminals", () => {
    let now = 200_000;
    const banner = new TuiGoalBanner({
      now: () => now,
      animate: false,
      chalk: createTuiChalk({ noColor: true }),
    });
    banner.setGoal({ ...activeGoal, status: "paused", timeUsedSeconds: 62 });
    now += 30_000;

    const lines = banner.render(24);
    expect(lines.join("\n")).toContain("1min2s");
    expect(lines.join("\n")).toContain("/goal resume");
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });

  /**
   * A parked Goal used to read as plain "Active" here, so a verification that
   * legitimately runs for minutes was indistinguishable from a stuck Goal.
   * Every wait the runtime can publish must be visible, not just verification.
   */
  it.each([
    ["verification", "Verifying the result"],
    ["questionnaire", "Waiting for your answer"],
    ["permission", "Waiting for permission"],
    ["plan", "Waiting for Plan to finish"],
    ["required_background", "Waiting for background tasks"],
    ["automation_owner_conflict", "Waiting for automation"],
    ["dependency_unavailable", "Waiting for a dependency"],
    ["unknown", "Waiting for requirements"],
  ] as const)("reports an active Goal parked on %s", (reason, label) => {
    const banner = new TuiGoalBanner({
      animate: false,
      chalk: createTuiChalk({ noColor: true }),
    });
    banner.setGoal({ ...activeGoal, executionWait: { reason, sinceMs: 30 } });

    const output = banner.render(100).join("\n");
    expect(output).toContain(`Goal · ${label}`);
    expect(output).not.toContain("Goal · Active");
    // A wait replaces the status label; it is not a lifecycle state, so the
    // Goal keeps its `active` actions.
    expect(output).toContain("/goal pause");
  });

  it("returns to the plain active label once the wait is cleared", () => {
    const banner = new TuiGoalBanner({
      animate: false,
      chalk: createTuiChalk({ noColor: true }),
    });
    banner.setGoal({
      ...activeGoal,
      executionWait: { reason: "verification", sinceMs: 30 },
    });
    expect(banner.render(100).join("\n")).toContain("Verifying the result");

    // The runtime omits the field entirely once the wait retires.
    banner.setGoal({ ...activeGoal });
    const output = banner.render(100).join("\n");
    expect(output).toContain("Goal · Active");
    expect(output).not.toContain("Verifying the result");
  });

  /**
   * Waits are an execution detail *inside* `active`. A projection that arrived
   * out of order must never make a paused Goal claim it is still verifying.
   */
  it("ignores a wait carried by a non-active Goal", () => {
    const banner = new TuiGoalBanner({
      animate: false,
      chalk: createTuiChalk({ noColor: true }),
    });
    banner.setGoal({
      ...activeGoal,
      status: "paused",
      executionWait: { reason: "verification", sinceMs: 30 },
    });

    const output = banner.render(100).join("\n");
    expect(output).toContain("Goal · Paused");
    expect(output).not.toContain("Verifying the result");
  });

  it("does not keep a completed Goal in the persistent composer banner", () => {
    const banner = new TuiGoalBanner({
      animate: false,
      chalk: createTuiChalk({ noColor: true }),
    });
    banner.setGoal({ ...activeGoal, status: "complete" });

    expect(banner.render(100)).toEqual([]);
  });

  it("guides a budget-limited Goal to replacement without offering resume", () => {
    const banner = new TuiGoalBanner({
      animate: false,
      chalk: createTuiChalk({ noColor: true }),
    });
    banner.setGoal({ ...activeGoal, status: "budget_limited" });

    const output = banner.render(100).join("\n");
    expect(output).toContain(
      "/goal clear, then /goal <objective> starts a new Goal",
    );
    expect(output).not.toContain("/goal resume");
  });

  it("shows a typed usage limitation and its recovery action", () => {
    const banner = new TuiGoalBanner({
      animate: false,
      chalk: createTuiChalk({ noColor: true }),
    });
    banner.setGoal({
      ...activeGoal,
      status: "usage_limited",
      statusReason: "usage_limited(provider_quota)",
    });

    const output = banner.render(180).join("\n");
    expect(output).toContain("Goal · Usage limited");
    expect(output).not.toContain("usage_limited(provider_quota)");
    expect(output).toContain("Resume after provider access recovers");
    expect(output).toContain("/goal resume");
    expect(output).not.toContain("Complete");
  });

  it.each([
    ["met", "Met"],
    ["impossible", "Impossible"],
    ["inconclusive", "Inconclusive"],
  ] as const)("shows the latest %s verifier verdict", (verdict, label) => {
    const banner = new TuiGoalBanner({
      animate: false,
      chalk: createTuiChalk({ noColor: true }),
    });
    banner.setGoal({
      ...activeGoal,
      lastVerification: {
        backend: "evaluator",
        verdict,
        reason: `${verdict} reason`,
        missing: [],
        notMetStreak: 0,
        at: 1_700_000_000_000,
      },
    });

    const output = banner.render(180).join("\n");
    expect(output).toContain(`Latest verifier: ${label}`);
    expect(output).not.toContain("not-met streak");
    expect(output).not.toContain("missing:");
  });

  it("shows not_met streak and a bounded missing summary on its own fitted line", () => {
    const banner = new TuiGoalBanner({
      animate: false,
      chalk: createTuiChalk({ noColor: true }),
    });
    banner.setGoal({
      ...activeGoal,
      lastVerification: {
        backend: "evaluator",
        verdict: "not_met",
        reason: "Release evidence is incomplete",
        missing: ["smoke\n test", "release approval", "artifact checksum"],
        notMetStreak: 2,
        at: 1_700_000_000_000,
      },
    });

    const wide = banner.render(180);
    expect(wide[2]).toContain("Latest verifier: Not met");
    expect(wide[2]).toContain("not-met streak 2");
    expect(wide[2]).toContain("missing: smoke test; release approval +1");
    const narrow = banner.render(24);
    expect(narrow.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });

  it("retains seconds in compact Goal durations beyond one hour", () => {
    expect(formatGoalElapsed(8)).toBe("8s");
    expect(formatGoalElapsed(62)).toBe("1min2s");
    expect(formatGoalElapsed(7_320)).toBe("2h2min0s");
    expect(formatGoalElapsed(7_770)).toBe("2h9min30s");
  });
});
