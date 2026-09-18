import { describe, expect, it } from "vitest";
import { normalizeTuiRuntimeEvent } from "../../src/runtime/event-normalizer.js";

describe("normalizeTuiRuntimeEvent", () => {
  it("normalizes actionable LLM retry metadata without exposing provider messages", () => {
    expect(
      normalizeTuiRuntimeEvent({
        type: "session.llm_retry",
        timestamp: 90,
        source: "runtime",
        payload: {
          schemaVersion: 1,
          sessionId: "session-1",
          turnId: "turn-1",
          callId: "call-1",
          scope: "agent",
          status: "waiting",
          retryAttempt: 2,
          maxRetries: 5,
          requestAttempt: 3,
          delayMs: 2_500,
          nextRetryAtMs: 3_000,
          error: {
            reason: "rate_limited",
            code: 50_111,
            message: "secret provider detail",
          },
        },
      }),
    ).toEqual({
      type: "session.llm_retry",
      timestampMs: 90,
      source: "runtime",
      sessionId: "session-1",
      turnId: "turn-1",
      callId: "call-1",
      scope: "agent",
      status: "waiting",
      retryAttempt: 2,
      maxRetries: 5,
      requestAttempt: 3,
      delayMs: 2_500,
      nextRetryAtMs: 3_000,
      error: { reason: "rate_limited", code: 50_111 },
    });
  });

  it("rejects a non-object product event payload at the TUI boundary", () => {
    expect(
      normalizeTuiRuntimeEvent({
        type: "session.llm_retry",
        timestamp: 91,
        source: "runtime",
        payload: "invalid",
      }),
    ).toEqual({
      type: "unknown",
      originalType: "session.llm_retry",
      timestampMs: 91,
      source: "runtime",
    });
  });

  it("normalizes queue fields before they reach a product surface", () => {
    expect(
      normalizeTuiRuntimeEvent({
        type: "session.queue.updated",
        timestamp: 100,
        source: "runtime",
        payload: {
          session_id: "session-1",
          item_id: "queue-1",
          status: "failed",
          queued_count: 0,
          failed_reason: "provider unavailable",
        },
      }),
    ).toEqual({
      type: "session.queue.updated",
      timestampMs: 100,
      source: "runtime",
      sessionId: "session-1",
      itemId: "queue-1",
      status: "failed",
      queuedCount: 0,
      failedReason: "provider unavailable",
    });
  });

  it("normalizes Runtime-owned Goal updates and clears", () => {
    expect(
      normalizeTuiRuntimeEvent({
        type: "thread_goal.updated",
        timestamp: 110,
        source: "local-runtime",
        payload: {
          goal: {
            goalId: "goal-1",
            sessionId: "session-1",
            objective: "Ship TUI Goal support",
            status: "active",
            createdAt: 100,
            updatedAt: 105,
            tokensUsed: 1200,
            turnsUsed: 3,
            timeUsedSeconds: 42,
            tokenBudget: null,
            statusReason: "paused(verifier_unavailable)",
            lastVerification: {
              backend: "evaluator",
              verdict: "not_met",
              reason: "Focused evidence is missing.",
              missing: ["focused tests"],
              notMetStreak: 2,
              at: 104,
            },
            hasKickoffAttachments: true,
          },
        },
      }),
    ).toEqual({
      type: "thread_goal.updated",
      timestampMs: 110,
      source: "local-runtime",
      sessionId: "session-1",
      goal: {
        goalId: "goal-1",
        sessionId: "session-1",
        objective: "Ship TUI Goal support",
        status: "active",
        createdAt: 100,
        updatedAt: 105,
        tokensUsed: 1200,
        turnsUsed: 3,
        timeUsedSeconds: 42,
        tokenBudget: null,
        statusReason: "paused(verifier_unavailable)",
        lastVerification: {
          backend: "evaluator",
          verdict: "not_met",
          reason: "Focused evidence is missing.",
          missing: ["focused tests"],
          notMetStreak: 2,
          at: 104,
        },
        hasKickoffAttachments: true,
      },
    });

    expect(
      normalizeTuiRuntimeEvent({
        type: "thread_goal.cleared",
        timestamp: 111,
        source: "local-runtime",
        payload: { sessionId: "session-1", goalId: "goal-1" },
      }),
    ).toEqual({
      type: "thread_goal.cleared",
      timestampMs: 111,
      source: "local-runtime",
      sessionId: "session-1",
      goalId: "goal-1",
    });
  });

  it("fails closed for unknown Goal status and reason values", () => {
    const event = normalizeTuiRuntimeEvent({
      type: "thread_goal.updated",
      timestamp: 112,
      source: "local-runtime",
      payload: {
        goal: {
          goalId: "goal-1",
          sessionId: "session-1",
          objective: "Stay safe on future contract values",
          status: "future_status",
          createdAt: 100,
          updatedAt: 105,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          tokenBudget: null,
          statusReason: "future(reason)",
          hasKickoffAttachments: false,
        },
      },
    });

    expect(event).toMatchObject({
      type: "thread_goal.updated",
      goal: {
        status: "paused",
        statusReason: null,
      },
    });
  });

  it("normalizes a typed Goal execution wait while older events remain compatible", () => {
    const event = normalizeTuiRuntimeEvent({
      type: "thread_goal.updated",
      timestamp: 113,
      source: "local-runtime",
      payload: {
        goal: {
          goalId: "goal-1",
          sessionId: "session-1",
          objective: "Wait for the required task",
          status: "active",
          createdAt: 100,
          updatedAt: 105,
          tokensUsed: 0,
          timeUsedSeconds: 4,
          tokenBudget: null,
          execution_wait: {
            wait_reason: "required_background",
            wait_since: 106,
          },
          hasKickoffAttachments: false,
        },
      },
    });

    expect(event).toMatchObject({
      type: "thread_goal.updated",
      goal: {
        executionWait: { reason: "required_background", sinceMs: 106 },
      },
    });
  });

  it("normalizes the verification wait a long verifier dispatch publishes", () => {
    const event = normalizeTuiRuntimeEvent({
      type: "thread_goal.updated",
      timestamp: 113,
      source: "local-runtime",
      payload: {
        goal: {
          goalId: "goal-1",
          sessionId: "session-1",
          objective: "Prove the release is ready",
          status: "active",
          createdAt: 100,
          updatedAt: 105,
          tokensUsed: 0,
          timeUsedSeconds: 4,
          tokenBudget: null,
          executionWait: { reason: "verification", sinceMs: 106 },
          hasKickoffAttachments: false,
        },
      },
    });

    expect(event).toMatchObject({
      type: "thread_goal.updated",
      goal: { executionWait: { reason: "verification", sinceMs: 106 } },
    });
  });

  it("preserves the Runtime V2 admission rejection reason for queue recovery UI", () => {
    expect(
      normalizeTuiRuntimeEvent({
        type: "session.queue.updated",
        timestamp: 100,
        source: "runtime-v2",
        payload: {
          sessionId: "session-1",
          itemId: "queue-rejected",
          status: "admission-rejected",
          reason: "admission-rejected",
          admissionReason: "ingress-conflict",
        },
      }),
    ).toEqual({
      type: "session.queue.updated",
      timestampMs: 100,
      source: "runtime-v2",
      sessionId: "session-1",
      itemId: "queue-rejected",
      status: "admission-rejected",
      reason: "admission-rejected",
      admissionReason: "ingress-conflict",
    });
  });

  it("preserves a Runtime Turn failure reason for product presentation", () => {
    expect(
      normalizeTuiRuntimeEvent({
        type: "session.error",
        timestamp: 101,
        source: "runtime",
        payload: {
          sessionId: "session-1",
          turnId: "turn-1",
          error: "provider unavailable",
          errorCode: 429,
          errorSource: "byok_upstream",
          errorDetail: "upstream socket closed",
          errorProviderId: "custom-provider",
        },
      }),
    ).toMatchObject({
      type: "session.error",
      sessionId: "session-1",
      turnId: "turn-1",
      error: "provider unavailable",
      errorCode: 429,
      errorSource: "byok_upstream",
      errorDetail: "upstream socket closed",
      errorProviderId: "custom-provider",
    });
  });

  it("preserves task child identity and delegated lifecycle correlation", () => {
    expect(
      normalizeTuiRuntimeEvent({
        type: "session.created",
        timestamp: 102,
        source: "runtime",
        payload: {
          sessionId: "session-child",
          agentName: "verifier",
          sessionType: "branch",
          sessionKind: "task",
          visibility: "hidden",
          parentSessionId: "session-root",
          title: "Review recent changes",
        },
      }),
    ).toMatchObject({
      type: "session.created",
      sessionId: "session-child",
      agentName: "verifier",
      sessionType: "branch",
      sessionKind: "task",
      visibility: "hidden",
      parentSessionId: "session-root",
    });
    expect(
      normalizeTuiRuntimeEvent({
        type: "session.start",
        timestamp: 103,
        source: "runtime",
        payload: {
          sessionId: "session-child",
          turnId: "turn-child",
          taskId: "task-1",
          source: "subagent-headless-turn",
        },
      }),
    ).toMatchObject({
      type: "session.start",
      sessionId: "session-child",
      taskId: "task-1",
      runSource: "subagent-headless-turn",
    });
  });

  it("validates questionnaire payloads at the Runtime boundary", () => {
    expect(
      normalizeTuiRuntimeEvent({
        type: "questionnaire.ask",
        timestamp: 101,
        source: "runtime",
        payload: {
          sessionId: "session-1",
          request: {
            schemaVersion: 2,
            id: "question-1",
            mode: "plan",
            modePayload: {
              planReview: {
                markdown: "# Frozen plan",
                path: "/history/session-1/artifacts/plan.md",
              },
            },
            tool: { messageId: "message-1", callId: "call-1" },
            presentation: {
              replaceComposer: true,
              showProgress: true,
              allowBackNavigation: true,
            },
            steps: [
              {
                id: "step-1",
                question: "Proceed?",
                selectionMode: "single",
                allowOther: true,
                otherPlaceholder: "Others...",
                required: true,
                image: { src: "data:image/png;base64,step", alt: "Step image" },
                options: [
                  {
                    id: "yes",
                    label: "Yes",
                    image: {
                      src: "data:image/png;base64,option",
                      caption: "Option image",
                    },
                  },
                ],
              },
            ],
          },
        },
      }),
    ).toMatchObject({
      type: "questionnaire.ask",
      sessionId: "session-1",
      request: {
        id: "question-1",
        mode: "plan",
        modePayload: {
          planReview: {
            markdown: "# Frozen plan",
            path: "/history/session-1/artifacts/plan.md",
          },
        },
        tool: { messageId: "message-1", callId: "call-1" },
        steps: [
          expect.objectContaining({
            id: "step-1",
            question: "Proceed?",
            selectionMode: "single",
            image: { src: "data:image/png;base64,step", alt: "Step image" },
            options: [
              expect.objectContaining({
                id: "yes",
                label: "Yes",
                image: {
                  src: "data:image/png;base64,option",
                  caption: "Option image",
                },
              }),
            ],
          }),
        ],
      },
    });
  });

  it("preserves Goal purpose and defaults a missing mode to questionnaire", () => {
    expect(
      normalizeTuiRuntimeEvent({
        type: "questionnaire.ask",
        timestamp: 102,
        source: "runtime",
        payload: {
          sessionId: "session-goal",
          request: {
            schemaVersion: 2,
            id: "question-goal",
            purpose: 1,
            expiresAt: 1_700_000_300_000,
            presentation: {
              replaceComposer: true,
              showProgress: true,
              allowBackNavigation: true,
            },
            steps: [
              {
                id: "direction",
                question: "Which direction?",
                selectionMode: "single",
                options: [
                  { id: "safe", label: "Safe" },
                  { id: "fast", label: "Fast", recommended: true },
                ],
              },
            ],
          },
        },
      }),
    ).toMatchObject({
      type: "questionnaire.ask",
      request: {
        id: "question-goal",
        purpose: "goal",
        mode: "questionnaire",
        expiresAt: 1_700_000_300_000,
        steps: [
          {
            options: [
              { id: "safe", label: "Safe" },
              { id: "fast", label: "Fast", recommended: true },
            ],
          },
        ],
      },
    });
  });

  it("fails closed for an unknown Questionnaire purpose", () => {
    expect(
      normalizeTuiRuntimeEvent({
        type: "questionnaire.ask",
        timestamp: 103,
        source: "runtime",
        payload: {
          sessionId: "session-1",
          request: {
            schemaVersion: 2,
            id: "question-unknown-purpose",
            purpose: 99,
            presentation: {
              replaceComposer: true,
              showProgress: true,
              allowBackNavigation: true,
            },
            steps: [],
          },
        },
      }),
    ).toMatchObject({ type: "unknown", originalType: "questionnaire.ask" });
  });

  it.each([
    { label: "legacy schema", patch: { schemaVersion: 1 } },
    { label: "missing presentation", patch: { presentation: undefined } },
    {
      label: "partial presentation",
      patch: {
        presentation: {
          replaceComposer: true,
          showProgress: false,
          allowBackNavigation: true,
        },
      },
    },
  ])("rejects a Plan request with $label", ({ patch }) => {
    expect(
      normalizeTuiRuntimeEvent({
        type: "questionnaire.ask",
        timestamp: 101,
        source: "runtime",
        payload: {
          sessionId: "session-1",
          request: {
            schemaVersion: 2,
            id: "plan-strict-envelope",
            mode: "plan",
            presentation: {
              replaceComposer: true,
              showProgress: true,
              allowBackNavigation: true,
            },
            steps: [
              {
                id: "plan-enter",
                question: "Enter Plan Mode?",
                selectionMode: "single",
                options: [
                  { id: "confirm", label: "Confirm" },
                  { id: "decline", label: "Decline" },
                ],
                allowOther: true,
                otherPlaceholder: "Others...",
                required: true,
              },
            ],
            ...patch,
          },
        },
      }),
    ).toMatchObject({ type: "unknown", originalType: "questionnaire.ask" });
  });

  it.each([
    {
      label: "legacy top-level Plan review",
      request: {
        id: "legacy-plan",
        mode: "plan",
        planReview: { markdown: "# Plan", path: "/plan.md" },
        steps: [],
      },
    },
    {
      label: "Plan payload on a generic questionnaire",
      request: {
        id: "wrong-mode",
        mode: "questionnaire",
        modePayload: { planReview: { markdown: "# Plan", path: "/plan.md" } },
        steps: [],
      },
    },
    {
      label: "empty frozen Markdown",
      request: {
        id: "empty-markdown",
        mode: "plan",
        modePayload: { planReview: { markdown: "   ", path: "/plan.md" } },
        steps: [],
      },
    },
    {
      label: "empty canonical path",
      request: {
        id: "empty-path",
        mode: "plan",
        modePayload: { planReview: { markdown: "# Plan", path: "   " } },
        steps: [],
      },
    },
  ])("fails closed for $label", ({ request }) => {
    expect(
      normalizeTuiRuntimeEvent({
        type: "questionnaire.ask",
        timestamp: 101,
        source: "runtime",
        payload: { sessionId: "session-1", request },
      }),
    ).toMatchObject({ type: "unknown", originalType: "questionnaire.ask" });
  });

  it("fails closed to an unknown product event for malformed interactions", () => {
    expect(
      normalizeTuiRuntimeEvent({
        type: "permission.ask",
        timestamp: 102,
        source: "runtime",
        payload: { sessionId: "session-1" },
      }),
    ).toEqual({
      type: "unknown",
      originalType: "permission.ask",
      timestampMs: 102,
      source: "runtime",
      sessionId: "session-1",
    });
  });

  it("preserves the authoritative permission decision for product presentation", () => {
    expect(
      normalizeTuiRuntimeEvent({
        type: "permission.resolved",
        timestamp: 103,
        source: "runtime",
        payload: {
          session_id: "session-1",
          request_id: "permission-1",
          decision: "allowAlways",
        },
      }),
    ).toEqual({
      type: "permission.resolved",
      timestampMs: 103,
      source: "runtime",
      sessionId: "session-1",
      requestId: "permission-1",
      decision: "allowAlways",
    });
  });

  it("preserves the Runtime permission timestamp used for transcript ordering", () => {
    expect(
      normalizeTuiRuntimeEvent({
        type: "permission.ask",
        timestamp: 500,
        source: "runtime",
        payload: {
          sessionId: "session-1",
          requestId: "permission-ordered",
          toolName: "edit",
          toolInput: JSON.stringify({
            path: "src/greeting.ts",
            edits: [{ oldText: "old", newText: "new" }],
          }),
          createdAt: 123,
        },
      }),
    ).toMatchObject({
      type: "permission.ask",
      request: {
        requestId: "permission-ordered",
        createdAt: 123,
        structuredPreview: {
          schemaVersion: 1,
          state: "proposed",
          blocks: [
            expect.objectContaining({ kind: "diff", path: "src/greeting.ts" }),
          ],
        },
      },
    });
  });

  it.each([
    [
      "content.retry.exceeded",
      {
        sessionId: "session-1",
        variant: "content",
        lastUserMsgId: "message-user",
      },
      { variant: "content", lastUserMsgId: "message-user" },
    ],
    [
      "message.rewind",
      { sessionId: "session-1", contextReset: true },
      { contextReset: true },
    ],
    [
      "session.compaction.completed",
      {
        sessionId: "session-1",
        compactionId: "compact-1",
        messagesBefore: 10,
        messagesAfter: 3,
        tokensBefore: 1_000,
        tokensAfter: 300,
        tokenUsage: {
          inputTokens: 1_000,
          outputTokens: 300,
          cacheReadTokens: 20,
          cacheWriteTokens: 5,
          totalTokens: 1_325,
          incomplete: true,
        },
      },
      {
        compactionId: "compact-1",
        messagesBefore: 10,
        messagesAfter: 3,
        tokensBefore: 1_000,
        tokensAfter: 300,
        tokenUsage: {
          inputTokens: 1_000,
          outputTokens: 300,
          cacheReadTokens: 20,
          cacheWriteTokens: 5,
          totalTokens: 1_325,
          incomplete: true,
        },
      },
    ],
    [
      "session.title_updated",
      { sessionId: "session-1", title: "Renamed elsewhere" },
      { title: "Renamed elsewhere" },
    ],
  ] as const)("normalizes the %s owner event", (type, payload, expected) => {
    expect(
      normalizeTuiRuntimeEvent({
        type,
        timestamp: 600,
        source: "runtime",
        payload,
      }),
    ).toMatchObject({ type, sessionId: "session-1", ...expected });
  });

  it("preserves content-review authentication failures for an actionable warning", () => {
    expect(
      normalizeTuiRuntimeEvent({
        type: "content.retry.exceeded",
        timestamp: 650,
        source: "runtime",
        payload: { sessionId: "session-1", variant: "auth" },
      }),
    ).toMatchObject({
      type: "content.retry.exceeded",
      sessionId: "session-1",
      variant: "auth",
    });
  });

  it("normalizes Session rotation without inventing an active Session id", () => {
    expect(
      normalizeTuiRuntimeEvent({
        type: "rotation.completed",
        timestamp: 700,
        source: "runtime",
        payload: {
          agentName: "mavis",
          oldSessionId: "session-old",
          newSessionId: "session-new",
          reason: "context-limit",
        },
      }),
    ).toEqual({
      type: "rotation.completed",
      timestampMs: 700,
      source: "runtime",
      agentName: "mavis",
      oldSessionId: "session-old",
      newSessionId: "session-new",
      reason: "context-limit",
    });
  });
});
