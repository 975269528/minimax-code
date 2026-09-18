import { digestThreadGoalObjective, type ThreadGoalState } from "@mavis/goal";
import type { RuntimeConversation } from "@mavis/conversation-contract";
import { describe, expect, it, vi } from "vitest";

import type { LocalSessionRecord } from "../../src/sessions/controller.js";
import type { LocalThreadGoalIntegration } from "../../src/thread-goal/host-integration.js";
import { LocalThreadGoalKickoffQueue } from "../../src/thread-goal/kickoff-host.js";
import {
  buildThreadGoalKickoffMessage,
  threadGoalBudgetLimitClientRequestId,
  threadGoalRecoveryClientRequestId,
} from "../../src/thread-goal/kickoff.js";

const session = {
  sessionId: "session-a",
  agentName: "mavis",
} as LocalSessionRecord;
const goal = {
  goalId: "tg_1",
  sessionId: session.sessionId,
  objective: "Review the spec",
  status: "active",
  createdAt: 1_000,
  updatedAt: 1_000,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  tokenBudget: null,
  kickoffAttachments: [
    {
      type: "file",
      filePath: "/tmp/spec.md",
      fileName: "spec.md",
      mimeType: "text/markdown",
    },
  ],
  kickoffState: "pending",
} as ThreadGoalState;

function makeQueueHost(
  options: {
    recoverInitialContinuation?: (goal: ThreadGoalState) => Promise<void>;
    recoverableGoals?: ThreadGoalState[];
    listRecoverableKickoffs?: () => Promise<ThreadGoalState[]>;
    recoverableContinuations?: ThreadGoalState[];
    recoverableBudgetLimitSummaries?: ThreadGoalState[];
    shouldRecoverActiveContinuation?: (
      goal: ThreadGoalState,
    ) => Promise<boolean>;
    clearStaleVerificationWaits?: () => Promise<number>;
    renderRecoveryContinuationPrompt?: (
      goal: ThreadGoalState,
    ) => Promise<string>;
    renderRecoveryContinuationPromptRead?: (goal: ThreadGoalState) => Promise<{
      readonly content: string;
      readonly promptRead?: never;
    }>;
    conversation?: Pick<RuntimeConversation, "query" | "ingress">;
  } = {},
) {
  const recoverInitialContinuation = vi.fn(
    options.recoverInitialContinuation ?? (async () => undefined),
  );
  const clearStaleVerificationWaits = vi.fn(
    options.clearStaleVerificationWaits ?? (async () => 0),
  );
  const reportFailure = vi.fn();
  const reportRecoveryFailure = vi.fn();
  const rebindInternalPromptRead = vi.fn();
  const discardInternalPromptRead = vi.fn();
  const host = new LocalThreadGoalKickoffQueue({
    ...(options.conversation ? { conversation: options.conversation } : {}),
    getIntegration: () =>
      ({
        store: {
          listRecoverableKickoffs:
            options.listRecoverableKickoffs ??
            (async () => options.recoverableGoals ?? []),
          listRecoverableActiveGoals: async () =>
            options.recoverableContinuations ?? [],
          listRecoverableBudgetLimitSummaries: async () =>
            options.recoverableBudgetLimitSummaries ?? [],
        },
        recoverInitialContinuation,
        clearStaleVerificationWaits,
        shouldRecoverActiveContinuation:
          options.shouldRecoverActiveContinuation ?? (async () => true),
        preparePrompt: async (
          _recoverableGoal: ThreadGoalState,
          kind: string,
        ) => ({
          content:
            kind === "budget-limit"
              ? "The active thread goal has reached its token budget."
              : kind === "recovery"
                ? "Before taking any other action, call get_goal and recover durable Goal state."
                : "Continue working toward the active thread goal and follow the goal contract from the kickoff context.",
        }),
        prepareRecoveryPrompt: async (recoverableGoal: ThreadGoalState) => ({
          content:
            recoverableGoal.turnsUsed > 0 && recoverableGoal.turnsUsed % 5 === 0
              ? "Call get_goal once for the recovery and scheduled five-Turn checkpoint."
              : "Before taking any other action, call get_goal and recover durable Goal state.",
          kind:
            recoverableGoal.turnsUsed > 0 && recoverableGoal.turnsUsed % 5 === 0
              ? "recovery-terminal-audit"
              : "recovery",
        }),
        recordPromptSubmitted: vi.fn(),
        renderRecoveryContinuationPrompt:
          options.renderRecoveryContinuationPrompt ??
          (async (recoverableGoal) => `Continue: ${recoverableGoal.objective}`),
        renderRecoveryContinuationPromptRead:
          options.renderRecoveryContinuationPromptRead ??
          (async (recoverableGoal) => ({
            content: `Continue: ${recoverableGoal.objective}`,
          })),
        reserveInternalPromptRead: vi.fn(() => undefined),
        rebindInternalPromptRead,
        discardInternalPromptRead,
      }) as unknown as LocalThreadGoalIntegration,
    reportFailure,
    reportRecoveryFailure,
  });
  return {
    host,
    recoverInitialContinuation,
    clearStaleVerificationWaits,
    reportFailure,
    reportRecoveryFailure,
    rebindInternalPromptRead,
    discardInternalPromptRead,
  };
}

describe("LocalThreadGoalKickoffQueue", () => {
  it("derives a restart-stable budget summary identity from Goal id and epoch", () => {
    expect(
      threadGoalBudgetLimitClientRequestId({
        goalId: "tg_1",
        updatedAt: 1_700_000_000_123,
      }),
    ).toBe("thread-goal-followup:budget-limit:tg_1:1700000000123");
  });

  it("recovers Goal-owned pending kickoffs and reports scan failures", async () => {
    const recovery = makeQueueHost({ recoverableGoals: [goal] });

    await recovery.host.recover();

    expect(recovery.recoverInitialContinuation).toHaveBeenCalledWith(goal);
    expect(recovery.reportRecoveryFailure).not.toHaveBeenCalled();

    const failed = makeQueueHost({
      listRecoverableKickoffs: async () => {
        throw new Error("goal scan failed");
      },
    });
    await failed.host.recover();
    expect(failed.reportRecoveryFailure).toHaveBeenCalledWith(
      "goal scan failed",
    );
  });

  /**
   * A verification wait cannot survive the process that issued it, so startup
   * must retire it. The cleanup runs ahead of every recovery scan on purpose:
   * continuation recovery skips Goals for unrelated reasons (runtime disabled,
   * a session already started, an existing queue entry), and those are exactly
   * the Goals that would otherwise be left reading "Verifying" forever.
   */
  it("clears stale verification waits before any gated recovery scan", async () => {
    const order: string[] = [];
    const recovery = makeQueueHost({
      recoverableGoals: [goal],
      clearStaleVerificationWaits: async () => {
        order.push("cleanup");
        return 1;
      },
      recoverInitialContinuation: async () => {
        order.push("kickoff-recovery");
      },
    });

    await recovery.host.recover();

    expect(recovery.clearStaleVerificationWaits).toHaveBeenCalledOnce();
    expect(order).toEqual(["cleanup", "kickoff-recovery"]);
  });

  it("still clears stale verification waits when recovery gates skip every Goal", async () => {
    const recovery = makeQueueHost({
      recoverableGoals: [],
      recoverableContinuations: [goal],
      // The gate that made this reachable in the field: recovery declines, so
      // nothing downstream would ever touch the wait.
      shouldRecoverActiveContinuation: async () => false,
      conversation: {
        query: {
          getSession: async () => session,
          listSessions: async () => [session],
        },
        ingress: {
          findQueuedByClientRequestId: async () => undefined,
          submit: vi.fn(),
          dispatchQueue: vi.fn(),
          listQueued: async () => [],
        },
      } as unknown as Pick<RuntimeConversation, "query" | "ingress">,
    });

    await recovery.host.recover();

    expect(recovery.clearStaleVerificationWaits).toHaveBeenCalledOnce();
    expect(recovery.reportRecoveryFailure).not.toHaveBeenCalled();
  });

  it("reports a cleanup failure without stopping the recovery scans behind it", async () => {
    const recovery = makeQueueHost({
      recoverableGoals: [goal],
      clearStaleVerificationWaits: async () => {
        throw new Error("cleanup unavailable");
      },
    });

    await recovery.host.recover();

    expect(recovery.reportRecoveryFailure).toHaveBeenCalledWith(
      "thread_goal_stale_verification_wait_cleanup_failed:cleanup unavailable",
    );
    expect(recovery.recoverInitialContinuation).toHaveBeenCalledWith(goal);
  });

  it("materializes and recovers kickoffs only through the injected queue", async () => {
    const submit = vi.fn(async () => acceptedQueueTurn());
    const dispatchQueue = vi.fn(async () => undefined);
    const findQueuedByClientRequestId = vi.fn(async () => undefined);
    const fixture = makeQueueHost({
      recoverableGoals: [goal],
      conversation: {
        query: {
          getSession: async () => session,
          listSessions: async () => [session],
        },
        ingress: {
          findQueuedByClientRequestId,
          submit,
          dispatchQueue,
        },
      } as Pick<RuntimeConversation, "query" | "ingress">,
    });

    await fixture.host.integrationDeps().enqueueInitialContinuationTurn(
      goal,
      buildThreadGoalKickoffMessage(
        goal,
        "hidden continuation",
        goal.kickoffAttachments.map((attachment) => ({ ...attachment })),
      ),
      `thread-goal-kickoff:${goal.goalId}`,
    );

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.sessionId,
        source: "thread-goal",
        allowQueue: true,
        message: expect.objectContaining({
          hideUserMessage: true,
          displayContent: goal.objective,
          origin: {
            type: "thread-goal-kickoff",
            goalId: goal.goalId,
            goalUpdatedAt: goal.updatedAt,
            objectiveDigest: digestThreadGoalObjective(goal.objective),
            displayContent: goal.objective,
          },
          attachments: [expect.objectContaining({ fileName: "spec.md" })],
        }),
        clientRequestId: `thread-goal-kickoff:${goal.goalId}`,
      }),
    );
    expect(dispatchQueue).not.toHaveBeenCalled();

    await fixture.host.recover();
    expect(fixture.recoverInitialContinuation).toHaveBeenCalledWith(goal);
    expect(dispatchQueue).not.toHaveBeenCalled();

    fixture.host.integrationDeps().requestQueueDispatch(session.sessionId);
    expect(dispatchQueue).toHaveBeenCalledWith(session.sessionId);
  });

  it("keeps an initial continuation prompt snapshot with its admitted Turn", async () => {
    const submit = vi.fn(async () => acceptedQueueTurn());
    const fixture = makeQueueHost({
      conversation: {
        query: {
          getSession: async () => session,
          listSessions: async () => [session],
        },
        ingress: {
          findQueuedByClientRequestId: vi.fn(async () => undefined),
          submit,
          dispatchQueue: vi.fn(async () => undefined),
        },
      } as Pick<RuntimeConversation, "query" | "ingress">,
    });
    const internalPromptRead = {
      requestedTurnId: "turn_goal_requested",
      promptRead: {} as never,
    };

    await fixture.host
      .integrationDeps()
      .enqueueInitialContinuationTurn(
        goal,
        buildThreadGoalKickoffMessage(goal, "hidden continuation", []),
        `thread-goal-kickoff:${goal.goalId}`,
        internalPromptRead,
      );

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedTurnId: internalPromptRead.requestedTurnId,
      }),
    );
    expect(fixture.rebindInternalPromptRead).toHaveBeenCalledWith(
      internalPromptRead,
      "turn-v2",
    );
  });

  it("recovers a consumed active Goal when no Turn or Goal continuation survived restart", async () => {
    const consumed = {
      ...goal,
      kickoffState: "consumed" as const,
      kickoffAttachments: [],
    };
    const submit = vi.fn(async () => acceptedQueueTurn());
    const listQueued = vi.fn(async () => []);
    const fixture = makeQueueHost({
      recoverableContinuations: [consumed],
      conversation: {
        query: {
          getSession: async () => ({ ...session, status: "idle" }),
          listSessions: async () => [session],
        },
        ingress: {
          findQueuedByClientRequestId: vi.fn(async () => undefined),
          listQueued,
          submit,
          dispatchQueue: vi.fn(async () => undefined),
        },
      } as Pick<RuntimeConversation, "query" | "ingress">,
    });

    await fixture.host.recover();

    expect(listQueued).toHaveBeenCalledWith(consumed.sessionId);
    expect(submit).toHaveBeenCalledWith({
      sessionId: consumed.sessionId,
      source: "thread-goal",
      allowQueue: true,
      message: expect.objectContaining({
        hideUserMessage: true,
        content: expect.stringContaining("call get_goal"),
        origin: expect.objectContaining({
          type: "thread-goal-continuation",
          goalId: consumed.goalId,
          kind: "active",
        }),
      }),
      clientRequestId: threadGoalRecoveryClientRequestId(consumed),
    });
    const recoveredContent = submit.mock.calls[0]?.[0].message.content;
    expect(recoveredContent).toContain("call get_goal");
    expect(recoveredContent).not.toContain(consumed.objective);
    expect(recoveredContent).not.toContain("<objective>");
  });

  it("replays a crashed budget-limit transition once with its stable identity", async () => {
    const limited = {
      ...goal,
      status: "budget_limited" as const,
      kickoffState: "consumed" as const,
      kickoffAttachments: [],
      tokensUsed: 100,
      tokenBudget: 100,
      updatedAt: 2_000,
    };
    let queued: ReturnType<typeof injectedQueueItem> | undefined;
    const submit = vi.fn(async (input: { clientRequestId?: string }) => {
      queued = {
        ...injectedQueueItem("thread-goal"),
        clientRequestId: input.clientRequestId ?? "missing-client-request-id",
      };
      return acceptedQueueTurn();
    });
    const fixture = makeQueueHost({
      recoverableBudgetLimitSummaries: [limited],
      conversation: {
        query: {
          getSession: async () => ({ ...session, status: "idle" }),
          listSessions: async () => [session],
        },
        ingress: {
          findQueuedByClientRequestId: vi.fn(async () => queued),
          submit,
          dispatchQueue: vi.fn(async () => undefined),
        },
      } as Pick<RuntimeConversation, "query" | "ingress">,
    });

    await fixture.host.recover();
    await fixture.host.recover();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: limited.sessionId,
        source: "thread-goal",
        allowQueue: true,
        clientRequestId: threadGoalBudgetLimitClientRequestId(limited),
        message: expect.objectContaining({
          hideUserMessage: true,
          content: expect.stringContaining("reached its token budget"),
          origin: expect.objectContaining({
            type: "thread-goal-continuation",
            goalId: limited.goalId,
            goalUpdatedAt: limited.updatedAt,
            kind: "budget-limit",
          }),
        }),
      }),
    );
  });

  it("does not duplicate an active Goal continuation that already survived restart", async () => {
    const consumed = {
      ...goal,
      kickoffState: "consumed" as const,
      kickoffAttachments: [],
    };
    const submit = vi.fn();
    const fixture = makeQueueHost({
      recoverableContinuations: [consumed],
      conversation: {
        query: {
          getSession: async () => ({ ...session, status: "idle" }),
          listSessions: async () => [session],
        },
        ingress: {
          findQueuedByClientRequestId: vi.fn(async () => undefined),
          listQueued: vi.fn(async () => [
            {
              ...injectedQueueItem("thread-goal"),
              message: {
                content: "hidden continuation",
                attachments: [],
                origin: {
                  type: "thread-goal-continuation",
                  goalId: consumed.goalId,
                  goalUpdatedAt: consumed.updatedAt,
                  objectiveDigest: digestThreadGoalObjective(
                    consumed.objective,
                  ),
                  kind: "active",
                },
              },
            },
          ]),
          submit,
          dispatchQueue: vi.fn(async () => undefined),
        },
      } as Pick<RuntimeConversation, "query" | "ingress">,
    });

    await fixture.host.recover();

    expect(submit).not.toHaveBeenCalled();
  });

  it("reports an injected queue wake failure without leaking the rejection", async () => {
    const dispatchQueue = vi.fn(async () => {
      throw new Error("dispatch failed");
    });
    const fixture = makeQueueHost({
      conversation: {
        query: {
          getSession: async () => session,
          listSessions: async () => [session],
        },
        ingress: {
          findQueuedByClientRequestId: vi.fn(async () => undefined),
          submit: vi.fn(async () => acceptedQueueTurn()),
          dispatchQueue,
        },
      } as Pick<RuntimeConversation, "query" | "ingress">,
    });

    fixture.host.integrationDeps().requestQueueDispatch(session.sessionId);

    await vi.waitFor(() =>
      expect(fixture.reportFailure).toHaveBeenCalledWith(
        session.sessionId,
        "thread_goal_queue_dispatch_failed:dispatch failed",
      ),
    );
  });

  it("treats an exact claimed kickoff as already materialized", async () => {
    const submit = vi.fn();
    const claimed = {
      ...injectedQueueItem("thread-goal"),
      status: "claimed" as const,
      claimId: "claim-1",
    };
    const findQueuedByClientRequestId = vi.fn(async () => claimed);
    const fixture = makeQueueHost({
      conversation: {
        query: {
          getSession: async () => session,
          listSessions: async () => [session],
        },
        ingress: {
          findQueuedByClientRequestId,
          submit,
          dispatchQueue: vi.fn(),
        },
      } as Pick<RuntimeConversation, "query" | "ingress">,
    });

    await fixture.host
      .integrationDeps()
      .enqueueInitialContinuationTurn(
        goal,
        buildThreadGoalKickoffMessage(
          goal,
          "hidden continuation",
          goal.kickoffAttachments,
        ),
        `thread-goal-kickoff:${goal.goalId}`,
      );

    expect(findQueuedByClientRequestId).toHaveBeenCalledWith(
      session.sessionId,
      `thread-goal-kickoff:${goal.goalId}`,
    );
    expect(submit).not.toHaveBeenCalled();
  });
});

function injectedQueueItem(source: "api" | "thread-goal") {
  return {
    itemId: "queue-v2",
    sessionId: session.sessionId,
    agentName: session.agentName,
    source,
    status: "queued" as const,
    message: { content: goal.objective, attachments: [] },
    createdAt: 1_000,
    clientRequestId: `thread-goal-kickoff:${goal.goalId}`,
  };
}

function acceptedQueueTurn() {
  return {
    turnId: "turn-v2",
    mode: "queued" as const,
    queue: { itemId: "queue-v2", position: 1, ahead: 0 },
    completion: Promise.resolve({
      turnId: "turn-v2",
      status: "completed" as const,
      messages: [],
    }),
  };
}
