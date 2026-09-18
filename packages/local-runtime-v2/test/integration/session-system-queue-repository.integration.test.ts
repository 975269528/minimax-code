import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import type { AppDb } from "../../src/infra/db/client.js";
import { DatabaseClient } from "../../src/infra/db/client.js";
import { initializeDatabase } from "../../src/infra/db/initialize.js";
import {
  legacyQueues,
  queueItems,
  queueRowMigrations,
} from "../../src/infra/db/schema/queue.js";
import {
  createQueueRepository,
  createQueueTurnAdmissionPriorityFence,
  QueueClaimNotAcceptedError,
  QueueDataCorruptionError,
  QueueEnqueueAdmissionError,
  type QueueClaimAcceptanceQuery,
  type QueueRepository,
} from "../../src/service/session-system/index.js";
import { createTurnRepository } from "../../src/service/turn-system/persistence/turn.repository.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("QueueRepository front placement", () => {
  it("retains content and intent when releasing a failed policy query, with a committed reason", async () => {
    const { client } = await setup();
    const repository = createQueueRepository({ db: client.db, nowMs: () => 1 });
    const enqueued = await repository.enqueue({
      ...input("continue in cloud", "handoff"),
      message: {
        ...message("continue in cloud"),
        clientIntent: "cloud-handoff",
      },
    });
    const claim = (await repository.claimNext({ sessionId: "s1" })).value;
    if (!claim || !enqueued.value) throw new Error("Missing queue fixture");
    const reason = "policy:cloud-handoff:preparation-failed";
    const result = await repository.releaseClaim("s1", claim.claimId, reason);
    expect(result.facts).toContainEqual(
      expect.objectContaining({
        kind: "requeued",
        admissionReason: reason,
        itemId: enqueued.value.item.itemId,
      }),
    );
    expect((await repository.list("s1")).value).toEqual([
      expect.objectContaining({
        status: "queued",
        message: expect.objectContaining({
          content: "continue in cloud",
          clientIntent: "cloud-handoff",
        }),
      }),
    ]);
  });
  it("atomically places a front enqueue ahead of queued work and re-applies it on replay", async () => {
    const { queue } = await setup();
    const first = await queue.enqueue(input("first", "first"));
    const second = await queue.enqueue(input("second", "second"));
    const implementation = await queue.enqueue({
      ...input("implementation", "implementation"),
      clientRequestId: "mavis-internal:plan-review:review-1",
      queuePlacement: "front",
    });
    if (!first || !second || !implementation)
      throw new Error("Queue fixture missing");

    expect(implementation.position).toBe(1);
    expect((await queue.list("s1")).map((item) => item.itemId)).toEqual([
      implementation.item.itemId,
      first.item.itemId,
      second.item.itemId,
    ]);

    await queue.reorder({
      sessionId: "s1",
      itemIds: [
        first.item.itemId,
        second.item.itemId,
        implementation.item.itemId,
      ],
    });
    const replay = await queue.enqueue({
      ...input("ignored replay content", "ignored-replay"),
      clientRequestId: "mavis-internal:plan-review:review-1",
      queuePlacement: "front",
    });

    expect(replay?.position).toBe(1);
    expect((await queue.list("s1")).map((item) => item.itemId)).toEqual([
      implementation.item.itemId,
      first.item.itemId,
      second.item.itemId,
    ]);
  });

  it("fails closed instead of inserting at front while another item is claimed", async () => {
    const { queue } = await setup();
    await queue.enqueue(input("claimed", "claimed"));
    const claim = await queue.claimNext({ sessionId: "s1" });
    if (!claim) throw new Error("Queue claim missing");

    await expect(
      queue.enqueue({
        ...input("implementation", "implementation"),
        clientRequestId: "mavis-internal:plan-review:review-1",
        queuePlacement: "front",
      }),
    ).resolves.toBeUndefined();
    await queue.releaseClaim("s1", claim.claimId);

    const retry = await queue.enqueue({
      ...input("implementation", "implementation"),
      clientRequestId: "mavis-internal:plan-review:review-1",
      queuePlacement: "front",
    });
    expect(retry?.position).toBe(1);
    expect(
      (await queue.list("s1")).map((item) => item.message.content),
    ).toEqual(["implementation", "claimed"]);
  });
});

describe("QueueRepository", () => {
  it("skips excluded items and claims the first remaining queued item in FIFO order", async () => {
    const { queue } = await setup();
    const first = await queue.enqueue(input("first", "first"));
    const second = await queue.enqueue(input("second", "second"));
    const third = await queue.enqueue(input("third", "third"));
    if (!first || !second || !third) throw new Error("Queue fixture missing");

    const selected = await queue.claimNext({
      sessionId: "s1",
      excludeItemIds: [first.item.itemId],
      nowMs: 10,
    });

    // Selection stays FIFO, the excluded item keeps its place and its identity.
    expect(selected).toMatchObject({
      selection: "fifo",
      item: { itemId: second.item.itemId },
    });
    if (!selected) throw new Error("Queue claim missing");
    await queue.releaseClaim("s1", selected.claimId);
    expect((await queue.list("s1")).map((item) => item.itemId)).toEqual([
      first.item.itemId,
      second.item.itemId,
      third.item.itemId,
    ]);
    expect(
      await queue.claimNext({
        sessionId: "s1",
        excludeItemIds: [first.item.itemId, second.item.itemId],
        nowMs: 10,
      }),
    ).toMatchObject({ item: { itemId: third.item.itemId } });
  });

  it("claims nothing once every queued item is excluded", async () => {
    const { queue } = await setup();
    const only = await queue.enqueue(input("only", "only"));
    if (!only) throw new Error("Queue fixture missing");

    expect(
      await queue.claimNext({
        sessionId: "s1",
        excludeItemIds: [only.item.itemId],
        nowMs: 10,
      }),
    ).toBeUndefined();
    expect((await queue.list("s1")).map((item) => item.itemId)).toEqual([
      only.item.itemId,
    ]);
    expect(await queue.claimNext({ sessionId: "s1", nowMs: 10 })).toMatchObject(
      {
        item: { itemId: only.item.itemId },
      },
    );
  });

  it.each([
    {
      provider_id: "minimax",
      model_id: "MiniMax-M3.1",
      reasoning: false,
      context_limit: 1_000_000,
    },
    {
      provider_id: "minimax",
      model_id: "MiniMax-M3.1",
      reasoning: true,
      context_limit: 1_000_000,
      thinking: { effort: "max" },
    },
  ])(
    "retains the complete model selection across persistence, claim and retry: %j",
    async (model) => {
      const { client, queue } = await setup();
      await queue.enqueue({
        ...input("queued model", "model-selection"),
        model,
        message: message("queued model"),
      });
      const reopened = values(
        createQueueRepository({ db: client.db, nowMs: () => 2 }),
      );
      expect((await reopened.list("s1"))[0]?.model).toEqual(model);
      const claim = await reopened.claimNext({ sessionId: "s1" });
      expect(claim?.item.model).toEqual(model);
      if (!claim) throw new Error("Missing queue claim");
      await reopened.releaseClaim("s1", claim.claimId);
      expect((await reopened.list("s1"))[0]?.model).toEqual(model);
    },
  );
  it("claims an exact non-head item without reordering the remaining FIFO work", async () => {
    const { queue } = await setup();
    const first = await queue.enqueue(input("first", "first"));
    const second = await queue.enqueue(input("second", "second"));
    if (!first || !second) throw new Error("Queue fixture missing");

    const selected = await queue.claimNext({
      sessionId: "s1",
      itemId: second.item.itemId,
      nowMs: 10,
    });

    expect(selected).toMatchObject({
      selection: "exact",
      item: { itemId: second.item.itemId },
    });
    expect((await queue.list("s1")).map((item) => item.itemId)).toEqual([
      first.item.itemId,
    ]);
    if (!selected) throw new Error("Exact Queue claim missing");
    await queue.releaseClaim("s1", selected.claimId);
    expect((await queue.list("s1")).map((item) => item.itemId)).toEqual([
      first.item.itemId,
      second.item.itemId,
    ]);
  });

  it("places a questionnaire continuation ahead of already queued user messages", async () => {
    const { queue } = await setup();
    await queue.enqueue(input("queued-user-message", "queued-user-message"));
    await queue.enqueue({
      ...input("questionnaire-answer", "questionnaire-answer"),
      source: "questionnaire",
      queuePlacement: "front",
    });

    expect(
      (await queue.list("s1")).map(
        ({ message: queuedMessage }) => queuedMessage.content,
      ),
    ).toEqual(["questionnaire-answer", "queued-user-message"]);

    const answer = await queue.claimNext({ sessionId: "s1", nowMs: 10 });
    expect(answer?.message.content).toBe("questionnaire-answer");
    expect(
      (await queue.list("s1")).map(
        ({ message: queuedMessage }) => queuedMessage.content,
      ),
    ).toEqual(["queued-user-message"]);
  });

  it("preserves FIFO identity, distinguishes idempotency from latest replacement, and edits", async () => {
    const { queue } = await setup();
    const first = await queue.enqueue(input("one", "dedupe-1"));
    const replacement = await queue.enqueue(input("replacement", "dedupe-1"));
    const second = await queue.enqueue(input("two", "dedupe-2"));
    const idempotent = await queue.enqueue({
      ...input("idempotent", "dedupe-3"),
      clientRequestId: "request-1",
    });
    if (!idempotent) throw new Error("Queue fixture missing");
    const duplicate = await queue.enqueue({
      ...input("ignored", "dedupe-4"),
      clientRequestId: "request-1",
      requestedTurnId: "turn-request-1",
    });
    const repeated = await queue.enqueue({
      ...input("still ignored", "dedupe-5"),
      clientRequestId: "request-1",
      requestedTurnId: "turn-replacement",
    });
    expect(first?.position).toBe(1);
    expect(replacement?.position).toBe(1);
    expect(replacement?.item.itemId).not.toBe(first?.item.itemId);
    expect(duplicate).toEqual({
      ...idempotent,
      item: { ...idempotent.item, requestedTurnId: "turn-request-1" },
    });
    expect(repeated).toEqual(duplicate);
    expect(
      (await queue.list("s1")).map(
        ({ message: queuedMessage }) => queuedMessage.content,
      ),
    ).toEqual(["replacement", "two", "idempotent"]);
    if (!second) throw new Error("Queue fixture missing");
    expect(
      await queue.updateQueued({
        sessionId: "s1",
        itemId: second.item.itemId,
        message: message("updated"),
        model: null,
      }),
    ).toMatchObject({ message: { content: "updated" } });
    expect(
      await queue.reorder({ sessionId: "s1", itemIds: [second.item.itemId] }),
    ).toBe("invalid");
    expect(
      await queue.reorder({
        sessionId: "s1",
        itemIds: [
          second.item.itemId,
          replacement?.item.itemId as string,
          idempotent.item.itemId,
        ],
      }),
    ).toMatchObject([
      { itemId: second.item.itemId },
      { itemId: replacement?.item.itemId },
      { itemId: idempotent.item.itemId },
    ]);
  });

  it("preserves the queued client intent when editing message content", async () => {
    const { queue } = await setup();
    const queued = await queue.enqueue({
      ...input("plan this", "plan-edit"),
      message: { ...message("plan this"), clientIntent: "plan-entry" },
    });
    if (!queued) throw new Error("Queue fixture missing");

    expect(
      await queue.updateQueued({
        sessionId: "s1",
        itemId: queued.item.itemId,
        message: message("plan this instead"),
      }),
    ).toMatchObject({
      message: { content: "plan this instead", clientIntent: "plan-entry" },
    });
  });
});

describe("QueueRepository claim visibility and liveness", () => {
  it("claims one Desktop API item regardless of matching route and model identity", async () => {
    const { queue } = await setup();
    await queue.enqueue({ ...input("one", "d1"), model: { model_id: "one" } });
    await queue.enqueue({ ...input("two", "d2"), model: { model_id: "one" } });
    await queue.enqueue({
      ...input("model-boundary", "d3"),
      model: { model_id: "two" },
    });
    await queue.enqueue({ ...input("boundary", "d4"), source: "task" });
    await queue.enqueue(input("after-boundary", "d5"));
    const claim = await queue.claimNext({ sessionId: "s1", nowMs: 10 });
    expect(claim?.item.message.content).toBe("one");
    expect(
      (await queue.list("s1")).map(({ message: value }) => value.content),
    ).toEqual(["two", "model-boundary", "boundary", "after-boundary"]);
  });

  it("claims exactly one Channel item even when consecutive IM routing identities match", async () => {
    const { queue } = await setup();
    await queue.enqueue({
      ...input("chat one", "route-1"),
      source: "channel:feishu",
      message: {
        ...message("chat one"),
        channelContext: channelContext("chat-1"),
      },
    });
    await queue.enqueue({
      ...input("chat two", "route-2"),
      source: "channel:feishu",
      message: {
        ...message("chat two"),
        channelContext: channelContext("chat-1"),
      },
    });

    const claim = await queue.claimNext({ sessionId: "s1", nowMs: 10 });

    expect(claim?.item.message.content).toBe("chat one");
    expect(
      (await queue.list("s1")).map(({ message: value }) => value.content),
    ).toEqual(["chat two"]);
  });

  it("rejects Channel edits and preserves the original message and routing context", async () => {
    const { queue } = await setup();
    const contextual = await queue.enqueue({
      ...input("context", "context"),
      source: "channel:feishu",
      message: {
        ...message("context"),
        channelContext: channelContext(),
      },
    });
    if (!contextual) throw new Error("Queue fixture missing");
    expect(
      await queue.updateQueued({
        sessionId: "s1",
        itemId: contextual.item.itemId,
        message: message("plain"),
      }),
    ).toBe("not_editable");
    expect(await queue.get("s1", contextual.item.itemId)).toMatchObject({
      source: "channel:feishu",
      message: {
        content: "context",
        channelContext: channelContext(),
      },
      channelContext: channelContext(),
    });
    await queue.cancel("s1", contextual.item.itemId);
  });

  it("expires released claims and preserves live claims", async () => {
    let nowMs = 1;
    const { queue } = await setup({ nowMs: () => nowMs });
    await queue.enqueue({ ...input("expires", "expires"), expiresAt: 5 });
    const expiring = await queue.claimNext({ sessionId: "s1", nowMs });
    nowMs = 6;
    expect(await queue.releaseClaim("s1", expiring?.claimId as string)).toEqual(
      [],
    );
    expect(await queue.list("s1")).toEqual([]);

    await queue.enqueue(input("live", "live"));
    const live = await queue.claimNext({ sessionId: "s1", nowMs });
    expect(live).toBeDefined();
    expect(await queue.recoverClaims("s1", acceptance(false))).toEqual({
      acknowledged: [],
      released: [],
    });
  });

  it("deletes expired recovered claims and applies the configured lease to legacy claims", async () => {
    let nowMs = 1;
    const { queue } = await setup({
      nowMs: () => nowMs,
      claimLeaseMs: 5,
      isClaimOwnerAlive: () => true,
    });
    await queue.replaceSession("s1", [
      {
        ...legacyItem("legacy-claimed", "s1"),
        status: "claimed",
        claimId: "legacy-claim",
        claimedAt: 1,
        claimOwnerId: "legacy-owner",
      },
    ]);
    nowMs = 5;
    expect(await queue.recoverClaims("s1", acceptance(false))).toEqual({
      acknowledged: [],
      released: [],
    });
    nowMs = 6;
    expect(await queue.recoverClaims("s1", acceptance(false))).toMatchObject({
      acknowledged: [],
      released: [{ itemId: "legacy-claimed", status: "queued" }],
    });
    await queue.cancel("s1", "legacy-claimed");

    const expiringItem = await queue.enqueue({
      ...input("expired", "expired"),
      expiresAt: 7,
    });
    const expired = await queue.claimNext({ sessionId: "s1", nowMs });
    expect(expired).toBeDefined();
    nowMs = 12;
    expect(await queue.recoverClaims("s1", acceptance(false))).toEqual({
      acknowledged: [],
      released: [],
    });
    expect(
      await queue.get("s1", expiringItem?.item.itemId as string),
    ).toBeUndefined();
  });
});

describe("QueueRepository startup claim recovery", () => {
  it("reconciles pre-start claims while preserving online leases", async () => {
    let nowMs = 10;
    const { queue } = await setup({
      nowMs: () => nowMs,
      claimLeaseMs: 30_000,
      isClaimOwnerAlive: () => true,
    });
    await queue.enqueue(input("release-old-claim", "release-old-claim"));
    const releasedClaim = await queue.claimNext({ sessionId: "s1", nowMs });
    expect(releasedClaim).toBeDefined();

    nowMs = 11;
    expect(await queue.recoverClaims("s1", acceptance(false))).toEqual({
      acknowledged: [],
      released: [],
    });
    expect(
      await queue.recoverClaims("s1", acceptance(false), {
        claimedAtOrBeforeMs: 10,
      }),
    ).toMatchObject({
      acknowledged: [],
      released: [{ itemId: releasedClaim?.item.itemId, status: "queued" }],
    });

    await queue.cancel("s1", releasedClaim?.item.itemId as string);
    await queue.enqueue(input("ack-old-claim", "ack-old-claim"));
    const acknowledgedClaim = await queue.claimNext({ sessionId: "s1", nowMs });
    expect(acknowledgedClaim).toBeDefined();

    nowMs = 12;
    expect(
      await queue.recoverClaims("s1", acceptance(true), {
        claimedAtOrBeforeMs: 11,
      }),
    ).toMatchObject({
      acknowledged: [{ itemId: acknowledgedClaim?.item.itemId }],
      released: [],
    });
    expect(
      await queue.get("s1", acknowledgedClaim?.item.itemId as string),
    ).toBeUndefined();
  });
});

describe("QueueRepository ownership and transaction serialization", () => {
  it("acquires an immediate transaction before enqueue admission and mutation", async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), "queue-repository-concurrency-"),
    );
    const owner = new DatabaseClient({ dataDir });
    await initializeDatabase({ database: owner, dataDir });
    const contender = new DatabaseClient({ dataDir });
    contender.rawDb.exec("PRAGMA busy_timeout = 0");
    cleanup.push(async () => {
      contender.close();
      owner.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    await createQueueRepository({ db: owner.db }).list("s1");
    let contenderErrorCode: string | undefined;
    const queue = createQueueRepository({
      db: owner.db,
      enqueueAdmission: {
        rejectionInTransaction() {
          try {
            contender.rawDb.transaction(() => undefined).immediate();
          } catch (error) {
            contenderErrorCode = sqliteErrorCode(error);
          }
          return undefined;
        },
      },
    });
    await queue.enqueue(input("serialized", "serialized"));
    expect(contenderErrorCode).toBe("SQLITE_BUSY");
  });

  it("uses an opaque default owner and preserves its unexpired claim", async () => {
    const { queue } = await setup({ claimOwnerId: "" });
    await queue.enqueue(input("owned", "owned"));
    const claim = await queue.claimNext({ sessionId: "s1", nowMs: 1 });
    expect(claim?.claimOwnerId).toMatch(/^queue-claim:[0-9a-f-]{36}$/u);
    expect(await queue.recoverClaims("s1", acceptance(false))).toEqual({
      acknowledged: [],
      released: [],
    });
  });

  it("treats claim owner formats as opaque without an injected liveness capability", async () => {
    const legacy = await setup({ claimOwnerId: "queue-claim:0:legacy" });
    await legacy.queue.enqueue(input("legacy-owner", "legacy-owner"));
    await legacy.queue.claimNext({ sessionId: "s1", nowMs: 1 });
    expect(await legacy.queue.recoverClaims("s1", acceptance(false))).toEqual({
      acknowledged: [],
      released: [],
    });

    const dead = await setup({ claimOwnerId: "queue-claim:2147483647:dead" });
    await dead.queue.enqueue(input("dead-owner", "dead-owner"));
    await dead.queue.claimNext({ sessionId: "s1", nowMs: 1 });
    expect(await dead.queue.recoverClaims("s1", acceptance(false))).toEqual({
      acknowledged: [],
      released: [],
    });
  });
});

/**
 * GOAL-05 head-of-line yield, end to end across the two owners that decide it.
 *
 * Skipping the blocked Goal row at claim selection is only half the yield: the
 * admitting transaction fences a FIFO claim against every older queued row, so
 * the row that just stepped aside would otherwise block the very work it
 * yielded to. These drive the real QueueRepository, the real priority fence and
 * the real Turn admission transaction rather than an executor stub.
 */
describe("QueueRepository GOAL-05 head-of-line yield through Turn admission", () => {
  it("admits the user Turn that a yielded Goal row stepped aside for, keeping the Goal row queued", async () => {
    const { client, queue } = await setup();
    const goalItem = await queue.enqueue({
      ...input("goal continuation", "goal-1"),
      message: { ...message("goal continuation"), source: "thread-goal" },
    });
    const userItem = await queue.enqueue(
      input("user asks something", "user-1"),
    );
    if (!goalItem || !userItem) throw new Error("yield fixture missing");

    // The drain pass parked the Goal item and excluded it, so selection hands
    // back the user item even though the Goal row is still the older row.
    const claim = await queue.claimNext({
      sessionId: "s1",
      nowMs: 10,
      excludeItemIds: [goalItem.item.itemId],
    });
    if (!claim) throw new Error("expected the user item to be claimed");
    expect(claim.item.itemId).toBe(userItem.item.itemId);

    const turns = createTurnRepository({
      db: client.db,
      priorityFence: createQueueTurnAdmissionPriorityFence(),
      sessionAdmission: { rejectionInTransaction: () => undefined },
      nowMs: () => 10,
      makeLeaseId: () => "lease-yield",
    });
    const admitInput = {
      sessionId: "s1",
      turnId: "turn-user",
      busyReason: "turn" as const,
      inputDigest: "digest:user",
      inputMetadata: { attachmentCount: 0, hasContent: true },
      candidateCreatedAtMs: 10,
      queueIngress: {
        claimId: claim.claimId,
        itemId: claim.item.itemId,
        provenance: claim.provenance,
      },
    };

    // Without carrying the yield, the fence still sees the older Goal row.
    await expect(
      turns.admit({
        ...admitInput,
        priority: {
          kind: "fifo",
          candidateCreatedAtMs: 10,
          queueClaimId: claim.claimId,
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      reason: "priority-blocked",
    });

    // Carrying it exempts exactly that row, so the user Turn starts.
    await expect(
      turns.admit({
        ...admitInput,
        priority: {
          kind: "fifo",
          candidateCreatedAtMs: 10,
          queueClaimId: claim.claimId,
          yieldedQueueItemIds: [goalItem.item.itemId],
        },
      }),
    ).resolves.toMatchObject({ status: "accepted" });

    // The Goal keeps its queue item and its position: nothing was cancelled.
    await expect(queue.get("s1", goalItem.item.itemId)).resolves.toMatchObject({
      status: "queued",
    });
  });

  it("exempts only the yielded identity and never a different older row", async () => {
    const { client, queue } = await setup();
    const goalItem = await queue.enqueue({
      ...input("goal continuation", "goal-1"),
      message: { ...message("goal continuation"), source: "thread-goal" },
    });
    const otherUser = await queue.enqueue(
      input("earlier user message", "user-early"),
    );
    const userItem = await queue.enqueue(
      input("later user message", "user-late"),
    );
    if (!goalItem || !otherUser || !userItem)
      throw new Error("yield fixture missing");

    const claim = await queue.claimNext({
      sessionId: "s1",
      nowMs: 10,
      excludeItemIds: [goalItem.item.itemId, otherUser.item.itemId],
    });
    if (!claim) throw new Error("expected the later user item to be claimed");
    expect(claim.item.itemId).toBe(userItem.item.itemId);

    const turns = createTurnRepository({
      db: client.db,
      priorityFence: createQueueTurnAdmissionPriorityFence(),
      sessionAdmission: { rejectionInTransaction: () => undefined },
      nowMs: () => 10,
      makeLeaseId: () => "lease-scope",
    });
    // Only the Goal row is exempt; the ordinary user row ahead still fences.
    await expect(
      turns.admit({
        sessionId: "s1",
        turnId: "turn-scope",
        busyReason: "turn",
        inputDigest: "digest:scope",
        inputMetadata: { attachmentCount: 0, hasContent: true },
        candidateCreatedAtMs: 10,
        priority: {
          kind: "fifo",
          candidateCreatedAtMs: 10,
          queueClaimId: claim.claimId,
          yieldedQueueItemIds: [goalItem.item.itemId],
        },
        queueIngress: {
          claimId: claim.claimId,
          itemId: claim.item.itemId,
          provenance: claim.provenance,
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      reason: "priority-blocked",
    });
  });
});

/**
 * GOAL-03/GOAL-05: a re-armed follow-up must reach the Queue as its own row.
 *
 * The Queue folds a repeat clientRequestId onto the row it already holds. A
 * rebuild that reuses the settling Turn's key therefore lands on the row that
 * belongs to the invalidated epoch — which is then cancelled for being stale,
 * so the Goal stops. This pins the Queue-side half of that contract.
 */
describe("QueueRepository re-armed follow-up idempotency", () => {
  it("folds a repeated key onto one row but admits a new row for a new epoch key", async () => {
    const { queue } = await setup();
    const staleEpochKey = "thread-goal-followup:rearm:goal-1:100";
    const newEpochKey = "thread-goal-followup:rearm:goal-1:200";

    const first = await queue.enqueue({
      ...input("follow-up at epoch 100", "rearm-1"),
      clientRequestId: staleEpochKey,
    });
    // The same rebuild retried: still one row, no duplicate follow-up.
    const retried = await queue.enqueue({
      ...input("follow-up at epoch 100 again", "rearm-2"),
      clientRequestId: staleEpochKey,
    });
    // A genuinely newer epoch: its own admissible row.
    const rebuilt = await queue.enqueue({
      ...input("follow-up at epoch 200", "rearm-3"),
      clientRequestId: newEpochKey,
    });
    if (!first || !rebuilt) throw new Error("re-arm fixture missing");

    expect(retried?.item.itemId).toBe(first.item.itemId);
    expect(rebuilt.item.itemId).not.toBe(first.item.itemId);
    await expect(
      queue.findByClientRequestId("s1", newEpochKey),
    ).resolves.toMatchObject({
      itemId: rebuilt.item.itemId,
      status: "queued",
    });
  });
});

describe("QueueRepository Slash Review claim identity", () => {
  it("acknowledges a Slash Review claim with its nested execution source", async () => {
    const { client, queue } = await setup();
    const queued = await queue.enqueue({
      ...input("Review local changes", "review-1"),
      message: {
        ...message("Review local changes"),
        source: "code_review",
      },
    });
    const claim = await queue.claimNext({ sessionId: "s1", nowMs: 10 });
    if (!queued || !claim)
      throw new Error("Slash Review claim fixture missing");
    const turns = createTurnRepository({
      db: client.db,
      priorityFence: createQueueTurnAdmissionPriorityFence(),
      sessionAdmission: { rejectionInTransaction: () => undefined },
      nowMs: () => 10,
      makeLeaseId: () => "lease-review",
    });
    await expect(
      turns.admit({
        sessionId: "s1",
        turnId: "turn-review",
        busyReason: "turn",
        inputDigest: "digest:review",
        inputMetadata: { attachmentCount: 0, hasContent: true },
        candidateCreatedAtMs: 10,
        priority: {
          kind: "fifo",
          candidateCreatedAtMs: 10,
          queueClaimId: claim.claimId,
        },
        queueIngress: {
          claimId: claim.claimId,
          itemId: claim.item.itemId,
          provenance: claim.provenance,
        },
      }),
    ).resolves.toMatchObject({ status: "accepted" });

    await expect(
      queue.acknowledgeClaim("s1", claim.claimId, "turn-review", turns),
    ).resolves.toMatchObject([{ itemId: queued.item.itemId }]);
    await expect(queue.get("s1", queued.item.itemId)).resolves.toBeUndefined();
  });

  it("recovers an accepted Slash Review claim with its nested execution source", async () => {
    const { client, queue } = await setup({ isClaimOwnerAlive: () => false });
    const queued = await queue.enqueue({
      ...input("Review local changes", "review-recovery"),
      message: {
        ...message("Review local changes"),
        source: "code_review",
      },
    });
    const claim = await queue.claimNext({ sessionId: "s1", nowMs: 10 });
    if (!queued || !claim)
      throw new Error("Slash Review recovery fixture missing");
    const turns = createTurnRepository({
      db: client.db,
      priorityFence: createQueueTurnAdmissionPriorityFence(),
      sessionAdmission: { rejectionInTransaction: () => undefined },
      nowMs: () => 10,
      makeLeaseId: () => "lease-review-recovery",
    });
    await turns.admit({
      sessionId: "s1",
      turnId: "turn-review-recovery",
      busyReason: "turn",
      inputDigest: "digest:review-recovery",
      inputMetadata: { attachmentCount: 0, hasContent: true },
      candidateCreatedAtMs: 10,
      priority: {
        kind: "fifo",
        candidateCreatedAtMs: 10,
        queueClaimId: claim.claimId,
      },
      queueIngress: {
        claimId: claim.claimId,
        itemId: claim.item.itemId,
        provenance: claim.provenance,
      },
    });

    await expect(queue.recoverClaims("s1", turns)).resolves.toMatchObject({
      acknowledged: [{ itemId: queued.item.itemId }],
      released: [],
    });
    await expect(queue.get("s1", queued.item.itemId)).resolves.toBeUndefined();
  });
});

describe("QueueRepository claims, recovery, and migration", () => {
  it("claims one item then acknowledges in one synchronous acceptance transaction", async () => {
    const { queue } = await setup();
    await queue.enqueue(input("one", "d1"));
    await queue.enqueue(input("two", "d2"));
    const claim = await queue.claimNext({ sessionId: "s1", nowMs: 10 });
    if (!claim) throw new Error("Claim fixture missing");
    expect(
      await queue.updateQueued({
        sessionId: "s1",
        itemId: claim.item.itemId,
        message: message("no"),
      }),
    ).toBe("not_editable");
    const calls: string[] = [];
    const accepted = await queue.acknowledgeClaim(
      "s1",
      claim.claimId,
      "turn-1",
      {
        isAcceptedInTransaction(db: AppDb, query: QueueClaimAcceptanceQuery) {
          void db;
          calls.push(`lookup:${query.turnId}`);
          return true;
        },
        markAcknowledgedInTransaction(
          db: AppDb,
          query: QueueClaimAcceptanceQuery,
        ) {
          void db;
          calls.push(`mark:${query.queueItemIds.length}`);
        },
      },
    );
    expect(accepted).toHaveLength(1);
    expect(calls).toEqual(["lookup:turn-1", "mark:1"]);
    expect(await queue.list("s1")).toMatchObject([
      { message: { content: "two" } },
    ]);
  });

  it("keeps a claimed item visible to exact get while excluding it from list and edits", async () => {
    const { queue } = await setup();
    const queued = await queue.enqueue(input("guarded", "guarded"));
    const claim = await queue.claimNext({ sessionId: "s1", nowMs: 10 });
    if (!queued || !claim) throw new Error("Claim fixture missing");

    expect(await queue.list("s1")).toEqual([]);
    expect(await queue.get("s1", queued.item.itemId)).toMatchObject({
      itemId: queued.item.itemId,
      status: "claimed",
      claimId: claim.claimId,
    });
    expect(
      await queue.updateQueued({
        sessionId: "s1",
        itemId: queued.item.itemId,
        message: message("not editable"),
      }),
    ).toBe("not_editable");
    expect(await queue.cancel("s1", queued.item.itemId)).toBe("not_editable");
  });

  it("finds queued and claimed idempotency records, then atomically cancels the claim", async () => {
    const { queue } = await setup();
    const queued = await queue.enqueue({
      ...input("goal kickoff", "goal-kickoff"),
      clientRequestId: "thread-goal-kickoff:goal-1",
    });
    if (!queued) throw new Error("Queue fixture missing");

    expect(
      await queue.findByClientRequestId("s1", "thread-goal-kickoff:goal-1"),
    ).toMatchObject({
      itemId: queued.item.itemId,
      status: "queued",
    });
    const claim = await queue.claimNext({ sessionId: "s1", nowMs: 10 });
    if (!claim) throw new Error("Queue claim fixture missing");
    expect(
      await queue.findByClientRequestId("s1", "thread-goal-kickoff:goal-1"),
    ).toMatchObject({
      itemId: queued.item.itemId,
      status: "claimed",
      claimId: claim.claimId,
    });

    await expect(queue.cancelClaim("s1", claim.claimId)).resolves.toMatchObject(
      [{ itemId: queued.item.itemId, status: "claimed" }],
    );
    await expect(
      queue.findByClientRequestId("s1", "thread-goal-kickoff:goal-1"),
    ).resolves.toBeUndefined();
  });

  it("fails closed and preserves the claim when durable acceptance is missing, false, or throws", async () => {
    const { queue } = await setup();
    const queued = await queue.enqueue(input("guarded", "guarded"));
    const claim = await queue.claimNext({ sessionId: "s1", nowMs: 10 });
    if (!queued || !claim) throw new Error("Claim fixture missing");

    let marked = false;
    await expect(
      queue.acknowledgeClaim("s1", claim.claimId, "turn-1", {
        isAcceptedInTransaction() {
          return false;
        },
        markAcknowledgedInTransaction() {
          marked = true;
        },
      }),
    ).rejects.toBeInstanceOf(QueueClaimNotAcceptedError);
    expect(marked).toBe(false);

    const lookupFailure = new Error("lookup failed");
    await expect(
      queue.acknowledgeClaim("s1", claim.claimId, "turn-1", {
        isAcceptedInTransaction() {
          throw lookupFailure;
        },
        markAcknowledgedInTransaction() {
          marked = true;
        },
      }),
    ).rejects.toBe(lookupFailure);
    expect(marked).toBe(false);

    await expect(
      queue.acknowledgeClaim("s1", claim.claimId, "turn-1"),
    ).rejects.toBeInstanceOf(QueueClaimNotAcceptedError);
    expect(await queue.get("s1", queued.item.itemId)).toMatchObject({
      itemId: queued.item.itemId,
      status: "claimed",
      claimId: claim.claimId,
    });
  });

  it("releases, rejects, recovers, drains composer items, and ignores post-migration legacy blobs", async () => {
    const { client, queue } = await setup();
    await queue.enqueue(input("release", "r1"));
    const release = await queue.claimNext({ sessionId: "s1", nowMs: 1 });
    expect(
      await queue.releaseClaim("s1", release?.claimId as string),
    ).toHaveLength(1);
    const drain = await queue.drainComposerInjectable("s1");
    expect(drain).toHaveLength(1);

    const legacy = {
      itemId: "legacy-1",
      sessionId: "legacy",
      agentName: "mavis",
      source: "api",
      status: "queued",
      message: message("legacy"),
      createdAt: 1,
    };
    client.db
      .insert(legacyQueues)
      .values({
        sessionId: "legacy",
        itemsJson: JSON.stringify([legacy]),
      })
      .run();
    expect(await queue.list("legacy")).toEqual([]);
    expect(
      client.db
        .select()
        .from(queueRowMigrations)
        .where(eq(queueRowMigrations.sessionId, "legacy"))
        .get(),
    ).toBeDefined();
    expect(
      client.db
        .select()
        .from(legacyQueues)
        .where(eq(legacyQueues.sessionId, "legacy"))
        .get(),
    ).toBeDefined();
  });
});

describe("QueueRepository mutations, recovery, and deletion", () => {
  it("supports cancel, source promotion, claim rejection, recovery, replace, and delete", async () => {
    const { queue } = await setup({ isClaimOwnerAlive: () => false });
    const first = await queue.enqueue(input("one", "d1"));
    const second = await queue.enqueue(input("two", "d2"));
    if (!first || !second) throw new Error("Queue fixture missing");
    expect(await queue.get("s1", first.item.itemId)).toMatchObject({
      itemId: first.item.itemId,
    });
    expect(
      await queue.promoteQueuedSource("s1", first.item.itemId, "task"),
    ).toMatchObject({
      source: "task",
    });
    expect(await queue.cancel("s1", second.item.itemId)).toMatchObject({
      itemId: second.item.itemId,
    });
    const claim = await queue.claimNext({ sessionId: "s1", nowMs: 10 });
    expect(
      await queue.rejectClaim(
        "s1",
        claim?.claimId as string,
        "invalid-session",
      ),
    ).toHaveLength(1);

    await queue.enqueue(input("recover", "r1"));
    const recoverable = await queue.claimNext({ sessionId: "s1", nowMs: 10 });
    expect(recoverable).toBeDefined();
    const recovered = await queue.recoverClaims("s1", acceptance(false));
    expect(recovered.released).toHaveLength(1);
    expect(recovered.acknowledged).toHaveLength(0);
    const claimedAgain = await queue.claimNext({ sessionId: "s1", nowMs: 100 });
    expect(claimedAgain).toBeDefined();
    const acknowledged = await queue.recoverClaims("s1", acceptance(true));
    expect(acknowledged.acknowledged).toHaveLength(1);

    await queue.replaceSession("s1", [legacyItem("replacement", "s1")]);
    expect(await queue.listPendingSessionIds()).toContain("s1");
    expect(await queue.list("s1")).toMatchObject([{ itemId: "replacement" }]);
    await queue.deleteSession("s1");
    expect(await queue.list("s1")).toEqual([]);
  });

  it("runs enqueue admission in-transaction and fails closed for corrupt rows", async () => {
    const rejected = await setup({
      enqueueAdmission: {
        rejectionInTransaction() {
          return "maintenance-active";
        },
      },
    });
    await expect(
      rejected.queue.enqueue(input("blocked", "blocked")),
    ).rejects.toBeInstanceOf(QueueEnqueueAdmissionError);

    const { client, queue } = await setup();
    client.db
      .insert(queueItems)
      .values({
        sessionId: "corrupt",
        itemId: "bad",
        status: "queued",
        createdAtMs: 1,
        dataJson: "{",
      })
      .run();
    await expect(queue.list("corrupt")).rejects.toBeInstanceOf(
      QueueDataCorruptionError,
    );

    client.db
      .insert(legacyQueues)
      .values({ sessionId: "legacy-corrupt", itemsJson: "{" })
      .run();
    await expect(queue.list("legacy-corrupt")).resolves.toEqual([]);
    expect(
      client.db
        .select()
        .from(queueRowMigrations)
        .where(eq(queueRowMigrations.sessionId, "legacy-corrupt"))
        .get(),
    ).toBeDefined();
    expect(
      client.db
        .select()
        .from(legacyQueues)
        .where(eq(legacyQueues.sessionId, "legacy-corrupt"))
        .get(),
    ).toBeDefined();
  });

  it("checks Session admission before every Queue mutation and leaves rows unchanged", async () => {
    let blocked = false;
    const { client, queue } = await setup({
      enqueueAdmission: {
        rejectionInTransaction() {
          return blocked ? "maintenance-active" : undefined;
        },
      },
    });
    const first = await queue.enqueue(input("one", "d1"));
    const second = await queue.enqueue(input("two", "d2"));
    if (!first || !second) throw new Error("Queue fixture missing");
    const before = client.db.select().from(queueItems).all();
    blocked = true;

    await expect(
      queue.updateQueued({
        sessionId: "s1",
        itemId: first.item.itemId,
        message: message("edited"),
      }),
    ).rejects.toBeInstanceOf(QueueEnqueueAdmissionError);
    await expect(
      queue.promoteQueuedSource("s1", first.item.itemId, "task"),
    ).rejects.toBeInstanceOf(QueueEnqueueAdmissionError);
    await expect(queue.cancel("s1", first.item.itemId)).rejects.toBeInstanceOf(
      QueueEnqueueAdmissionError,
    );
    await expect(
      queue.reorder({
        sessionId: "s1",
        itemIds: [second.item.itemId, first.item.itemId],
      }),
    ).rejects.toBeInstanceOf(QueueEnqueueAdmissionError);

    expect(client.db.select().from(queueItems).all()).toEqual(before);
  });
});

function input(content: string, dedupeKey: string) {
  return {
    session: { sessionId: "s1", agentName: "mavis" },
    message: message(content),
    source: "api" as const,
    dedupeKey,
  };
}
function message(content: string) {
  return { content, attachments: [] as const };
}

function channelContext(chatId = "chat") {
  return {
    platform: "feishu",
    chatType: "group",
    chatId,
    senderId: "sender",
    clientName: "client",
  };
}

async function setup(
  extra: Partial<Parameters<typeof createQueueRepository>[0]> = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), "queue-repository-"));
  const client = new DatabaseClient({ dataDir });
  await initializeDatabase({ database: client, dataDir });
  cleanup.push(
    () => rm(dataDir, { recursive: true, force: true }),
    // Cleanup runs in reverse registration order; Windows cannot unlink an open DB.
    () => client.close(),
  );
  let id = 0;
  return {
    client,
    queue: values(
      createQueueRepository({
        db: client.db,
        nowMs: () => 1,
        makeId: (prefix: string) => `${prefix}-${String(++id)}`,
        claimOwnerId: "owner-1",
        claimLeaseMs: 50,
        ...extra,
      }),
    ),
  };
}

function values(repository: QueueRepository) {
  return {
    listPendingSessionIds: () => repository.listPendingSessionIds(),
    list: async (sessionId: string) => (await repository.list(sessionId)).value,
    findByClientRequestId: async (
      ...args: Parameters<QueueRepository["findByClientRequestId"]>
    ) => (await repository.findByClientRequestId(...args)).value,
    get: async (sessionId: string, itemId: string) =>
      (await repository.get(sessionId, itemId)).value,
    enqueue: async (...args: Parameters<QueueRepository["enqueue"]>) =>
      (await repository.enqueue(...args)).value,
    updateQueued: async (
      ...args: Parameters<QueueRepository["updateQueued"]>
    ) => (await repository.updateQueued(...args)).value,
    cancel: async (...args: Parameters<QueueRepository["cancel"]>) =>
      (await repository.cancel(...args)).value,
    promoteQueuedSource: async (
      ...args: Parameters<QueueRepository["promoteQueuedSource"]>
    ) => (await repository.promoteQueuedSource(...args)).value,
    reorder: async (...args: Parameters<QueueRepository["reorder"]>) =>
      (await repository.reorder(...args)).value,
    claimNext: async (...args: Parameters<QueueRepository["claimNext"]>) =>
      (await repository.claimNext(...args)).value,
    acknowledgeClaim: async (
      ...args: Parameters<QueueRepository["acknowledgeClaim"]>
    ) => (await repository.acknowledgeClaim(...args)).value,
    releaseClaim: async (
      ...args: Parameters<QueueRepository["releaseClaim"]>
    ) => (await repository.releaseClaim(...args)).value,
    cancelClaim: async (...args: Parameters<QueueRepository["cancelClaim"]>) =>
      (await repository.cancelClaim(...args)).value,
    rejectClaim: async (...args: Parameters<QueueRepository["rejectClaim"]>) =>
      (await repository.rejectClaim(...args)).value,
    recoverClaims: async (
      ...args: Parameters<QueueRepository["recoverClaims"]>
    ) => (await repository.recoverClaims(...args)).value,
    drainComposerInjectable: async (
      ...args: Parameters<QueueRepository["drainComposerInjectable"]>
    ) => (await repository.drainComposerInjectable(...args)).value,
    replaceSession: async (
      ...args: Parameters<QueueRepository["replaceSession"]>
    ) => {
      await repository.replaceSession(...args);
    },
    deleteSession: async (
      ...args: Parameters<QueueRepository["deleteSession"]>
    ) => {
      await repository.deleteSession(...args);
    },
  };
}

function acceptance(accepted: boolean) {
  return {
    isAcceptedInTransaction() {
      return accepted;
    },
    markAcknowledgedInTransaction() {},
  };
}

function legacyItem(itemId: string, sessionId: string) {
  return {
    itemId,
    sessionId,
    agentName: "mavis",
    source: "api" as const,
    status: "queued" as const,
    message: message(itemId),
    createdAt: 1,
  };
}

function sqliteErrorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
