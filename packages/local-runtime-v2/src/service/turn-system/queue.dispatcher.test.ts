import { describe, expect, it, vi } from "vitest";

import type { QueueDispatchCapability } from "../session-system/index.js";
import type {
  QueueDispatchDisposition,
  QueueTurnExecutor,
} from "./contracts.js";
import { createQueueDispatcher } from "./queue.dispatcher.js";

describe("QueueDispatcher handoff preflight", () => {
  it.each(["fifo", "exact", "continued-fifo"] as const)(
    "reports a definitive handoff refusal for %s without silently cancelling",
    async (selection) => {
      const queue = dispatchQueue([]);
      queue.claimNext
        .mockReset()
        .mockResolvedValueOnce({ ...claim(), selection })
        .mockResolvedValue(undefined);
      const reason = "policy:cloud-handoff:denied:already-handed-off" as const;
      const dispatcher = createQueueDispatcher({
        queue,
        recoverState: noop,
        executor: {
          execute: vi.fn(async () => ({
            accepted: false as const,
            reason,
            queueDisposition: "cancel" as const,
          })),
        },
      });
      await dispatcher.dispatch("session-1");
      expect(queue.reject).toHaveBeenCalledWith({
        sessionId: "session-1",
        claimId: "claim-1",
        reason,
      });
      expect(queue.cancelClaim).not.toHaveBeenCalled();
      expect(queue.release).not.toHaveBeenCalled();
    },
  );

  it("retains a handoff queue item and reports a recoverable preparation failure", async () => {
    const queue = dispatchQueue([]);
    const reason = "policy:cloud-handoff:preparation-failed" as const;
    const execute = vi.fn(async () => ({
      accepted: false as const,
      reason,
      queueDisposition: "cancel" as const,
    }));
    const dispatcher = createQueueDispatcher({
      queue,
      executor: { execute },
      recoverState: noop,
    });
    await dispatcher.dispatch("session-1");
    expect(queue.release).toHaveBeenCalledWith({
      sessionId: "session-1",
      claimId: "claim-1",
      reason,
    });
    expect(queue.cancelClaim).not.toHaveBeenCalled();
    expect(queue.reject).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe("QueueDispatcher pending cancellation", () => {
  it.each(["classification", "admission"] as const)(
    "cancels a claimed item instead of requeueing after %s defers it",
    async (stage) => {
      const queue = dispatchQueue([]);
      let cancelled = false;
      const execute = vi.fn<QueueTurnExecutor["execute"]>(async () => {
        cancelled = true;
        return {
          accepted: false,
          reason: "active-turn",
          queueDisposition: "defer",
        };
      });
      const dispatcher = createQueueDispatcher({
        queue,
        recoverState: noop,
        executor: { execute },
        isCancellationRequested: () => cancelled,
        classifyQueuedItem: async (): Promise<QueueDispatchDisposition> => {
          if (stage === "classification") cancelled = true;
          return stage === "classification" ? "defer" : "ready";
        },
      });
      await dispatcher.dispatch("session-1");
      expect(queue.cancelClaim).toHaveBeenCalledWith({
        sessionId: "session-1",
        claimId: "claim-1",
      });
      expect(queue.release).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(stage === "admission" ? 1 : 0);
      await dispatcher.close();
    },
  );

  it("cancels a handoff preparation failure instead of retaining a cancelled item", async () => {
    const queue = dispatchQueue([]);
    let cancelled = false;
    const execute = vi.fn<QueueTurnExecutor["execute"]>(async () => {
      cancelled = true;
      return {
        accepted: false,
        reason: "policy:cloud-handoff:preparation-failed",
        queueDisposition: "cancel",
      };
    });
    const dispatcher = createQueueDispatcher({
      queue,
      executor: { execute },
      recoverState: noop,
      isCancellationRequested: () => cancelled,
    });

    await dispatcher.dispatch("session-1");

    expect(queue.cancelClaim).toHaveBeenCalledWith({
      sessionId: "session-1",
      claimId: "claim-1",
    });
    expect(queue.release).not.toHaveBeenCalled();
    expect(queue.reject).not.toHaveBeenCalled();
    await dispatcher.close();
  });
});

describe("QueueDispatcher cancellation on exceptions", () => {
  it.each(["classification", "execution"] as const)(
    "settles cancellation when %s throws after the request",
    async (stage) => {
      const queue = dispatchQueue([]);
      let cancelled = false;
      const execute = vi.fn<QueueTurnExecutor["execute"]>(async () => {
        cancelled = true;
        throw new Error("execution failed");
      });
      const dispatcher = createQueueDispatcher({
        queue,
        recoverState: noop,
        executor: { execute },
        isCancellationRequested: () => cancelled,
        classifyQueuedItem: async (): Promise<QueueDispatchDisposition> => {
          if (stage === "classification") {
            cancelled = true;
            throw new Error("classification failed");
          }
          return "ready";
        },
      });
      await expect(dispatcher.dispatch("session-1")).resolves.toBeUndefined();
      expect(queue.cancelClaim).toHaveBeenCalledOnce();
      expect(queue.release).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(stage === "execution" ? 1 : 0);
      await dispatcher.close();
    },
  );
});

describe("QueueDispatcher cancellation and durable delivery ownership", () => {
  it.each([false, true])(
    "only cancels a failed prepared claim while Queue still owns it (acknowledged=%s)",
    async (acknowledged) => {
      const queue = dispatchQueue([]);
      let cancelled = false;
      const failure = new Error("delivery failed");
      const onExecution = vi.fn();
      const execute = vi.fn<QueueTurnExecutor["execute"]>(async (input) => {
        await input.beforeSubmit?.("turn-1");
        if (acknowledged) {
          await input.onAccepted?.({
            accepted: true,
            turnId: "turn-1",
            acceptedAtMs: 100,
            completion: Promise.resolve({ status: "completed" }),
          });
          await input.beforeStart?.("turn-1");
        }
        cancelled = true;
        throw failure;
      });
      const dispatcher = createQueueDispatcher({
        queue,
        executor: { execute },
        recoverState: noop,
        onExecution,
        isCancellationRequested: () => cancelled,
      });
      const dispatched = dispatcher.dispatch("session-1");
      if (acknowledged) await expect(dispatched).rejects.toBe(failure);
      else await expect(dispatched).resolves.toBeUndefined();
      expect(queue.prepareDelivery).toHaveBeenCalledWith({
        sessionId: "session-1",
        claimId: "claim-1",
        turnId: "turn-1",
      });
      expect(queue.cancelClaim).toHaveBeenCalledTimes(acknowledged ? 0 : 1);
      expect(queue.acknowledge).toHaveBeenCalledTimes(acknowledged ? 1 : 0);
      expect(onExecution).toHaveBeenCalledTimes(acknowledged ? 1 : 0);
      expect(queue.release).not.toHaveBeenCalled();
      await dispatcher.close();
    },
  );
});

describe("QueueDispatcher", () => {
  it("keeps a busy cloud handoff queued and accepts it on a later wake", async () => {
    const queue = dispatchQueue([]);
    const execute = vi
      .fn<QueueTurnExecutor["execute"]>()
      .mockResolvedValueOnce({
        accepted: false,
        reason: "policy:cloud-handoff:session-busy",
        queueDisposition: "defer",
      })
      .mockResolvedValueOnce({
        accepted: true,
        turnId: "turn-handoff",
        acceptedAtMs: 100,
        completion: new Promise<never>(() => undefined),
      });
    const dispatcher = createQueueDispatcher({
      queue,
      executor: { execute },
      recoverState: noop,
    });
    await dispatcher.dispatch("session-1");
    expect(queue.release).toHaveBeenCalledOnce();
    expect(queue.acknowledge).not.toHaveBeenCalled();
    expect(queue.cancelClaim).not.toHaveBeenCalled();
    queue.claimNext.mockResolvedValueOnce(claim());
    await dispatcher.dispatch("session-1");
    expect(queue.acknowledge).toHaveBeenCalledWith({
      sessionId: "session-1",
      claimId: "claim-1",
      turnId: "turn-handoff",
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("claims one item and acknowledges only after durable Turn acceptance", async () => {
    const order: string[] = [];
    const completion = new Promise<never>(() => undefined);
    const queue = dispatchQueue(order);
    const execute = vi.fn(async () => {
      order.push("turn.accept");
      return {
        accepted: true as const,
        turnId: "turn-1",
        acceptedAtMs: 100,
        completion,
      };
    });
    const dispatcher = createQueueDispatcher({
      queue,
      executor: { execute },
      recoverState: noop,
    });

    await dispatcher.dispatch("session-1");

    expect(queue.claimNext).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(order).toEqual(["queue.claim", "turn.accept", "queue.ack"]);
    expect(queue.acknowledge).toHaveBeenCalledWith({
      sessionId: "session-1",
      claimId: "claim-1",
      turnId: "turn-1",
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateCreatedAtMs: 10,
        clientIntent: "plan-entry",
        input: {
          text: "queued-internal",
          attachments: [],
          channelContext: expect.objectContaining({
            platform: "wechat",
            chatId: "chat-1",
          }),
        },
        hideUserMessage: true,
        displayContent: "queued",
        displayAttachments: [
          {
            meta: { fileName: "queued.png", sizeBytes: 123 },
            cloud: {
              uploadId: "upload-1",
              url: "https://files.example/queued.png",
            },
          },
        ],
        ingress: expect.objectContaining({
          claimId: "claim-1",
          itemId: "item-1",
        }),
      }),
    );
  });

  it("restores the persisted input safety decision at Turn admission", async () => {
    const queue = dispatchQueue([]);
    const inputSafetyDecision = {
      inputDigest: `sha256:${"b".repeat(64)}`,
      outcome: "approved" as const,
    };
    queue.claimNext.mockReset().mockResolvedValueOnce({
      ...claim(),
      message: {
        ...claim().message,
        inputSafetyDecision,
      },
    });
    const execute = vi.fn(
      async (_input: Parameters<QueueTurnExecutor["execute"]>[0]) => ({
        accepted: true as const,
        turnId: "turn-1",
        acceptedAtMs: 100,
        completion: Promise.resolve({ status: "completed" as const }),
      }),
    );
    const dispatcher = createQueueDispatcher({
      queue,
      executor: { execute },
      recoverState: noop,
    });

    await dispatcher.dispatch("session-1");

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        inputSafetyDecision,
      }),
    );
  });

  it("restores a queued Goal verifier origin into task provenance", async () => {
    const queue = dispatchQueue([]);
    const origin = {
      goalVerifier: {
        runId: "run-verifier-1",
        profile: "goal-verifier-readonly",
      },
    };
    const base = claim();
    queue.claimNext.mockReset().mockResolvedValueOnce({
      ...base,
      source: "task",
      item: { ...base.item, source: "task" },
      message: { ...base.message, origin },
      provenance: {
        source: "task",
        routingFingerprint: "task:goal-verifier:run-verifier-1",
        sourceContext: { task: { parentSessionId: "session-parent" } },
      },
    });
    const execute = vi.fn(async () => ({
      accepted: true as const,
      turnId: "turn-verifier",
      acceptedAtMs: 100,
      completion: Promise.resolve({ status: "completed" as const }),
    }));
    const dispatcher = createQueueDispatcher({
      queue,
      executor: { execute },
      recoverState: noop,
    });

    await dispatcher.dispatch("session-1");

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        ingress: expect.objectContaining({
          provenance: {
            source: "task",
            routingFingerprint: "task:goal-verifier:run-verifier-1",
            sourceContext: {
              task: { parentSessionId: "session-parent" },
              origin,
            },
          },
        }),
      }),
    );
  });
});

describe("QueueDispatcher lifecycle", () => {
  it("serializes same-Session notifications and retains a completion wake during acknowledgement", async () => {
    const acknowledgementStarted = deferred();
    const finishAcknowledgement = deferred();
    let firstClaimed = false;
    let firstAcknowledged = false;
    let secondClaimed = false;
    const queue = dispatchQueue([]);
    queue.claimNext.mockReset().mockImplementation(async () => {
      if (!firstClaimed) {
        firstClaimed = true;
        return claim({ claimId: "claim-1", itemId: "item-1" });
      }
      if (!firstAcknowledged) return undefined;
      if (!secondClaimed) {
        secondClaimed = true;
        return claim({ claimId: "claim-2", itemId: "item-2" });
      }
      return undefined;
    });
    queue.acknowledge.mockReset().mockImplementation(async ({ claimId }) => {
      if (claimId !== "claim-1") return;
      acknowledgementStarted.resolve();
      await finishAcknowledgement.promise;
      firstAcknowledged = true;
    });
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        accepted: true,
        turnId: "turn-1",
        acceptedAtMs: 100,
        completion: Promise.resolve({ status: "completed" }),
      })
      .mockResolvedValueOnce({
        accepted: false,
        reason: "duplicate",
        turnId: "turn-2",
      });
    const dispatcher = createQueueDispatcher({
      queue,
      executor: { execute },
      recoverState: noop,
    });

    const initialWake = dispatcher.dispatch("session-1");
    await acknowledgementStarted.promise;
    const completionWake = dispatcher.dispatch("session-1");

    expect(queue.claimNext).toHaveBeenCalledTimes(1);
    finishAcknowledgement.resolve();
    await Promise.all([initialWake, completionWake]);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0]).toMatchObject({
      ingress: { claimId: "claim-2", itemId: "item-2" },
    });
  });

  it.each([
    ["active-turn", "release"],
    ["compaction-active", "release"],
    ["session-deleting", "release"],
    ["priority-blocked", "release"],
    ["invalid-session", "reject"],
    ["ingress-conflict", "reject"],
    ["invalid-input", "reject"],
  ] as const)("maps %s rejection to Queue %s", async (reason, action) => {
    const queue = dispatchQueue([]);
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: {
        execute: vi.fn(async () => ({ accepted: false as const, reason })),
      },
    });

    await dispatcher.dispatch("session-1");

    expect(queue[action]).toHaveBeenCalledOnce();
    expect(
      queue[action === "release" ? "reject" : "release"],
    ).not.toHaveBeenCalled();
  });

  it("acknowledges an exact duplicate receipt without running another Host", async () => {
    const queue = dispatchQueue([]);
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: {
        execute: vi.fn(async () => ({
          accepted: false as const,
          reason: "duplicate" as const,
          turnId: "turn-existing",
        })),
      },
    });

    await dispatcher.dispatch("session-1");

    expect(queue.acknowledge).toHaveBeenCalledWith({
      sessionId: "session-1",
      claimId: "claim-1",
      turnId: "turn-existing",
    });
  });

  it("releases the claim when Turn submission throws", async () => {
    const queue = dispatchQueue([]);
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: {
        execute: vi.fn(async () => {
          throw new Error("execute failed");
        }),
      },
    });

    await expect(dispatcher.dispatch("session-1")).rejects.toThrow(
      "execute failed",
    );
    expect(queue.release).toHaveBeenCalledOnce();
  });
});

describe("QueueDispatcher Goal claim classification", () => {
  it("defers an unready Goal kickoff without executing later Queue items", async () => {
    const queue = dispatchQueue([]);
    const execute = vi.fn();
    const classifyQueuedItem = vi.fn(async () => "defer" as const);
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: { execute },
      classifyQueuedItem,
    });

    await dispatcher.dispatch("session-1");

    expect(classifyQueuedItem).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "item-1" }),
    );
    expect(queue.release).toHaveBeenCalledWith({
      sessionId: "session-1",
      claimId: "claim-1",
    });
    expect(queue.cancelClaim).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(queue.claimNext).toHaveBeenCalledOnce();
  });

  it("cancels a stale Goal kickoff and continues draining the next FIFO item", async () => {
    const queue = dispatchQueue([]);
    queue.claimNext
      .mockReset()
      .mockResolvedValueOnce(
        claim({ claimId: "claim-stale", itemId: "item-stale" }),
      )
      .mockResolvedValueOnce(
        claim({ claimId: "claim-ready", itemId: "item-ready" }),
      )
      .mockResolvedValueOnce(undefined);
    const classifyQueuedItem = vi
      .fn()
      .mockResolvedValueOnce("cancel")
      .mockResolvedValueOnce("ready");
    const execute = vi.fn(
      async (_input: Parameters<QueueTurnExecutor["execute"]>[0]) => ({
        accepted: false as const,
        reason: "duplicate" as const,
        turnId: "turn-ready",
      }),
    );
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: { execute },
      classifyQueuedItem,
    });

    await dispatcher.dispatch("session-1");

    expect(queue.cancelClaim).toHaveBeenCalledWith({
      sessionId: "session-1",
      claimId: "claim-stale",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        ingress: expect.objectContaining({ claimId: "claim-ready" }),
      }),
    );
    expect(queue.acknowledge).toHaveBeenCalledWith({
      sessionId: "session-1",
      claimId: "claim-ready",
      turnId: "turn-ready",
    });
  });

  it("releases a claim when Goal classification fails", async () => {
    const queue = dispatchQueue([]);
    const failure = new Error("goal store unavailable");
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: { execute: vi.fn() },
      classifyQueuedItem: async () => {
        throw failure;
      },
    });

    await expect(dispatcher.dispatch("session-1")).rejects.toBe(failure);
    expect(queue.release).toHaveBeenCalledWith({
      sessionId: "session-1",
      claimId: "claim-1",
    });
    expect(queue.cancelClaim).not.toHaveBeenCalled();
  });

  it("releases a Goal claim when the final pre-LLM recheck defers it", async () => {
    const queue = dispatchQueue([]);
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: {
        execute: vi.fn(async () => ({
          accepted: false as const,
          reason: "policy:goal-final-recheck:deferred(plan)" as const,
          queueDisposition: "defer" as const,
        })),
      },
    });

    await dispatcher.dispatch("session-1");

    expect(queue.release).toHaveBeenCalledWith({
      sessionId: "session-1",
      claimId: "claim-1",
    });
    expect(queue.cancelClaim).not.toHaveBeenCalled();
    expect(queue.reject).not.toHaveBeenCalled();
  });

  it("cancels a stale final-recheck snapshot and continues draining", async () => {
    const queue = dispatchQueue([]);
    queue.claimNext
      .mockReset()
      .mockResolvedValueOnce(
        claim({ claimId: "claim-stale", itemId: "item-stale" }),
      )
      .mockResolvedValueOnce(
        claim({ claimId: "claim-ready", itemId: "item-ready" }),
      )
      .mockResolvedValueOnce(undefined);
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        accepted: false as const,
        reason: "policy:goal-final-recheck:stale(goal_epoch)" as const,
        queueDisposition: "cancel" as const,
      })
      .mockResolvedValueOnce({
        accepted: false as const,
        reason: "duplicate" as const,
        turnId: "turn-ready",
      });
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: { execute },
    });

    await dispatcher.dispatch("session-1");

    expect(queue.cancelClaim).toHaveBeenCalledWith({
      sessionId: "session-1",
      claimId: "claim-stale",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(queue.acknowledge).toHaveBeenCalledWith({
      sessionId: "session-1",
      claimId: "claim-ready",
      turnId: "turn-ready",
    });
  });
});

describe("QueueDispatcher acknowledgement recovery", () => {
  it("recovers an accepted claim before the next dispatch after acknowledgement retry fails", async () => {
    const order: string[] = [];
    const queue = dispatchQueue(order);
    queue.acknowledge.mockImplementation(async () => {
      order.push("queue.ack");
      throw new Error("ack failed");
    });
    queue.recoverClaims.mockImplementation(async () => {
      order.push("queue.recover");
    });
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: {
        execute: vi.fn(async () => ({
          accepted: true as const,
          turnId: "turn-1",
          acceptedAtMs: 100,
          completion: Promise.resolve({ status: "completed" as const }),
        })),
      },
    });

    await expect(dispatcher.dispatch("session-1")).rejects.toThrow(
      "ack failed",
    );
    expect(queue.acknowledge).toHaveBeenCalledTimes(2);
    expect(queue.release).not.toHaveBeenCalled();

    queue.claimNext.mockImplementationOnce(async () => {
      order.push("queue.claim-after-failure");
      return undefined;
    });
    await dispatcher.dispatch("session-1");

    expect(queue.recoverClaims).toHaveBeenCalledWith("session-1");
    expect(order.slice(-2)).toEqual([
      "queue.recover",
      "queue.claim-after-failure",
    ]);
  });

  it("continues draining after duplicate acknowledgement", async () => {
    const queue = dispatchQueue([]);
    queue.claimNext
      .mockReset()
      .mockResolvedValueOnce(claim({ claimId: "claim-1", itemId: "item-1" }))
      .mockResolvedValueOnce(claim({ claimId: "claim-2", itemId: "item-2" }))
      .mockResolvedValueOnce(undefined);
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        accepted: false,
        reason: "duplicate",
        turnId: "turn-1",
      })
      .mockResolvedValueOnce({
        accepted: false,
        reason: "duplicate",
        turnId: "turn-2",
      });
    const dispatcher = createQueueDispatcher({
      queue,
      executor: { execute },
      recoverState: noop,
    });

    await dispatcher.dispatch("session-1");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(queue.acknowledge).toHaveBeenCalledTimes(2);
    expect(queue.claimNext).toHaveBeenCalledTimes(3);
  });
});

describe("QueueDispatcher stopped admission", () => {
  it("leaves the next FIFO item for an explicit wake after admission is stopped", async () => {
    const queue = dispatchQueue([]);
    queue.claimNext
      .mockReset()
      .mockResolvedValueOnce(
        claim({ claimId: "claim-stopped", itemId: "item-stopped" }),
      )
      .mockResolvedValueOnce(
        claim({ claimId: "claim-next", itemId: "item-next" }),
      )
      .mockResolvedValueOnce(undefined);
    const executed: string[] = [];
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: {
        execute: async (input) => {
          executed.push(input.ingress.claimId);
          return input.ingress.claimId === "claim-stopped"
            ? {
                accepted: false,
                reason: "policy:turn-abort:pre-admission",
                queueDisposition: "cancel",
              }
            : { accepted: false, reason: "duplicate", turnId: "turn-next" };
        },
      },
    });

    await dispatcher.dispatch("session-1");
    expect(executed).toEqual(["claim-stopped"]);
    await dispatcher.dispatch("session-1");
    expect(executed).toEqual(["claim-stopped", "claim-next"]);
  });
});

describe("QueueDispatcher lifecycle fencing", () => {
  it("explicitly continues the paused FIFO head without pre-clearing QueuePaused", async () => {
    const queue = dispatchQueue([]);
    queue.claimNext
      .mockReset()
      .mockResolvedValueOnce(claim({ selection: "continued-fifo" }))
      .mockResolvedValue(undefined);
    const execute = vi.fn(async () => ({
      accepted: true as const,
      turnId: "turn-continued",
      acceptedAtMs: 100,
      completion: Promise.resolve({ status: "completed" as const }),
    }));
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: { execute },
    });

    await expect(dispatcher.continuePaused("session-1")).resolves.toEqual({
      status: "started",
      mode: "accepted",
      queueItemId: "item-1",
      turnId: "turn-continued",
    });

    expect(queue.claimNext).toHaveBeenCalledWith({
      sessionId: "session-1",
      continuePaused: true,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ queueSelection: "continued-fifo" }),
    );
    expect(queue.acknowledge).toHaveBeenCalledWith({
      sessionId: "session-1",
      claimId: "claim-1",
      turnId: "turn-continued",
    });
  });

  it("shares one explicit Continue attempt across repeated same-Session clicks", async () => {
    const claimStarted = deferred();
    const finishClaim = deferredValue<ReturnType<typeof claim>>();
    const queue = dispatchQueue([]);
    queue.claimNext.mockReset().mockImplementation(async () => {
      claimStarted.resolve();
      return finishClaim.promise;
    });
    const execute = vi.fn(async () => ({
      accepted: false as const,
      reason: "active-turn" as const,
    }));
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: { execute },
    });

    const first = dispatcher.continuePaused("session-1");
    await claimStarted.promise;
    const repeated = dispatcher.continuePaused("session-1");

    expect(repeated).toBe(first);
    finishClaim.resolve(claim({ selection: "continued-fifo" }));
    await expect(Promise.all([first, repeated])).resolves.toEqual([
      { status: "rejected", queueItemId: "item-1", reason: "active-turn" },
      { status: "rejected", queueItemId: "item-1", reason: "active-turn" },
    ]);
    expect(queue.claimNext).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(queue.release).toHaveBeenCalledOnce();
  });
});

describe("QueueDispatcher lifecycle fencing", () => {
  it("releases a claim acquired during shutdown and rejects future dispatch work", async () => {
    const claimStarted = deferred();
    const finishClaim = deferredValue<ReturnType<typeof claim>>();
    const queue = dispatchQueue([]);
    queue.claimNext.mockReset().mockImplementation(async () => {
      claimStarted.resolve();
      return finishClaim.promise;
    });
    const execute = vi.fn();
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: { execute },
    });
    const wake = dispatcher.dispatch("session-1");
    await claimStarted.promise;
    const closing = dispatcher.close();
    finishClaim.resolve(claim());

    await expect(wake).resolves.toBeUndefined();
    await expect(closing).resolves.toBeUndefined();
    await expect(dispatcher.close()).resolves.toBeUndefined();
    expect(queue.release).toHaveBeenCalledWith({
      sessionId: "session-1",
      claimId: "claim-1",
    });
    expect(execute).not.toHaveBeenCalled();
    await expect(dispatcher.dispatch("session-1")).rejects.toThrow(
      "Queue dispatcher is shutting down",
    );
    await expect(
      dispatcher.recoverPending({ processStartedAtMs: 10 }),
    ).rejects.toThrow("Queue dispatcher is shutting down");
  });

  it("releases a raced claim and permanently stops dispatch for a deleting Session", async () => {
    const claimStarted = deferred();
    const finishClaim = deferredValue<ReturnType<typeof claim>>();
    const queue = dispatchQueue([]);
    queue.claimNext.mockReset().mockImplementation(async () => {
      claimStarted.resolve();
      return finishClaim.promise;
    });
    const execute = vi.fn();
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: { execute },
    });
    const wake = dispatcher.dispatch("session-1");
    await claimStarted.promise;
    const quiescent = dispatcher.quiesceSession("session-1");
    finishClaim.resolve(claim());

    await expect(wake).resolves.toBeUndefined();
    await expect(quiescent).resolves.toBeUndefined();
    expect(queue.release).toHaveBeenCalledWith({
      sessionId: "session-1",
      claimId: "claim-1",
    });
    expect(execute).not.toHaveBeenCalled();

    await expect(dispatcher.dispatch("session-1")).resolves.toBeUndefined();
    expect(queue.claimNext).toHaveBeenCalledTimes(1);
  });
});

describe("QueueDispatcher claim validation and startup recovery", () => {
  it("restores Background origin only from a consistently trusted persisted source", async () => {
    const queue = dispatchQueue([]);
    const base = claim();
    queue.claimNext
      .mockReset()
      .mockResolvedValueOnce({
        ...base,
        source: "background-task",
        item: { ...base.item, source: "background-task" },
        message: {
          ...base.message,
          origin: {
            kind: "background-task-terminal",
            taskIds: ["task-1"],
            observedTerminalCount: 4,
          },
        },
        provenance: {
          source: "background-task",
          routingFingerprint: "background-task:task-1",
        },
      })
      .mockResolvedValue(undefined);
    const execute = vi.fn(
      async (_input: Parameters<QueueTurnExecutor["execute"]>[0]) => ({
        accepted: false as const,
        reason: "duplicate" as const,
        turnId: "turn-background",
      }),
    );
    const dispatcher = createQueueDispatcher({
      queue,
      executor: { execute },
      recoverState: noop,
    });

    await dispatcher.dispatch("session-1");

    expect(execute.mock.calls[0]?.[0].input).toMatchObject({
      origin: {
        kind: "background-task-terminal",
        taskIds: ["task-1"],
        observedTerminalCount: 4,
      },
    });
  });

  it.each([
    [
      "empty task IDs",
      {
        kind: "background-task-terminal",
        taskIds: [],
        observedTerminalCount: 4,
      },
    ],
    [
      "blank task ID",
      {
        kind: "background-task-terminal",
        taskIds: [" "],
        observedTerminalCount: 4,
      },
    ],
    [
      "extra key",
      {
        kind: "background-task-terminal",
        taskIds: ["task-1"],
        observedTerminalCount: 4,
        extra: true,
      },
    ],
    [
      "invalid count",
      {
        kind: "background-task-terminal",
        taskIds: ["task-1"],
        observedTerminalCount: -1,
      },
    ],
  ] as const)(
    "continues dispatch without promoting trusted corrupt Background origin with %s",
    async (_label, origin) => {
      const queue = dispatchQueue([]);
      const base = claim();
      queue.claimNext
        .mockReset()
        .mockResolvedValueOnce({
          ...base,
          source: "background-task",
          item: { ...base.item, source: "background-task" },
          message: { ...base.message, origin },
          provenance: {
            source: "background-task",
            routingFingerprint: "background-task:corrupt",
          },
        } as never)
        .mockResolvedValue(undefined);
      const execute = vi.fn(
        async (_input: Parameters<QueueTurnExecutor["execute"]>[0]) => ({
          accepted: false as const,
          reason: "duplicate" as const,
          turnId: "turn-corrupt",
        }),
      );
      const dispatcher = createQueueDispatcher({
        queue,
        executor: { execute },
        recoverState: noop,
      });

      await expect(dispatcher.dispatch("session-1")).resolves.toBeUndefined();
      expect(execute.mock.calls[0]?.[0].input).not.toHaveProperty("origin");
    },
  );

  it.each([
    ["claim", { source: "background-task" }],
    ["item", { itemSource: "background-task" }],
    ["provenance", { provenanceSource: "background-task" }],
  ] as const)(
    "rejects a forged Background origin with only trusted %s source",
    async (_name, patch) => {
      const queue = dispatchQueue([]);
      const base = claim();
      queue.claimNext
        .mockReset()
        .mockResolvedValueOnce({
          ...base,
          ...("source" in patch ? { source: patch.source } : {}),
          item: {
            ...base.item,
            ...("itemSource" in patch ? { source: patch.itemSource } : {}),
          },
          message: {
            ...base.message,
            origin: {
              kind: "background-task-terminal",
              taskIds: ["task-1"],
              observedTerminalCount: 4,
            },
          },
          provenance: {
            ...base.provenance,
            ...("provenanceSource" in patch
              ? { source: patch.provenanceSource }
              : {}),
          },
        } as never)
        .mockResolvedValue(undefined);
      const execute = vi.fn(
        async (_input: Parameters<QueueTurnExecutor["execute"]>[0]) => ({
          accepted: false as const,
          reason: "duplicate" as const,
          turnId: "turn-forged",
        }),
      );
      const dispatcher = createQueueDispatcher({
        queue,
        executor: { execute },
        recoverState: noop,
      });

      await dispatcher.dispatch("session-1");

      expect(execute.mock.calls[0]?.[0].input).not.toHaveProperty("origin");
    },
  );
});

describe("QueueDispatcher startup recovery", () => {
  it("preserves optional Queue execution context without inventing display controls", async () => {
    const queue = dispatchQueue([]);
    const base = claim();
    queue.claimNext
      .mockReset()
      .mockResolvedValueOnce({
        ...base,
        clientRequestId: undefined,
        item: {
          ...base.item,
          channelContext: undefined,
          model: {
            provider_id: "provider",
            model_id: "model",
            variant: "",
            thinking: { effort: "max" },
          },
        },
        message: {
          content: "rich input",
          attachments: [{ type: "file", fileName: "notes.txt" }],
          origin: { source: "channel" },
          channelContext: {
            platform: "feishu",
            chatId: "chat-2",
            senderId: "user-2",
            sourceMessageId: "message-2",
            channel: "feishu",
            channel_id: "chat-2",
          },
          quotedMessage: { text: "quoted", senderName: "sender" },
        },
      } as never)
      .mockResolvedValue(undefined);
    const execute = vi.fn(async () => ({
      accepted: true as const,
      turnId: "turn-rich",
      acceptedAtMs: 100,
      completion: Promise.resolve({ status: "completed" as const }),
    }));
    const dispatcher = createQueueDispatcher({
      queue,
      executor: { execute },
      recoverState: noop,
    });

    await dispatcher.dispatch("session-1");

    expect(execute).toHaveBeenCalledWith({
      userMessageId: expect.stringMatching(/^msg-user-v1-/),
      onAccepted: expect.any(Function),
      beforeSubmit: expect.any(Function),
      beforeStart: expect.any(Function),
      sessionId: "session-1",
      candidateCreatedAtMs: 10,
      queueSelection: "fifo",
      input: {
        text: "rich input",
        attachments: [{ type: "file", fileName: "notes.txt" }],
        channelContext: {
          platform: "feishu",
          chatId: "chat-2",
          senderId: "user-2",
          sourceMessageId: "message-2",
          channel: "feishu",
          channel_id: "chat-2",
        },
        quotedMessage: { text: "quoted", senderName: "sender" },
        model: {
          providerId: "provider",
          modelId: "model",
          variant: "",
          thinking: { effort: "max" },
        },
      },
      ingress: {
        userMessageId: expect.stringMatching(/^msg-user-v1-/),
        claimId: "claim-1",
        itemId: "item-1",
        provenance: {
          source: "channel:wechat",
          routingFingerprint: "route-1",
          sourceContext: { origin: { source: "channel" } },
        },
      },
    });
  });

  it("recovers startup Queue claims without dispatching pending messages", async () => {
    const order: string[] = [];
    const queue = dispatchQueue(order);
    queue.listPendingSessionIds.mockResolvedValue(["session-1", "session-2"]);
    queue.recoverClaims.mockImplementation(async (sessionId) => {
      order.push(`queue.recover:${sessionId}`);
    });
    queue.claimNext.mockReset().mockImplementation(async ({ sessionId }) => {
      order.push(`queue.claim:${sessionId}`);
      return undefined;
    });
    const dispatcher = createQueueDispatcher({
      queue,
      executor: { execute: vi.fn() },
      recoverState: async () => {
        order.push("ingress.recover");
      },
    });

    await dispatcher.recoverPending({ processStartedAtMs: 100 });

    expect(order).toEqual([
      "ingress.recover",
      "queue.recover:session-1",
      "queue.recover:session-2",
    ]);
    expect(queue.recoverClaims).toHaveBeenNthCalledWith(1, "session-1", {
      claimedAtOrBeforeMs: 100,
    });
    expect(queue.recoverClaims).toHaveBeenNthCalledWith(2, "session-2", {
      claimedAtOrBeforeMs: 100,
    });
    expect(queue.claimNext).not.toHaveBeenCalled();

    await dispatcher.dispatch("session-1");

    expect(order).toEqual([
      "ingress.recover",
      "queue.recover:session-1",
      "queue.recover:session-2",
      "queue.claim:session-1",
    ]);
  });
});

describe("QueueDispatcher FIFO yield", () => {
  it("runs queued user work while the deferred Goal item keeps its place", async () => {
    const { queue, queuedItemIds } = fifoDispatchQueue([
      { itemId: "goal-1", source: "thread-goal" },
      { itemId: "user-1", source: "api" },
    ]);
    const executed: string[] = [];
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: { execute: recordingExecutor(executed) },
      classifyQueuedItem: (item) =>
        item.source === "thread-goal" ? "defer" : "ready",
      shouldYieldFifoPosition: (item) => item.source === "thread-goal",
    });

    await dispatcher.dispatch("session-1");

    expect(executed).toEqual(["user-1"]);
    expect(queue.claimNext).toHaveBeenNthCalledWith(2, {
      sessionId: "session-1",
      excludeItemIds: ["goal-1"],
    });
    // The Goal item is released, never cancelled: its kickoff survives.
    expect(queue.cancelClaim).not.toHaveBeenCalled();
    expect(queuedItemIds()).toEqual(["goal-1"]);
    await dispatcher.close();
  });

  it("hands the yielded identities to the executor so Turn admission can fence past them", async () => {
    // The yield only works if the admitting transaction learns the same fact:
    // its priority fence blocks a FIFO claim on any older queued row, which is
    // exactly the row selection just skipped.
    const { queue } = fifoDispatchQueue([
      { itemId: "goal-1", source: "thread-goal" },
      { itemId: "user-1", source: "api" },
    ]);
    const execute = recordingExecutor([]);
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: { execute },
      classifyQueuedItem: (item) =>
        item.source === "thread-goal" ? "defer" : "ready",
      shouldYieldFifoPosition: (item) => item.source === "thread-goal",
    });

    await dispatcher.dispatch("session-1");

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      queueSelection: "fifo",
      yieldedQueueItemIds: ["goal-1"],
    });
    await dispatcher.close();
  });

  it("omits the yield fact entirely when nothing yielded", async () => {
    const { queue } = fifoDispatchQueue([{ itemId: "user-1", source: "api" }]);
    const execute = recordingExecutor([]);
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: { execute },
      shouldYieldFifoPosition: () => true,
    });

    await dispatcher.dispatch("session-1");

    expect(execute.mock.calls[0]?.[0].yieldedQueueItemIds).toBeUndefined();
    await dispatcher.close();
  });
});

/**
 * The second defer point: the blocker only appears between queue classification
 * and the in-transaction final recheck, so the item is deferred by admission
 * rather than by classification.
 */
describe("QueueDispatcher admission-stage FIFO yield", () => {
  it("yields when the blocker only appears at the final admission recheck", async () => {
    // Second defer point: classification saw no blocker, so the item was
    // dispatched, and only the in-transaction recheck deferred it. Without the
    // same yield here the parked item holds the head for the rest of the pass.
    const { queue, queuedItemIds } = fifoDispatchQueue([
      { itemId: "goal-1", source: "thread-goal" },
      { itemId: "user-1", source: "api" },
    ]);
    const executed: string[] = [];
    const execute = vi.fn<QueueTurnExecutor["execute"]>(async (input) => {
      if (input.ingress.itemId === "goal-1") {
        return {
          accepted: false,
          reason: "active-turn",
          queueDisposition: "defer",
        };
      }
      executed.push(input.ingress.itemId);
      return {
        accepted: true,
        turnId: `turn-${input.ingress.itemId}`,
        acceptedAtMs: 100,
        completion: Promise.resolve({ status: "completed" }),
      };
    });
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: { execute },
      shouldYieldFifoPosition: (item) => item.source === "thread-goal",
    });

    await dispatcher.dispatch("session-1");

    expect(executed).toEqual(["user-1"]);
    expect(queue.claimNext).toHaveBeenNthCalledWith(2, {
      sessionId: "session-1",
      excludeItemIds: ["goal-1"],
    });
    // Still released rather than cancelled, so the Goal keeps its item.
    expect(queue.cancelClaim).not.toHaveBeenCalled();
    expect(queuedItemIds()).toEqual(["goal-1"]);
    await dispatcher.close();
  });

  it("keeps parking an admission-deferred item that policy will not yield", async () => {
    const { queue, queuedItemIds } = fifoDispatchQueue([
      { itemId: "goal-1", source: "thread-goal" },
      { itemId: "user-1", source: "api" },
    ]);
    const execute = vi.fn<QueueTurnExecutor["execute"]>(async () => ({
      accepted: false,
      reason: "active-turn",
      queueDisposition: "defer",
    }));
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: { execute },
      shouldYieldFifoPosition: () => false,
    });

    await dispatcher.dispatch("session-1");

    expect(queue.claimNext).toHaveBeenCalledOnce();
    expect(queuedItemIds()).toEqual(["goal-1", "user-1"]);
    await dispatcher.close();
  });

  it("parks the deferred head unchanged when nothing may preempt it", async () => {
    const { queue, queuedItemIds } = fifoDispatchQueue([
      { itemId: "goal-1", source: "thread-goal" },
    ]);
    const execute = recordingExecutor([]);
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: { execute },
      classifyQueuedItem: () => "defer",
      shouldYieldFifoPosition: () => false,
    });

    await dispatcher.dispatch("session-1");

    expect(queue.claimNext).toHaveBeenCalledOnce();
    expect(queue.claimNext).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(queue.release).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(queuedItemIds()).toEqual(["goal-1"]);
    await dispatcher.close();
  });

  it("claims the yielded Goal item again on the next wake once its blocker clears", async () => {
    const { queue, queuedItemIds } = fifoDispatchQueue([
      { itemId: "goal-1", source: "thread-goal" },
      { itemId: "user-1", source: "api" },
    ]);
    const executed: string[] = [];
    let blocked = true;
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: { execute: recordingExecutor(executed) },
      classifyQueuedItem: (item) =>
        blocked && item.source === "thread-goal" ? "defer" : "ready",
      shouldYieldFifoPosition: (item) => item.source === "thread-goal",
    });

    await dispatcher.dispatch("session-1");
    blocked = false;
    // The dependency-release wake re-examines every blocker from an empty
    // exclusion set, so the parked Goal continues without any user message.
    await dispatcher.dispatch("session-1");

    expect(executed).toEqual(["user-1", "goal-1"]);
    expect(queuedItemIds()).toEqual([]);
    await dispatcher.close();
  });

  it("ends the pass after every candidate yielded, without reclaiming them", async () => {
    const { queue, queuedItemIds } = fifoDispatchQueue([
      { itemId: "goal-1", source: "thread-goal" },
      { itemId: "goal-2", source: "thread-goal" },
    ]);
    const execute = recordingExecutor([]);
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: { execute },
      classifyQueuedItem: () => "defer",
      shouldYieldFifoPosition: () => true,
    });

    await dispatcher.dispatch("session-1");

    expect(queue.claimNext).toHaveBeenCalledTimes(3);
    expect(queue.claimNext).toHaveBeenNthCalledWith(3, {
      sessionId: "session-1",
      excludeItemIds: ["goal-1", "goal-2"],
    });
    expect(queue.release).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(queuedItemIds()).toEqual(["goal-1", "goal-2"]);
    await dispatcher.close();
  });

  it.each(["exact", "continued-fifo"] as const)(
    "never yields a %s selection",
    async (selection) => {
      const queue = dispatchQueue([]);
      queue.claimNext
        .mockReset()
        .mockResolvedValueOnce({
          ...claim({ source: "thread-goal" }),
          selection,
        })
        .mockResolvedValue(undefined);
      const shouldYieldFifoPosition = vi.fn(() => true);
      const dispatcher = createQueueDispatcher({
        queue,
        recoverState: noop,
        executor: { execute: recordingExecutor([]) },
        classifyQueuedItem: () => "defer",
        shouldYieldFifoPosition,
      });

      await dispatcher.dispatch("session-1");

      expect(shouldYieldFifoPosition).not.toHaveBeenCalled();
      expect(queue.release).toHaveBeenCalledOnce();
      expect(queue.claimNext).toHaveBeenCalledOnce();
      await dispatcher.close();
    },
  );

  it("keeps the park when the yield policy cannot be read", async () => {
    const { queue, queuedItemIds } = fifoDispatchQueue([
      { itemId: "goal-1", source: "thread-goal" },
      { itemId: "user-1", source: "api" },
    ]);
    const execute = recordingExecutor([]);
    const dispatcher = createQueueDispatcher({
      queue,
      recoverState: noop,
      executor: { execute },
      classifyQueuedItem: (item) =>
        item.source === "thread-goal" ? "defer" : "ready",
      shouldYieldFifoPosition: () => {
        throw new Error("queue read failed");
      },
    });

    await dispatcher.dispatch("session-1");

    expect(queue.claimNext).toHaveBeenCalledOnce();
    expect(queue.release).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(queuedItemIds()).toEqual(["goal-1", "user-1"]);
    await dispatcher.close();
  });
});

/** FIFO Queue double whose release returns an item to its original position. */
function fifoDispatchQueue(
  items: readonly {
    readonly itemId: string;
    readonly source: "thread-goal" | "api";
  }[],
) {
  const order = items.map((item) => item.itemId);
  const sources = new Map(items.map((item) => [item.itemId, item.source]));
  const consumed = new Set<string>();
  const claimed = new Map<string, string>();
  let claimSeq = 0;
  const settle = (claimId: string, consume: boolean) => {
    const itemId = claimed.get(claimId);
    if (itemId && consume) consumed.add(itemId);
    claimed.delete(claimId);
  };
  const queue = {
    claimNext: vi.fn<QueueDispatchCapability["claimNext"]>(
      async ({ excludeItemIds }) => {
        if (claimed.size > 0) return undefined;
        const excluded = new Set(excludeItemIds ?? []);
        const itemId = order.find(
          (id) => !consumed.has(id) && !excluded.has(id),
        );
        if (!itemId) return undefined;
        const claimId = `claim-${++claimSeq}`;
        claimed.set(claimId, itemId);
        return claim({ claimId, itemId, source: sources.get(itemId) });
      },
    ),
    prepareDelivery: vi.fn<QueueDispatchCapability["prepareDelivery"]>(
      async () => undefined,
    ),
    acknowledge: vi.fn<QueueDispatchCapability["acknowledge"]>(
      async ({ claimId }) => {
        settle(claimId, true);
      },
    ),
    release: vi.fn<QueueDispatchCapability["release"]>(async ({ claimId }) => {
      settle(claimId, false);
    }),
    cancelClaim: vi.fn<QueueDispatchCapability["cancelClaim"]>(
      async ({ claimId }) => {
        settle(claimId, true);
      },
    ),
    consume: vi.fn<QueueDispatchCapability["consume"]>(async ({ claimId }) => {
      settle(claimId, true);
    }),
    reject: vi.fn<QueueDispatchCapability["reject"]>(async ({ claimId }) => {
      settle(claimId, true);
    }),
    listPendingSessionIds: vi.fn<
      QueueDispatchCapability["listPendingSessionIds"]
    >(async () => []),
    recoverClaims: vi.fn<QueueDispatchCapability["recoverClaims"]>(
      async () => undefined,
    ),
  } satisfies QueueDispatchCapability;
  return {
    queue,
    queuedItemIds: () => order.filter((id) => !consumed.has(id)),
  };
}

function recordingExecutor(executed: string[]) {
  return vi.fn<QueueTurnExecutor["execute"]>(async (input) => {
    executed.push(input.ingress.itemId);
    return {
      accepted: true,
      turnId: `turn-${input.ingress.itemId}`,
      acceptedAtMs: 100,
      completion: Promise.resolve({ status: "completed" }),
    };
  });
}

function dispatchQueue(order: string[]) {
  return {
    claimNext: vi
      .fn<QueueDispatchCapability["claimNext"]>()
      .mockImplementationOnce(async () => {
        order.push("queue.claim");
        return claim();
      })
      .mockResolvedValue(undefined),
    prepareDelivery: vi.fn<QueueDispatchCapability["prepareDelivery"]>(
      async () => undefined,
    ),
    acknowledge: vi.fn<QueueDispatchCapability["acknowledge"]>(async () => {
      order.push("queue.ack");
    }),
    release: vi.fn(async () => {
      order.push("queue.release");
    }),
    cancelClaim: vi.fn(async () => {
      order.push("queue.cancel");
    }),
    consume: vi.fn(async () => {
      order.push("queue.consume");
    }),
    reject: vi.fn(async () => {
      order.push("queue.reject");
    }),
    listPendingSessionIds: vi.fn<
      QueueDispatchCapability["listPendingSessionIds"]
    >(async () => []),
    recoverClaims: vi.fn<QueueDispatchCapability["recoverClaims"]>(
      async () => undefined,
    ),
  } satisfies QueueDispatchCapability;
}

function claim(
  overrides: {
    readonly claimId?: string;
    readonly itemId?: string;
    readonly selection?: "fifo" | "exact" | "continued-fifo";
    readonly source?: "channel:wechat" | "thread-goal" | "api";
  } = {},
) {
  const source = overrides.source ?? ("channel:wechat" as const);
  return {
    claimId: overrides.claimId ?? "claim-1",
    sessionId: "session-1",
    source,
    claimOwnerId: "queue-claim:42:runtime.operation",
    claimLeaseExpiresAt: 40,
    selection: overrides.selection ?? "fifo",
    item: {
      itemId: overrides.itemId ?? "item-1",
      sessionId: "session-1",
      agentName: "general",
      source,
      status: "claimed" as const,
      message: { content: "queued", attachments: [] },
      channelContext: {
        platform: "wechat",
        chatType: "group",
        chatId: "chat-1",
        senderId: "user-1",
        clientName: "wechat",
        contextToken: "context-1",
      },
      createdAt: 10,
    },
    message: {
      content: "queued-internal",
      clientIntent: "plan-entry",
      attachments: [],
      hideUserMessage: true,
      displayContent: "queued",
      displayAttachments: [
        {
          meta: { fileName: "queued.png", sizeBytes: 123 },
          cloud: {
            uploadId: "upload-1",
            url: "https://files.example/queued.png",
          },
        },
      ],
    },
    clientRequestId: "wx-1",
    provenance: { source, routingFingerprint: "route-1" },
  };
}

function deferred() {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

function deferredValue<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value: T) => resolvePromise?.(value) };
}

async function noop(): Promise<void> {}
