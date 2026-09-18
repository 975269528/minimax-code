import { PNG } from "pngjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  digestThreadGoalObjective,
  VerificationDispatchError,
  type ThreadGoalState,
  type TranscriptWindowReader,
  type VerificationAttempt,
  type VerificationDispatchFailureCode,
  type VerificationResult,
  type VerificationUsage,
  type VerificationVerdict,
  type VerifierPort,
} from "@mavis/goal";

import { closeLocalRuntimeDb } from "../../src/persistence/db.js";
import type { ThreadGoalGateConfig } from "../../src/thread-goal/gate.js";
import { LocalThreadGoalIntegration } from "../../src/thread-goal/host-integration.js";
import { LocalActiveTurnTimingRegistry } from "../../src/turns/active-turn-timing.js";

const SESSION_ID = "session-verifier-contract";
const TURN_ID = "turn-verifier-contract";
const OBJECTIVE = "Prove the release candidate is ready";
const WORKER_MODEL_KEY = "configured-provider/worker-model";
const KNOWN_USAGE = { tokens: 3, activeSeconds: 2, incomplete: false } as const;

const VERDICT_CASES: ReadonlyArray<{
  readonly label: string;
  readonly verdict: VerificationVerdict;
  readonly expectedStatus: ThreadGoalState["status"];
  readonly expectedReason: ThreadGoalState["statusReason"];
}> = [
  {
    label: "met",
    verdict: {
      verdict: "met",
      reason: "The transcript contains passing release evidence.",
    },
    expectedStatus: "complete",
    expectedReason: "complete(verifier_met)",
  },
  {
    label: "not_met",
    verdict: {
      verdict: "not_met",
      reason: "The release evidence is incomplete.",
      missing: ["production smoke test"],
    },
    expectedStatus: "active",
    expectedReason: null,
  },
  {
    label: "impossible",
    verdict: {
      verdict: "impossible",
      reason: "The required signing key is unavailable.",
      blocker: "Release signing key has been revoked.",
    },
    expectedStatus: "blocked",
    expectedReason: "blocked(verifier_impossible)",
  },
  {
    label: "inconclusive",
    verdict: {
      verdict: "inconclusive",
      reason: "The supplied evidence cannot be evaluated.",
      code: "evidence_ambiguous",
    },
    expectedStatus: "paused",
    expectedReason: "paused(verifier_unavailable)",
  },
];

const HOST_VERDICT_CASES = VERDICT_CASES.flatMap((testCase) =>
  (["evaluator", "subagent"] as const).map((backend) => ({
    ...testCase,
    backend,
  })),
);

interface Harness {
  readonly integration: LocalThreadGoalIntegration;
  readonly initialGoal: ThreadGoalState;
  readonly verifier: VerifierPort;
  readonly transcriptReader: TranscriptWindowReader;
  readonly enqueuePostTurnContinuation: ReturnType<typeof vi.fn>;
  readonly emitRuntimeEvent: ReturnType<typeof vi.fn>;
  settle(input?: {
    readonly tokens?: number;
    readonly finalAssistantText?: string;
    readonly workerModelKey?: string | null;
    readonly workSignals?: { readonly toolCalls: number };
  }): ReturnType<LocalThreadGoalIntegration["settleInjectedTurn"]>;
}

async function withHarness(
  options: {
    readonly verifier: VerifierPort;
    /** `null` omits the config override and exercises route-derived policy. */
    readonly configuredVerification?: "none" | "evaluator" | "subagent" | null;
    readonly routeConfig?: Omit<ThreadGoalGateConfig, "goal" | "beta">;
    readonly tokenBudget?: number;
    readonly objectiveResources?: ThreadGoalState["objectiveResources"];
    readonly transcriptReader?: TranscriptWindowReader;
    readonly enqueuePostTurnContinuation?: ReturnType<typeof vi.fn>;
  },
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "goal-verifier-contract-"));
  let now = 1_700_000_000_000;
  const nowMs = () => now++;
  const turnTimings = new LocalActiveTurnTimingRegistry(nowMs);
  const enqueuePostTurnContinuation =
    options.enqueuePostTurnContinuation ?? vi.fn(async () => undefined);
  const emitRuntimeEvent = vi.fn();
  const transcriptReader =
    options.transcriptReader ??
    ({
      capture: vi.fn(async () => ({
        messages: [{ role: "assistant", content: "Release checks finished." }],
        truncated: false,
      })),
    } satisfies TranscriptWindowReader);
  const integration = new LocalThreadGoalIntegration({
    dataDir,
    nowMs,
    turnTimingReader: turnTimings,
    publishGlobalEvent: vi.fn(),
    isSessionBusy: () => false,
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
    formatError: (error) =>
      error instanceof Error ? error.message : String(error),
    isEnabled: () => true,
    emitRuntimeEvent,
  });
  const configuredVerification =
    options.configuredVerification ??
    (options.configuredVerification === null ? null : "evaluator");
  integration.bindConfigGetter(() => ({
    ...options.routeConfig,
    goal: {
      ...(configuredVerification !== null
        ? { verification: configuredVerification }
        : {}),
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
  integration.bindVerifier(options.verifier, transcriptReader);

  try {
    let initialGoal = await integration.store.create({
      sessionId: SESSION_ID,
      objective: OBJECTIVE,
      objectiveResources: options.objectiveResources,
      ...(options.tokenBudget === undefined
        ? {}
        : { tokenBudget: options.tokenBudget }),
    });
    initialGoal =
      (await integration.store.transitionKickoffState(
        initialGoal.goalId,
        "pending",
        "enqueued",
      )) ?? initialGoal;
    initialGoal =
      (await integration.store.transitionKickoffState(
        initialGoal.goalId,
        "enqueued",
        "consumed",
      )) ?? initialGoal;
    turnTimings.begin(SESSION_ID, TURN_ID);
    const prepared = await integration.prepareTurnAdmission({
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      provenance: {
        source: "thread-goal",
        sourceContext: {
          origin: {
            type: "thread-goal-continuation",
            goalId: initialGoal.goalId,
            goalUpdatedAt: initialGoal.updatedAt,
            objectiveDigest: digestThreadGoalObjective(initialGoal.objective),
            kind: "active",
          },
        },
      },
      hasPendingPlan: async () => false,
      hasPriorityMailboxWork: async () => false,
    });
    if (prepared?.status !== "ready")
      throw new Error("Expected ready Goal admission");
    await prepared.commit();

    await run({
      integration,
      initialGoal,
      verifier: options.verifier,
      transcriptReader,
      enqueuePostTurnContinuation,
      emitRuntimeEvent,
      settle: (input = {}) =>
        integration.settleInjectedTurn({
          sessionId: SESSION_ID,
          turnId: TURN_ID,
          status: "completed",
          tokens: input.tokens ?? 1,
          retracted: false,
          ...(input.workerModelKey === null
            ? {}
            : { workerModelKey: input.workerModelKey ?? WORKER_MODEL_KEY }),
          ...(input.finalAssistantText === undefined
            ? {}
            : { finalAssistantText: input.finalAssistantText }),
          ...(input.workSignals === undefined
            ? {}
            : { workSignals: input.workSignals }),
        }),
    });
  } finally {
    closeLocalRuntimeDb(dataDir);
    await rm(dataDir, { recursive: true, force: true });
  }
}

function verifierResult(
  verdict: VerificationVerdict,
  usage: VerificationUsage = KNOWN_USAGE,
  backend: VerificationResult["backend"] = "evaluator",
): VerificationResult {
  return { backend, verdict, usage };
}

function fixedVerifier(
  verdict: VerificationVerdict,
  usage: VerificationUsage = KNOWN_USAGE,
  backend: VerificationResult["backend"] = "evaluator",
): VerifierPort {
  return {
    dispatch: vi.fn(async () =>
      verifierResult(
        verdict,
        backend === "subagent" && usage.childTurns === undefined
          ? { ...usage, childTurns: 2 }
          : usage,
        backend,
      ),
    ),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function submitGoalProposal(
  harness: Harness,
  status: "complete" | "blocked",
  summary?: string,
): Promise<void> {
  const updateGoal = (
    await harness.integration.runtimeToolsFor(false, SESSION_ID)
  ).find((tool) => tool.def.name === "update_goal");
  if (!updateGoal) throw new Error("Expected update_goal tool");
  await updateGoal.impl.execute(
    { sessionId: SESSION_ID, turnId: TURN_ID },
    { status, ...(summary ? { summary } : {}) },
  );
}

async function proposeCompletion(harness: Harness): Promise<void> {
  await submitGoalProposal(harness, "complete");
}

async function proposeBlock(harness: Harness): Promise<void> {
  await submitGoalProposal(harness, "blocked");
}

describe("Thread Goal verifier host contract", () => {
  it.each([false, true])(
    "reloads persisted screenshot evidence and fails closed when missing: %s",
    async (missing) => {
      const dir = await mkdtemp(join(tmpdir(), "goal-verifier-image-"));
      const path = join(dir, "saved.png");
      const bytes = PNG.sync.write({
        width: 1,
        height: 1,
        data: Buffer.from([0, 128, 255, 255]),
      } as PNG);
      if (!missing) await writeFile(path, bytes);
      const verifier = fixedVerifier({
        verdict: "met",
        reason: "Checked all requirements.",
      });
      try {
        await withHarness(
          {
            verifier,
            objectiveResources: [
              {
                type: "image",
                filePath: path,
                fileName: "saved.png",
                mimeType: "image/png",
                assetId: "asset-1",
              },
            ],
          },
          async (h) => {
            await submitGoalProposal(h, "complete");
            await h.settle();
            const goal = await h.integration.store.getBySession(SESSION_ID);
            if (missing) {
              expect(verifier.dispatch).not.toHaveBeenCalled();
              expect(goal).toMatchObject({
                status: "paused",
                statusReason: "paused(verifier_unavailable)",
              });
            } else {
              expect(verifier.dispatch).toHaveBeenCalledWith(
                expect.objectContaining({
                  objectiveResources: [
                    expect.objectContaining({ filePath: path }),
                  ],
                  objectiveImages: [
                    expect.objectContaining({
                      data: expect.any(String),
                      mimeType: expect.stringMatching(/^image\//),
                    }),
                  ],
                }),
                expect.any(AbortSignal),
              );
              expect(goal?.status).toBe("complete");
            }
          },
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    15_000, // Includes cold image decoder startup and persisted evidence on Windows.
  );

  it("uses the optional update_goal summary ahead of the final assistant text", async () => {
    const verifier = fixedVerifier({
      verdict: "met",
      reason: "Evidence is sufficient.",
    });
    await withHarness({ verifier }, async (harness) => {
      await submitGoalProposal(
        harness,
        "complete",
        "Structured completion claim.",
      );
      await harness.settle({ finalAssistantText: "Longer final answer." });

      expect(verifier.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          completionSummary: "Structured completion claim.",
          finalAssistantText: "Longer final answer.",
          hostContext: {
            completionProposal: {
              observed: true,
              status: "complete",
              turnId: TURN_ID,
            },
            settlement: {
              phase: "awaiting_verifier",
              durableStatusAtDispatch: "active",
              transitionOnMet: "complete(verifier_met)",
            },
          },
          evidence: expect.objectContaining({
            serializedBrief: expect.stringContaining(
              "Structured completion claim.",
            ),
          }),
        }),
        expect.any(AbortSignal),
      );
    });
  });

  it("falls back to finalAssistantText when update_goal has no summary", async () => {
    const verifier = fixedVerifier({
      verdict: "met",
      reason: "Evidence is sufficient.",
    });
    await withHarness({ verifier }, async (harness) => {
      await proposeCompletion(harness);
      await harness.settle({
        finalAssistantText: "Fallback completion claim.",
      });

      expect(verifier.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          evidence: expect.objectContaining({
            serializedBrief: expect.stringContaining(
              "Fallback completion claim.",
            ),
          }),
        }),
        expect.any(AbortSignal),
      );
    });
  });

  it("keeps the verifier child trace on the final Goal decision event", async () => {
    const verifier: VerifierPort = {
      dispatch: vi.fn(async () => ({
        backend: "subagent",
        verdict: {
          verdict: "met",
          reason: "The child found complete evidence.",
        },
        usage: { ...KNOWN_USAGE, childTurns: 1 },
        traceRef: {
          sessionId: "session-verifier-child",
          turnId: "turn-verifier-child",
        },
      })),
    };

    await withHarness(
      { verifier, configuredVerification: "subagent" },
      async (harness) => {
        await proposeCompletion(harness);
        await harness.settle();

        expect(harness.emitRuntimeEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "goal.verification_decided",
            payload: expect.objectContaining({
              childSessionId: "session-verifier-child",
              childTurnId: "turn-verifier-child",
            }),
          }),
        );
      },
    );
  });

  it("lets explicit none override a managed route", async () => {
    const verifier = fixedVerifier(
      { verdict: "met", reason: "The evidence is sufficient." },
      KNOWN_USAGE,
      "subagent",
    );
    await withHarness(
      {
        verifier,
        configuredVerification: "none",
        routeConfig: {
          provider: { minimax: { options: { authMode: "managed-login" } } },
        },
      },
      async (harness) => {
        await proposeCompletion(harness);
        await harness.settle({ workerModelKey: "minimax/MiniMax-M3" });
        await expect(
          harness.integration.store.getById(harness.initialGoal.goalId),
        ).resolves.toMatchObject({
          status: "complete",
          statusReason: "complete(worker_proposal)",
          lastVerification: undefined,
        });
        expect(verifier.dispatch).not.toHaveBeenCalled();
      },
    );
  });

  it("lets explicit evaluator override a BYOK route", async () => {
    const verifier = fixedVerifier({
      verdict: "met",
      reason: "The evidence is sufficient.",
    });
    await withHarness(
      { verifier, configuredVerification: "evaluator" },
      async (harness) => {
        await proposeCompletion(harness);
        await harness.settle({
          workerModelKey: "custom_provider:work/worker-model",
        });
        expect(verifier.dispatch).toHaveBeenCalledWith(
          expect.objectContaining({ backend: "evaluator" }),
          expect.any(AbortSignal),
        );
      },
    );
  });

  it.each([
    [
      "managed token plan",
      "minimax/MiniMax-M3",
      {
        provider: {
          minimax: { options: { authMode: "managed-login" as const } },
        },
      },
      "subagent",
    ],
    ["MiniMax API key", "minimax_api/MiniMax-M3", {}, "subagent"],
    ["custom provider", "custom_provider:work/worker-model", {}, "none"],
    ["configured provider", "openai/worker-model", {}, "none"],
  ] as const)(
    "derives %s as %s without a config override",
    async (_label, workerModelKey, routeConfig, expectedBackend) => {
      const verifier = fixedVerifier(
        { verdict: "met", reason: "The evidence is sufficient." },
        KNOWN_USAGE,
        "subagent",
      );
      await withHarness(
        { verifier, configuredVerification: null, routeConfig },
        async (harness) => {
          await proposeCompletion(harness);
          await harness.settle({ workerModelKey });
          const persisted = await harness.integration.store.getById(
            harness.initialGoal.goalId,
          );
          if (expectedBackend === "subagent") {
            expect(verifier.dispatch).toHaveBeenCalledWith(
              expect.objectContaining({ backend: "subagent" }),
              expect.any(AbortSignal),
            );
            expect(persisted).toMatchObject({
              status: "complete",
              statusReason: "complete(verifier_met)",
              lastVerification: { backend: "subagent" },
            });
          } else {
            expect(verifier.dispatch).not.toHaveBeenCalled();
            expect(persisted).toMatchObject({
              status: "complete",
              statusReason: "complete(worker_proposal)",
              lastVerification: undefined,
            });
          }
        },
      );
    },
  );

  it.each([
    ["missing", null],
    ["unparseable", "bare-model"],
  ] as const)(
    "falls back to none for a %s worker model key",
    async (_label, workerModelKey) => {
      const verifier = fixedVerifier({
        verdict: "met",
        reason: "The evidence is sufficient.",
      });
      await withHarness(
        { verifier, configuredVerification: null },
        async (harness) => {
          await proposeCompletion(harness);
          await harness.settle({ workerModelKey });
          expect(verifier.dispatch).not.toHaveBeenCalled();
          await expect(
            harness.integration.store.getById(harness.initialGoal.goalId),
          ).resolves.toMatchObject({
            status: "complete",
            statusReason: "complete(worker_proposal)",
          });
        },
      );
    },
  );

  it.each(HOST_VERDICT_CASES)(
    "persists $backend $label and applies only the host-owned mapped decision",
    async ({ backend, verdict, expectedStatus, expectedReason }) => {
      const verifier = fixedVerifier(verdict, KNOWN_USAGE, backend);
      await withHarness(
        { verifier, configuredVerification: backend },
        async (harness) => {
          await proposeCompletion(harness);
          const decision = await harness.settle({
            tokens: 2,
            finalAssistantText: "same reply",
          });
          const persisted = await harness.integration.store.getById(
            harness.initialGoal.goalId,
          );

          expect(verifier.dispatch).toHaveBeenCalledOnce();
          expect(verifier.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({
              backend,
              maxTokens: backend === "subagent" ? 500_000 : 32_000,
            }),
            expect.any(AbortSignal),
          );
          expect(harness.emitRuntimeEvent).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "goal.verification_dispatched",
              payload: expect.objectContaining({ backend, turnId: TURN_ID }),
            }),
          );
          expect(harness.emitRuntimeEvent).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "goal.verification_decided",
              payload: expect.objectContaining({
                verdict: verdict.verdict,
                disposition: "accepted",
                reportedTokens: 3,
                ...(backend === "subagent" ? { childTurns: 2 } : {}),
              }),
            }),
          );
          expect(persisted).toMatchObject({
            status: expectedStatus,
            statusReason: expectedReason,
            // The worker Turn's 2 tokens, plus the 3 verifier tokens when the
            // subagent backend ran: a subagent verifier is a real child agent
            // drawing from the Goal budget, while evaluator spend stays
            // report-only.
            tokensUsed: backend === "subagent" ? 5 : 2,
            turnsUsed: 1,
            lastVerification: {
              backend,
              verdict: verdict.verdict,
              turnId: TURN_ID,
              objectiveDigest: digestThreadGoalObjective(OBJECTIVE),
            },
          });
          if (verdict.verdict === "met") {
            expect(decision).toMatchObject({ stage: 7, action: "settled" });
            expect(persisted?.noProgressStreak).toBe(0);
          } else if (verdict.verdict === "not_met") {
            expect(decision).toMatchObject({ stage: 10, action: "continued" });
            expect(harness.enqueuePostTurnContinuation).toHaveBeenCalledOnce();
            expect(harness.enqueuePostTurnContinuation).toHaveBeenCalledWith(
              expect.objectContaining({
                message: expect.objectContaining({
                  content: expect.stringContaining("production smoke test"),
                }),
              }),
            );
          } else {
            expect(decision).toMatchObject({ stage: 7, action: "settled" });
          }
        },
      );
    },
  );

  /**
   * The budget gate stops the *worker*, at stage 4, before a verifier is ever
   * dispatched. What a verifier spends afterwards is charged (subagent) or
   * reported (evaluator) at settlement — never checked before dispatch.
   */

  it("lets an accepted `met` verification win over a tool-less final Turn", async () => {
    // GOAL-11: the no-tool breaker sits at stage 8, behind the verification
    // decision. A verifier-accepted completion must not be converted into
    // `paused(no_progress)` just because the deciding Turn only wrote text.
    const verifier = fixedVerifier({
      verdict: "met",
      reason: "Release evidence is complete.",
    });
    await withHarness({ verifier }, async (harness) => {
      await proposeCompletion(harness);
      const decision = await harness.settle({
        tokens: 2,
        finalAssistantText: "All checks are green.",
        workSignals: { toolCalls: 0 },
      });
      const persisted = await harness.integration.store.getById(
        harness.initialGoal.goalId,
      );

      expect(decision).toMatchObject({ stage: 7, action: "settled" });
      expect(persisted).toMatchObject({
        status: "complete",
        statusReason: "complete(verifier_met)",
        noToolStreak: 0,
      });
    });
  });

  it("lets the worker token budget win before the verifier is dispatched", async () => {
    const verifier = fixedVerifier({
      verdict: "met",
      reason: "The evidence is sufficient.",
    });
    await withHarness({ verifier, tokenBudget: 5 }, async (harness) => {
      // The claim is present, so only the budget gate can explain the absent
      // dispatch — without it this would pass on the completion gate instead.
      await proposeCompletion(harness);
      const decision = await harness.settle({ tokens: 6 });
      const persisted = await harness.integration.store.getById(
        harness.initialGoal.goalId,
      );

      expect(verifier.dispatch).not.toHaveBeenCalled();
      expect(decision).toMatchObject({
        stage: 4,
        action: "budget_limited",
        reason: "budget_limited(token)",
      });
      expect(persisted).toMatchObject({
        status: "budget_limited",
        statusReason: "budget_limited(token)",
        tokensUsed: 6,
        lastVerification: undefined,
      });
    });
  });

  it.each(VERDICT_CASES)(
    "leaves goal.tokensUsed untouched by a $label evaluator verification",
    async ({ verdict }) => {
      const verifier = fixedVerifier(verdict, {
        tokens: 4_000,
        activeSeconds: 2,
        incomplete: false,
      });
      await withHarness({ verifier, tokenBudget: 10 }, async (harness) => {
        await proposeCompletion(harness);
        await harness.settle({ tokens: 2 });
        const persisted = await harness.integration.store.getById(
          harness.initialGoal.goalId,
        );

        expect(verifier.dispatch).toHaveBeenCalledOnce();
        // 4_000 evaluator tokens against a 10-token budget: evaluator spend is
        // report-only, so nothing reaches the ledger and no gate moves.
        expect(persisted?.tokensUsed).toBe(2);
        expect(persisted?.status).not.toBe("budget_limited");
        expect(harness.emitRuntimeEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "goal.verification_decided",
            payload: expect.objectContaining({ reportedTokens: 4_000 }),
          }),
        );
      });
    },
  );

  it.each(VERDICT_CASES)(
    "charges subagent verifier tokens to the Goal ledger after a $label verdict",
    async ({ verdict, expectedStatus, expectedReason }) => {
      const verifier = fixedVerifier(
        verdict,
        { tokens: 40, activeSeconds: 2, incomplete: false },
        "subagent",
      );
      await withHarness(
        { verifier, configuredVerification: "subagent", tokenBudget: 1_000 },
        async (harness) => {
          await proposeCompletion(harness);
          await harness.settle({ tokens: 2 });
          const persisted = await harness.integration.store.getById(
            harness.initialGoal.goalId,
          );

          expect(verifier.dispatch).toHaveBeenCalledOnce();
          // The verdict-mapped status is unchanged by the charge; only the
          // ledger moves: 2 worker tokens + 40 verifier tokens.
          expect(persisted).toMatchObject({
            status: expectedStatus,
            statusReason: expectedReason,
            tokensUsed: 42,
          });
        },
      );
    },
  );

  /**
   * The verdict CAS runs before the charge, so a Goal the verifier judged
   * `met` completes even when the verifier's own spend blows the remaining
   * budget — the charge gates only future work, and a complete Goal has none.
   */
  it("completes a verifier-met Goal even when subagent spend exceeds the budget", async () => {
    const verifier = fixedVerifier(
      { verdict: "met", reason: "The evidence is sufficient." },
      { tokens: 4_000, activeSeconds: 2, incomplete: false },
      "subagent",
    );
    await withHarness(
      { verifier, configuredVerification: "subagent", tokenBudget: 10 },
      async (harness) => {
        await proposeCompletion(harness);
        const decision = await harness.settle({ tokens: 2 });
        const persisted = await harness.integration.store.getById(
          harness.initialGoal.goalId,
        );

        expect(decision).toMatchObject({ stage: 7, action: "settled" });
        expect(persisted).toMatchObject({
          status: "complete",
          statusReason: "complete(verifier_met)",
          tokensUsed: 4_002,
        });
      },
    );
  });

  it("limits the Goal when subagent verifier spend exhausts the budget after not_met", async () => {
    const verifier = fixedVerifier(
      {
        verdict: "not_met",
        reason: "The evidence is incomplete.",
        missing: ["smoke test"],
      },
      { tokens: 4_000, activeSeconds: 2, incomplete: false },
      "subagent",
    );
    await withHarness(
      { verifier, configuredVerification: "subagent", tokenBudget: 10 },
      async (harness) => {
        await proposeCompletion(harness);
        const decision = await harness.settle({ tokens: 2 });
        const persisted = await harness.integration.store.getById(
          harness.initialGoal.goalId,
        );

        expect(decision).toMatchObject({
          stage: 7,
          action: "budget_limited",
          reason: "budget_limited(token)",
        });
        expect(persisted).toMatchObject({
          status: "budget_limited",
          statusReason: "budget_limited(token)",
          tokensUsed: 4_002,
          lastVerification: { verdict: "not_met" },
        });
        expect(harness.emitRuntimeEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "goal.budget_decided",
            payload: expect.objectContaining({
              dimension: "token",
              tokensUsed: 4_002,
            }),
          }),
        );
        // The limited Goal gets the budget summary Turn, not the next active
        // continuation the not_met verdict would otherwise have enqueued.
        expect(harness.enqueuePostTurnContinuation).toHaveBeenCalledOnce();
        expect(harness.enqueuePostTurnContinuation).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.objectContaining({
              content: expect.stringContaining("reached its token budget"),
            }),
          }),
        );
      },
    );
  });

  it("does not charge an incomplete subagent usage sample", async () => {
    const verifier = fixedVerifier(
      { verdict: "met", reason: "The evidence is sufficient." },
      { tokens: null, activeSeconds: 1, incomplete: true },
      "subagent",
    );
    await withHarness(
      { verifier, configuredVerification: "subagent", tokenBudget: 1_000 },
      async (harness) => {
        await proposeCompletion(harness);
        await harness.settle({ tokens: 2 });
        const persisted = await harness.integration.store.getById(
          harness.initialGoal.goalId,
        );

        // No pessimistic estimate: an observation gap stays a gap.
        expect(persisted).toMatchObject({ status: "complete", tokensUsed: 2 });
      },
    );
  });

  it.each(VERDICT_CASES)(
    "rejects a late $label verdict after the Goal epoch changes",
    async ({ verdict }) => {
      const started = deferred<void>();
      const released = deferred<VerificationResult>();
      const verifier: VerifierPort = {
        dispatch: vi.fn(async () => {
          started.resolve();
          return released.promise;
        }),
      };
      await withHarness({ verifier }, async (harness) => {
        await proposeCompletion(harness);
        const settlement = harness.settle({ tokens: 1 });
        await started.promise;
        await harness.integration.store.patchByUser(
          harness.initialGoal.goalId,
          {
            objective: "A concurrent user-edited objective",
          },
        );
        released.resolve(
          verifierResult(verdict, {
            tokens: 2,
            activeSeconds: 1,
            incomplete: false,
          }),
        );

        const decision = await settlement;
        const persisted = await harness.integration.store.getById(
          harness.initialGoal.goalId,
        );
        expect(decision).toMatchObject({
          stage: 7,
          action: "stale",
          reason: "goal_epoch",
        });
        expect(persisted).toMatchObject({
          objective: "A concurrent user-edited objective",
          status: "active",
          tokensUsed: 1,
          lastVerification: undefined,
        });
        expect(harness.enqueuePostTurnContinuation).not.toHaveBeenCalled();
        expect(harness.emitRuntimeEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "goal.verification_decided",
            payload: expect.objectContaining({ disposition: "stale" }),
          }),
        );
      });
    },
  );

  // Every dispatch failure pauses; the reason names the layer that owns the
  // fix, so an on-call engineer can route from the persisted status alone.
  it.each([
    ["timeout", "paused(verifier_timeout)"],
    ["api_error", "paused(verifier_unavailable)"],
    ["schema_error", "paused(verifier_protocol)"],
    ["input_too_large", "paused(verifier_protocol)"],
    ["spawn_failed", "paused(verifier_runtime)"],
    ["child_crash", "paused(verifier_runtime)"],
    ["child_budget_exhausted", "paused(verifier_budget)"],
    ["capability_violation", "paused(verifier_capability)"],
    ["aborted", "paused(verifier_aborted)"],
    ["route_unavailable", "paused(route_unavailable)"],
  ] as const)(
    "accounts a %s failure and pauses without synthesizing completion",
    async (code, expectedReason) => {
      const verifier: VerifierPort = {
        dispatch: vi.fn(async () => {
          throw new VerificationDispatchError(
            code as VerificationDispatchFailureCode,
            `Verifier failed with ${code}`,
            { tokens: 2, activeSeconds: 1, incomplete: false },
          );
        }),
      };
      await withHarness({ verifier }, async (harness) => {
        await proposeCompletion(harness);
        const decision = await harness.settle({ tokens: 1 });
        const persisted = await harness.integration.store.getById(
          harness.initialGoal.goalId,
        );

        expect(decision).toMatchObject({
          stage: 9,
          action: "settled",
          reason: expectedReason,
        });
        expect(persisted).toMatchObject({
          status: "paused",
          statusReason: expectedReason,
          tokensUsed: 1,
          lastVerification: undefined,
        });
        expect(harness.emitRuntimeEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "goal.verification_decided",
            payload: expect.objectContaining({
              verdict: "inconclusive",
              disposition: "unavailable",
              failureCode: code,
            }),
          }),
        );
      });
    },
  );

  /**
   * A subagent verification can run for minutes. If the host handed the adapter
   * a signal nobody ever fires, a user pressing stop leaves a child running and
   * still charging the Goal it was just told to abandon.
   */
  it("aborts an in-flight verification when the host pauses the Goal", async () => {
    let observed: AbortSignal | undefined;
    let announceDispatch = (): void => undefined;
    const reachedVerifier = new Promise<void>((resolve) => {
      announceDispatch = resolve;
    });
    const verifier: VerifierPort = {
      dispatch: vi.fn(
        async (_attempt: VerificationAttempt, signal: AbortSignal) => {
          observed = signal;
          announceDispatch();
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          );
          // Reject the way an adapter that does not classify would, so the host
          // has to derive `aborted` from the controller it owns.
          throw new Error("verifier child terminated");
        },
      ),
    };

    await withHarness({ verifier }, async (harness) => {
      await proposeCompletion(harness);
      const settling = harness.settle();
      await reachedVerifier;
      expect(observed?.aborted).toBe(false);

      await harness.integration.pauseActiveGoalForAbort(SESSION_ID);
      expect(observed?.aborted).toBe(true);

      // The user's pause won the epoch race, so the verifier's own settlement
      // must refuse rather than overwrite it.
      await expect(settling).resolves.toMatchObject({ action: "stale" });
      await expect(
        harness.integration.store.getById(harness.initialGoal.goalId),
      ).resolves.toMatchObject({
        status: "paused",
        statusReason: "paused(user_requested)",
      });
    });
  });

  /**
   * The attempt cap is a response-size ceiling for one verifier call, not a
   * draw against the Goal's remaining tokens. It stays at the configured
   * maximum however little budget the Goal has left, and an incomplete usage
   * sample is reported as such instead of being charged at the envelope.
   */
  it("caps the attempt at the configured maximum regardless of remaining budget", async () => {
    const verifier = fixedVerifier(
      { verdict: "met", reason: "The evidence is sufficient." },
      { tokens: null, activeSeconds: 1, incomplete: true },
    );
    await withHarness({ verifier, tokenBudget: 101 }, async (harness) => {
      await proposeCompletion(harness);
      const decision = await harness.settle({ tokens: 1 });
      const persisted = await harness.integration.store.getById(
        harness.initialGoal.goalId,
      );

      expect(verifier.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ maxTokens: 32_000 }),
        expect.any(AbortSignal),
      );
      expect(decision).toMatchObject({ stage: 7, action: "settled" });
      expect(persisted).toMatchObject({
        status: "complete",
        tokensUsed: 1,
        lastVerification: { verdict: "met" },
      });
      expect(harness.emitRuntimeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "goal.verification_decided",
          payload: expect.objectContaining({
            reportedTokens: null,
            usageIncomplete: true,
            disposition: "accepted",
          }),
        }),
      );
    });
  });

  /**
   * Verification adjudicates the worker's completion claim and nothing else. A
   * productive turn that makes no claim has nothing to adjudicate, so it costs
   * no verifier call and simply continues.
   */
  it("leaves a turn without a completion claim unverified and continues", async () => {
    const verifier = fixedVerifier({
      verdict: "not_met",
      reason: "More evidence is required.",
      missing: ["release approval"],
    });
    const capture = vi.fn(async () => ({ messages: [], truncated: false }));
    await withHarness(
      { verifier, transcriptReader: { capture } },
      async (harness) => {
        const decision = await harness.settle();
        const persisted = await harness.integration.store.getById(
          harness.initialGoal.goalId,
        );

        expect(verifier.dispatch).not.toHaveBeenCalled();
        expect(capture).not.toHaveBeenCalled();
        expect(decision).toMatchObject({ stage: 10, action: "continued" });
        expect(persisted).toMatchObject({
          status: "active",
          lastVerification: undefined,
        });
      },
    );
  });

  /**
   * The claim is what opens the verification, never what decides it: the worker
   * cannot complete its own Goal by asserting it has.
   */
  it("treats a completion proposal as the trigger without granting it completion authority", async () => {
    const verifier = fixedVerifier({
      verdict: "not_met",
      reason: "The completion claim is not supported.",
      missing: ["independent approval"],
    });
    const capture = vi.fn(async () => ({ messages: [], truncated: false }));
    await withHarness(
      { verifier, transcriptReader: { capture } },
      async (harness) => {
        await proposeCompletion(harness);

        await harness.settle();
        const [attempt] = (verifier.dispatch as ReturnType<typeof vi.fn>).mock
          .calls[0] as [VerificationAttempt];
        const persisted = await harness.integration.store.getById(
          harness.initialGoal.goalId,
        );
        expect(verifier.dispatch).toHaveBeenCalledOnce();
        expect(capture).toHaveBeenCalledOnce();
        expect(attempt.transcriptWindow).toEqual({
          messages: [],
          truncated: false,
        });
        expect(persisted).toMatchObject({
          status: "active",
          lastVerification: { verdict: "not_met" },
        });
      },
    );
  });

  /**
   * `blocked` is the worker's own report of a dead end, not a claim of success,
   * so no verifier adjudicates it. Under managed routing this used to fall
   * through to a dispatch whose `not_met` verdict produced no transition at
   * all, silently discarding the report and leaving the Goal spinning on work
   * the worker had already declared stuck.
   */
  it("settles a subagent-routed block proposal without dispatching a verifier", async () => {
    const verifier = fixedVerifier(
      {
        verdict: "not_met",
        reason: "No completion evidence.",
        missing: ["evidence"],
      },
      KNOWN_USAGE,
      "subagent",
    );
    await withHarness(
      { verifier, configuredVerification: "subagent" },
      async (harness) => {
        await proposeBlock(harness);
        const decision = await harness.settle();
        const persisted = await harness.integration.store.getById(
          harness.initialGoal.goalId,
        );

        expect(verifier.dispatch).not.toHaveBeenCalled();
        expect(decision).toMatchObject({
          stage: 9,
          action: "settled",
          reason: "blocked(worker_reported)",
        });
        expect(persisted).toMatchObject({
          status: "blocked",
          statusReason: "blocked(worker_reported)",
          lastVerification: undefined,
        });
        expect(harness.enqueuePostTurnContinuation).not.toHaveBeenCalled();
      },
    );
  });

  it("fails closed when a replaceable verifier returns an invalid met payload", async () => {
    const invalidMet = { verdict: "met", reason: "" } as VerificationVerdict;
    const verifier = fixedVerifier(invalidMet);
    await withHarness({ verifier }, async (harness) => {
      await proposeCompletion(harness);
      await harness.settle();
      const persisted = await harness.integration.store.getById(
        harness.initialGoal.goalId,
      );

      expect(persisted).toMatchObject({
        status: "paused",
        // A malformed verdict is a verifier-contract problem, so it must not
        // read back as a transient provider outage.
        statusReason: "paused(verifier_protocol)",
        lastVerification: {
          verdict: "inconclusive",
          reason: expect.stringContaining("invalid"),
        },
      });
    });
  });

  it("retries a failed continuation enqueue without redispatching the verifier", async () => {
    const verifier = fixedVerifier({
      verdict: "not_met",
      reason: "More evidence is required.",
      missing: ["release approval"],
    });
    const enqueuePostTurnContinuation = vi
      .fn()
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce(undefined);
    await withHarness(
      { verifier, enqueuePostTurnContinuation },
      async (harness) => {
        await proposeCompletion(harness);
        await expect(harness.settle()).rejects.toThrow("queue unavailable");
        await expect(harness.settle()).resolves.toMatchObject({
          stage: 10,
          action: "continued",
        });
        const persisted = await harness.integration.store.getById(
          harness.initialGoal.goalId,
        );

        expect(verifier.dispatch).toHaveBeenCalledOnce();
        expect(enqueuePostTurnContinuation).toHaveBeenCalledTimes(2);
        expect(persisted).toMatchObject({
          status: "active",
          tokensUsed: 1,
          lastVerification: {
            verdict: "not_met",
            notMetStreak: 1,
            turnId: TURN_ID,
          },
        });
      },
    );
  });
});

/**
 * A verifier dispatch is the one window in which an `active` Goal is running no
 * Turn and is not idle either. Without a projection both clients render it as a
 * plain running Goal that has simply stopped producing output, which is what a
 * two-minute verification actually looked like in the field.
 */
describe("Thread Goal verification execution wait", () => {
  it("publishes the wait for the dispatch window without advancing the decision epoch", async () => {
    let observed: ThreadGoalState | undefined;
    let epochAtDispatch: number | undefined;
    const verifier: VerifierPort = {
      dispatch: vi.fn(async (attempt: VerificationAttempt) => {
        observed = await integrationRef?.store.getById(attempt.goalId);
        epochAtDispatch = attempt.goalUpdatedAt;
        return verifierResult({
          verdict: "met",
          reason: "The evidence is sufficient.",
        });
      }),
    };
    let integrationRef: LocalThreadGoalIntegration | undefined;

    await withHarness({ verifier }, async (harness) => {
      integrationRef = harness.integration;
      await proposeCompletion(harness);
      await harness.settle();

      // Visible for the whole await, and stamped against the epoch the dispatch
      // was decided on. Comparing to `attempt.goalUpdatedAt` rather than to the
      // pre-settlement epoch is the point: settlement legitimately advances the
      // epoch for usage accounting *before* dispatch, so only this equality
      // isolates the wait write itself as a non-advancing one.
      expect(observed).toMatchObject({
        status: "active",
        executionWait: { reason: "verification", sinceMs: expect.any(Number) },
      });
      expect(observed?.updatedAt).toBe(epochAtDispatch);

      // The verdict is what moves the epoch on, which is also what retires the
      // wait for readers.
      const persisted = await harness.integration.store.getById(
        harness.initialGoal.goalId,
      );
      expect(persisted?.updatedAt).toBeGreaterThan(epochAtDispatch ?? 0);
      expect(persisted?.executionWait).toBeNull();
    });
  });

  /**
   * Every way a dispatch can end must retire the wait. A `Verifying` label that
   * outlives its verifier is worse than no label: it reports work nobody is
   * doing, and only a restart would ever clear it.
   */
  it.each([
    {
      label: "met",
      verdict: {
        verdict: "met",
        reason: "All requirements are covered.",
      } as VerificationVerdict,
    },
    {
      label: "not_met",
      verdict: {
        verdict: "not_met",
        reason: "Evidence is missing.",
        missing: ["smoke test"],
      } as VerificationVerdict,
    },
    {
      label: "impossible",
      verdict: {
        verdict: "impossible",
        reason: "The signing key is gone.",
        blocker: "Key revoked.",
      } as VerificationVerdict,
    },
    {
      label: "inconclusive",
      verdict: {
        verdict: "inconclusive",
        reason: "The evidence cannot be evaluated.",
        code: "evidence_ambiguous",
      } as VerificationVerdict,
    },
  ])(
    "retires the wait once the verdict settles: $label",
    async ({ verdict }) => {
      await withHarness(
        { verifier: fixedVerifier(verdict) },
        async (harness) => {
          await proposeCompletion(harness);
          await harness.settle();
          const persisted = await harness.integration.store.getById(
            harness.initialGoal.goalId,
          );

          expect(persisted?.executionWait).toBeNull();
        },
      );
    },
  );

  it.each(["api_error", "timeout", "schema_error"] as const)(
    "retires the wait when dispatch fails: %s",
    async (code: VerificationDispatchFailureCode) => {
      const verifier: VerifierPort = {
        dispatch: vi.fn(async () => {
          throw new VerificationDispatchError(code, `verifier ${code}`, {
            tokens: null,
            activeSeconds: 0,
            incomplete: true,
          });
        }),
      };
      await withHarness({ verifier }, async (harness) => {
        await proposeCompletion(harness);
        await harness.settle();
        const persisted = await harness.integration.store.getById(
          harness.initialGoal.goalId,
        );

        expect(persisted?.executionWait).toBeNull();
      });
    },
  );

  it("retires the wait when an unclassified verifier child crashes", async () => {
    const verifier: VerifierPort = {
      dispatch: vi.fn(async () => {
        throw new Error("verifier child terminated");
      }),
    };
    await withHarness({ verifier }, async (harness) => {
      await proposeCompletion(harness);
      await harness.settle();
      const persisted = await harness.integration.store.getById(
        harness.initialGoal.goalId,
      );

      expect(persisted?.executionWait).toBeNull();
    });
  });

  /**
   * The user winning the epoch race is the case the epoch stamp exists for: the
   * pause writes a new `updatedAt`, which makes the wait unreadable *before*
   * the dispatch unwinds. The later clear then finds nothing current to clear
   * and must leave the paused Goal untouched rather than resurrect a row.
   */
  it("drops the wait when a user pause supersedes the verification epoch", async () => {
    let announceDispatch = (): void => undefined;
    const reachedVerifier = new Promise<void>((resolve) => {
      announceDispatch = resolve;
    });
    const verifier: VerifierPort = {
      dispatch: vi.fn(
        async (_attempt: VerificationAttempt, signal: AbortSignal) => {
          announceDispatch();
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          );
          throw new Error("verifier child terminated");
        },
      ),
    };

    await withHarness({ verifier }, async (harness) => {
      await proposeCompletion(harness);
      const settling = harness.settle();
      await reachedVerifier;
      await expect(
        harness.integration.store.getById(harness.initialGoal.goalId),
      ).resolves.toMatchObject({ executionWait: { reason: "verification" } });

      await harness.integration.pauseActiveGoalForAbort(SESSION_ID);
      await expect(settling).resolves.toMatchObject({ action: "stale" });

      await expect(
        harness.integration.store.getById(harness.initialGoal.goalId),
      ).resolves.toMatchObject({
        status: "paused",
        statusReason: "paused(user_requested)",
        executionWait: null,
      });
    });
  });

  /**
   * Verification lives only in the dispatching process, so a wait found at
   * startup is stale by construction. The cleanup must not sit behind
   * continuation recovery, which legitimately skips Goals for reasons that have
   * nothing to do with the wait.
   */
  it("clears a wait left behind by a crashed process without advancing the epoch", async () => {
    const verifier = fixedVerifier({ verdict: "met", reason: "Sufficient." });
    await withHarness({ verifier }, async (harness) => {
      const goalId = harness.initialGoal.goalId;
      const before = await harness.integration.store.getById(goalId);
      if (!before) throw new Error("Expected a persisted Goal");
      await harness.integration.store.setExecutionWaitAtEpoch({
        goalId,
        expectedUpdatedAt: before.updatedAt,
        reason: "verification",
      });
      await expect(
        harness.integration.store.listGoalsWaitingOnVerification(),
      ).resolves.toMatchObject([{ goalId }]);

      await expect(
        harness.integration.clearStaleVerificationWaits(),
      ).resolves.toBe(1);

      await expect(
        harness.integration.store.getById(goalId),
      ).resolves.toMatchObject({
        status: "active",
        updatedAt: before.updatedAt,
        executionWait: null,
      });
      // Idempotent: a second startup finds nothing left to correct.
      await expect(
        harness.integration.clearStaleVerificationWaits(),
      ).resolves.toBe(0);
    });
  });
});
