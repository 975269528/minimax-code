import { describe, it, expect } from "vitest";

import {
  ThreadGoalAlreadyExistsError,
  ThreadGoalBudgetLimitedError,
  type ThreadGoalState,
} from "@mavis/goal";

import {
  ThreadGoalContractError,
  createGoalReqToCreateInput,
  goalStateToGoalState,
  patchGoalReqToPatchInput,
  toThreadGoalContractError,
} from "../../../src/thread-goal/contract.js";

/**
 * Pure mapping coverage for the IDL goal contract glue — no HTTP, no store.
 * Mirrors `cron/contract` testing: validates the snake↔camel / tri-state /
 * error-derivation logic in isolation so the DesktopService methods and the
 * request-level test can both rely on it.
 */

const STATE: ThreadGoalState = {
  goalId: "tg_1",
  sessionId: "sess_1",
  objective: "ship the migration",
  status: "active",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_001,
  tokensUsed: 1234,
  turnsUsed: 3,
  timeUsedSeconds: 42,
  tokenBudget: 50_000,
  replyFingerprint: "abc123",
  noProgressStreak: 1,
  noToolStreak: 0,
  lastVerification: {
    v: 1,
    backend: "evaluator",
    verdict: "not_met",
    reason: "Tests are still missing",
    missing: ["focused test"],
    notMetStreak: 1,
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
  statusReason: null,
  kickoffAttachments: [],
  kickoffState: "consumed",
  executionWait: null,
};

describe("goalStateToGoalState", () => {
  it("maps the full record identity-style", () => {
    const projected = goalStateToGoalState(STATE);
    expect(projected).toEqual({
      goalId: "tg_1",
      sessionId: "sess_1",
      objective: "ship the migration",
      objectiveResources: [],
      status: "active",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_001,
      tokensUsed: 1234,
      turnsUsed: 3,
      timeUsedSeconds: 42,
      tokenBudget: 50_000,
      lastVerification: {
        backend: "evaluator",
        verdict: "not_met",
        reason: "Tests are still missing",
        missing: ["focused test"],
        notMetStreak: 1,
        at: 1_700_000_000_000,
      },
      hasKickoffAttachments: false,
    });
    expect(JSON.stringify(projected)).not.toContain("private blocker detail");
  });

  it("projects Goal-owned kickoff attachment presence without exposing local paths", () => {
    expect(
      goalStateToGoalState({
        ...STATE,
        kickoffAttachments: [
          {
            type: "file",
            filePath: "/tmp/private/brief.pdf",
            fileName: "brief.pdf",
            mimeType: "application/pdf",
          },
        ],
      }),
    ).toMatchObject({ hasKickoffAttachments: true });
  });

  it("omits tokenBudget when the cap is null (uncapped → absent on wire)", () => {
    const out = goalStateToGoalState({ ...STATE, tokenBudget: null });
    expect("tokenBudget" in out).toBe(false);
  });

  it("projects the execution wait without changing the Goal decision epoch", () => {
    expect(
      goalStateToGoalState({
        ...STATE,
        executionWait: {
          reason: "required_background",
          sinceMs: 1_700_000_000_500,
        },
      }),
    ).toMatchObject({
      updatedAt: STATE.updatedAt,
      execution: {
        waitReason: "required_background",
        waitSince: 1_700_000_000_500,
      },
    });
  });
});

describe("createGoalReqToCreateInput", () => {
  it("trims objective and passes a positive token budget through", () => {
    expect(
      createGoalReqToCreateInput({
        sessionId: "sess_1",
        objective: "  do the thing  ",
        tokenBudget: 1000,
      }),
    ).toEqual({
      sessionId: "sess_1",
      objective: "do the thing",
      tokenBudget: 1000,
    });
  });

  it("maps usable wire attachments into the Goal-owned kickoff snapshot", () => {
    expect(
      createGoalReqToCreateInput({
        sessionId: "sess_1",
        objective: "Read the brief",
        attachments: [
          {
            meta: {
              attachmentType: "file",
              fileName: "brief.pdf",
              mimeType: "application/pdf",
            },
            local: {
              filePath: "/tmp/brief.pdf",
              assetId: "asset-1",
            },
          },
        ],
      }),
    ).toMatchObject({
      kickoffAttachments: [
        {
          type: "file",
          filePath: "/tmp/brief.pdf",
          fileName: "brief.pdf",
          mimeType: "application/pdf",
          assetId: "asset-1",
        },
      ],
    });
  });

  it("keeps a local data URL without copying the shared cloud payload", () => {
    expect(
      createGoalReqToCreateInput({
        sessionId: "sess_1",
        objective: "Inspect the image",
        attachments: [
          {
            meta: {
              attachmentType: "image",
              fileName: "inline.png",
              mimeType: "image/png",
            },
            local: { dataUrl: "data:image/png;base64,AA==" },
            cloud: { dataUrl: "data:image/png;base64,CLOUD" },
          },
        ],
      }),
    ).toMatchObject({
      kickoffAttachments: [
        {
          type: "image",
          filePath: "",
          fileName: "inline.png",
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,AA==",
        },
      ],
    });
  });

  it("clears a display-only attachment path so its inline preview is persisted", () => {
    expect(
      createGoalReqToCreateInput({
        sessionId: "sess_1",
        objective: "Inspect the annotation",
        attachments: [
          {
            meta: {
              attachmentType: "image",
              fileName: "inline-comment-preview.png",
              mimeType: "image/png",
            },
            local: {
              filePath: "inline-comment-preview.png",
              dataUrl: "data:image/png;base64,AA==",
            },
          },
        ],
      }),
    ).toMatchObject({
      kickoffAttachments: [
        {
          type: "image",
          filePath: "",
          fileName: "inline-comment-preview.png",
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,AA==",
        },
      ],
    });
  });

  it("prefers a real desktop path over an inline display path", () => {
    expect(
      createGoalReqToCreateInput({
        sessionId: "sess_1",
        objective: "Inspect the local image",
        attachments: [
          {
            meta: {
              attachmentType: "image",
              fileName: "photo.png",
              mimeType: "image/png",
            },
            local: {
              filePath: "photo.png",
              desktopPath: "C:\\Users\\Mira\\Pictures\\photo.png",
              dataUrl: "data:image/png;base64,AA==",
            },
          },
        ],
      }),
    ).toMatchObject({
      kickoffAttachments: [
        {
          filePath: "C:\\Users\\Mira\\Pictures\\photo.png",
          dataUrl: "data:image/png;base64,AA==",
        },
      ],
    });
  });

  it("keeps a registered asset path ahead of a desktop fallback", () => {
    expect(
      createGoalReqToCreateInput({
        sessionId: "sess_1",
        objective: "Inspect the durable asset",
        attachments: [
          {
            meta: {
              attachmentType: "file",
              fileName: "brief.pdf",
              mimeType: "application/pdf",
            },
            local: {
              assetId: "asset-1",
              filePath: "/assets/asset-1/brief.pdf",
              desktopPath: "/tmp/brief.pdf",
              dataUrl: "data:application/pdf;base64,AA==",
            },
          },
        ],
      }),
    ).toMatchObject({
      kickoffAttachments: [
        {
          assetId: "asset-1",
          filePath: "/assets/asset-1/brief.pdf",
        },
      ],
    });
  });

  it("ignores a cloud-only attachment in the local runtime Goal contract", () => {
    expect(
      createGoalReqToCreateInput({
        sessionId: "sess_1",
        objective: "Inspect the image",
        attachments: [
          {
            meta: {
              attachmentType: "image",
              fileName: "cloud-only.png",
              mimeType: "image/png",
            },
            cloud: { dataUrl: "data:image/png;base64,CLOUD" },
          },
        ],
      }),
    ).toEqual({
      sessionId: "sess_1",
      objective: "Inspect the image",
    });
  });

  it('treats tokenBudget 0 / omitted as "no cap" (field absent)', () => {
    expect(
      createGoalReqToCreateInput({
        sessionId: "sess_1",
        objective: "x",
        tokenBudget: 0,
      }),
    ).toEqual({ sessionId: "sess_1", objective: "x" });
    expect(
      createGoalReqToCreateInput({ sessionId: "sess_1", objective: "x" }),
    ).toEqual({
      sessionId: "sess_1",
      objective: "x",
    });
  });

  it("does not impose an objective length limit by default", () => {
    const objective = "x".repeat(4_001);

    expect(
      createGoalReqToCreateInput({ sessionId: "sess_1", objective }),
    ).toMatchObject({
      objective,
    });
  });

  it("rejects objectives longer than an explicitly configured bound without truncating", () => {
    const objective = "x".repeat(4_001);

    expect(() =>
      createGoalReqToCreateInput(
        { sessionId: "sess_1", objective },
        { objectiveMaxChars: 4_000 },
      ),
    ).toThrow(expect.objectContaining({ code: "GOAL_OBJECTIVE_TOO_LONG" }));
  });

  it("rejects an empty objective with a 400 contract error", () => {
    expect(() =>
      createGoalReqToCreateInput({ sessionId: "sess_1", objective: "   " }),
    ).toThrow(ThreadGoalContractError);
    try {
      createGoalReqToCreateInput({ sessionId: "sess_1", objective: "" });
    } catch (e) {
      expect((e as ThreadGoalContractError).status).toBe(400);
    }
  });

  it("rejects a blank session_id with a 400", () => {
    expect(() =>
      createGoalReqToCreateInput({ sessionId: "  ", objective: "x" }),
    ).toThrow(/session_id is required/);
  });
});

describe("patchGoalReqToPatchInput tri-state token_budget", () => {
  it("omitted → field absent (leave the cap alone)", () => {
    const { patch, hasChange } = patchGoalReqToPatchInput({
      sessionId: "s",
      status: "paused",
    });
    expect("tokenBudget" in patch).toBe(false);
    expect(patch.status).toBe("paused");
    expect(hasChange).toBe(true);
  });

  it("never invents a statusReason the wire request does not carry", () => {
    // `PatchGoalReq` has no status_reason field. A translator that derives one
    // is writing domain state it does not own, and that invented field is what
    // previously diverted every wire pause away from the atomic pause path.
    for (const status of ["paused", "complete", "active"] as const) {
      const { patch } = patchGoalReqToPatchInput({ sessionId: "s", status });
      expect("statusReason" in patch).toBe(false);
    }
  });

  it("reports a bare pause as the user-pause intent", () => {
    expect(
      patchGoalReqToPatchInput({ sessionId: "s", status: "paused" })
        .isUserPause,
    ).toBe(true);
  });

  it("does not treat a pause bundled with an edit as a bare user pause", () => {
    expect(
      patchGoalReqToPatchInput({
        sessionId: "s",
        status: "paused",
        objective: "new objective",
      }).isUserPause,
    ).toBe(false);
    expect(
      patchGoalReqToPatchInput({
        sessionId: "s",
        status: "paused",
        tokenBudget: 42,
      }).isUserPause,
    ).toBe(false);
    expect(
      patchGoalReqToPatchInput({ sessionId: "s", status: "complete" })
        .isUserPause,
    ).toBe(false);
  });

  it("0 → null (clear the cap)", () => {
    const { patch } = patchGoalReqToPatchInput({
      sessionId: "s",
      tokenBudget: 0,
    });
    expect(patch.tokenBudget).toBeNull();
  });

  it("positive → set the cap", () => {
    const { patch } = patchGoalReqToPatchInput({
      sessionId: "s",
      tokenBudget: 99_000,
    });
    expect(patch.tokenBudget).toBe(99_000);
  });

  it("reports hasChange=false for an empty patch", () => {
    const { hasChange } = patchGoalReqToPatchInput({ sessionId: "s" });
    expect(hasChange).toBe(false);
  });

  it("rejects an invalid status enum with a 400", () => {
    expect(() =>
      patchGoalReqToPatchInput({ sessionId: "s", status: "bogus" }),
    ).toThrow(ThreadGoalContractError);
  });

  it("accepts every closed status value before store-level transition checks", () => {
    for (const status of [
      "active",
      "paused",
      "blocked",
      "complete",
      "budget_limited",
      "usage_limited",
    ]) {
      const { patch } = patchGoalReqToPatchInput({ sessionId: "s", status });
      expect(patch.status).toBe(status);
    }
  });
});

describe("toThreadGoalContractError", () => {
  it("maps ThreadGoalAlreadyExistsError → 409 GOAL_EXISTS", () => {
    const mapped = toThreadGoalContractError(
      new ThreadGoalAlreadyExistsError("tg_old"),
    );
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe("GOAL_EXISTS");
  });

  it("maps a budget state conflict to a typed 409 response", () => {
    expect(
      toThreadGoalContractError(new ThreadGoalBudgetLimitedError("tg_1")),
    ).toMatchObject({
      status: 409,
      code: "GOAL_BUDGET_LIMITED",
    });
  });

  it('maps a "not found" message → 404', () => {
    expect(toThreadGoalContractError(new Error("goal not found")).status).toBe(
      404,
    );
  });

  it("passes a ThreadGoalContractError through unchanged", () => {
    const err = new ThreadGoalContractError(400, "bad", "VALIDATION_ERROR");
    expect(toThreadGoalContractError(err)).toBe(err);
  });

  it("maps an admitted attachment size failure without exposing the original error", () => {
    const mapped = toThreadGoalContractError(
      Object.assign(new Error("asset_too_large"), {
        status: 413,
        key: "local_attachment_too_large",
      }),
    );

    expect(mapped).toMatchObject({
      status: 413,
      code: "local_attachment_too_large",
      message: "Local attachment is too large to persist",
    });
  });

  it("maps filesystem read failures to a sanitized attachment error", () => {
    const mapped = toThreadGoalContractError(
      Object.assign(new Error("ENOENT: stat 'C:\\Users\\Mira\\private.png'"), {
        code: "ENOENT",
      }),
    );

    expect(mapped).toMatchObject({
      status: 415,
      code: "local_attachment_unreadable",
      message: "Local attachment source is unreadable or invalid",
    });
    expect(mapped.message).not.toContain("Mira");
  });

  it("maps the materializer attachment error contract to a stable Goal response", () => {
    const mapped = toThreadGoalContractError(
      Object.assign(
        new Error("Local attachment source is unreadable or invalid"),
        {
          name: "AttachmentRegistrationError",
          reason: "unreadable",
        },
      ),
    );

    expect(mapped).toMatchObject({
      status: 415,
      code: "local_attachment_unreadable",
      message: "Local attachment source is unreadable or invalid",
    });
  });

  it("falls back to 500 for an unknown error", () => {
    expect(toThreadGoalContractError(new Error("boom")).status).toBe(500);
  });
});
