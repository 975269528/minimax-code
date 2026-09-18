/**
 * Thread Goal wiring helpers for {@link LocalApiHost}.
 *
 * Pulled out of `api/host.ts` to keep the host under the 2000-line
 * cap. The helpers here are deliberately tiny and stateless — they take
 * the bare minimum of dependencies (the SQLite-backed store + a
 * `GlobalEventPublisher`) so the host can keep its inline routing
 * branches short.
 */

import {
  GetGoalTool,
  renderContinuationPrompt,
  renderKickoffPrompt,
  UpdateGoalTool,
  type ThreadGoalSignalCollector,
  type ThreadGoalStore,
  type ThreadGoalTokenBudgetMutationPort,
} from "@mavis/goal";
import {
  toRuntimeTool,
  type RuntimeTool,
  type ToolExecutionContext,
} from "@mavis/agent-core/tools";
import type { TSchema } from "@sinclair/typebox";

import type { ThreadGoalChangedEvent } from "./events.js";
import type { GlobalEventPublisher } from "../events/global-events.js";

/**
 * Translate a {@link ThreadGoalChangedEvent} from the REST router into one
 * of the two Global Events the UI consumes (`thread_goal.updated` /
 * `thread_goal.cleared`).
 *
 * Host-settled model proposals route through here only after their durable
 * state CAS succeeds, so the banner never renders an unaccepted proposal.
 */
export function publishThreadGoalEvent(
  publish: GlobalEventPublisher,
  event: ThreadGoalChangedEvent,
): void {
  if (event.type === "deleted") {
    publish({
      type: "thread_goal.cleared",
      payload: { goalId: event.goalId, sessionId: event.sessionId },
    });
    return;
  }
  publish({
    type: "thread_goal.updated",
    payload: {
      goal: {
        goalId: event.goal.goalId,
        sessionId: event.goal.sessionId,
        objective: event.goal.objective,
        status: event.goal.status,
        createdAt: event.goal.createdAt,
        updatedAt: event.goal.updatedAt,
        tokensUsed: event.goal.tokensUsed,
        turnsUsed: event.goal.turnsUsed,
        timeUsedSeconds: event.goal.timeUsedSeconds,
        tokenBudget: event.goal.tokenBudget,
        statusReason: event.goal.statusReason,
        executionWait: event.goal.executionWait,
        ...(event.goal.lastVerification !== undefined
          ? {
              lastVerification: {
                backend: event.goal.lastVerification.backend,
                verdict: event.goal.lastVerification.verdict,
                reason: event.goal.lastVerification.reason,
                missing: [...event.goal.lastVerification.missing],
                notMetStreak: event.goal.lastVerification.notMetStreak,
                at: event.goal.lastVerification.at,
              },
            }
          : {}),
        hasKickoffAttachments: event.goal.kickoffAttachments.length > 0,
      },
    },
  });
}

/**
 * Build the model-facing Thread Goal lifecycle tools (`update_goal` /
 * `get_goal`) bound to the shared `ThreadGoalStore`. Goal creation is a
 * user-owned product action and is intentionally not exposed to the
 * local-runtime model.
 *
 * Returns an empty array when the host has disabled built-in tools for
 * the turn (e.g. the agent config opts out). The 2 impls deliberately
 * share the same store so the orchestrator's between-turn status check
 * sees the model's writes immediately.
 *
 * `update_goal` records terminal proposals through the host collector and
 * delegates token-budget edits to the supplied host mutation port.
 */
export function buildThreadGoalRuntimeTools(
  store: ThreadGoalStore,
  disabled: boolean,
  signalCollector: ThreadGoalSignalCollector,
  budgetMutation?: ThreadGoalTokenBudgetMutationPort,
): RuntimeTool<TSchema, ToolExecutionContext>[] {
  if (disabled) return [];
  return [
    toRuntimeTool(new UpdateGoalTool(store, signalCollector, budgetMutation)),
    toRuntimeTool(new GetGoalTool(store)),
  ];
}

/**
 * codex `continue_if_idle` parity (ext/goal/runtime.rs): when an
 * external mutation (REST create / patch) leaves the goal ACTIVE while
 * the session has no running turn, immediately start a continuation
 * turn — `/goal <objective>` and `/goal resume` begin working without
 * waiting for the next user message.
 *
 * Tool-path mutations also arrive here, but the session is mid-turn
 * then, so the busy gate skips them — the in-stream orchestrator owns
 * continuation in that case. Cross-process busy races are caught by the
 * message route's session-lock gate (it answers 409, which we treat as
 * a benign skip like any other failure).
 */
export async function maybeKickThreadGoalContinuation(
  event: ThreadGoalChangedEvent,
  deps: {
    isSessionBusy: (sessionId: string) => boolean;
    /** Start a hidden continuation turn (no user display message). */
    startContinuationTurn: (
      sessionId: string,
      content: string,
    ) => Promise<unknown>;
  },
): Promise<void> {
  if (event.type === "deleted") return;
  if (event.goal.status !== "active") return;
  if (deps.isSessionBusy(event.goal.sessionId)) return;
  try {
    const prompt =
      event.type === "created"
        ? renderKickoffPrompt(event.goal)
        : renderContinuationPrompt(event.goal);
    await deps.startContinuationTurn(event.goal.sessionId, prompt);
  } catch {
    // Busy-lock races and transient turn-start failures are benign: the
    // goal stays active and the orchestrator resumes it on the next
    // user-initiated turn.
  }
}

/**
 * Single entry point for the host's goal-change hook: project the
 * mutation onto the SSE bus, then attempt the continue_if_idle kick.
 * Keeps `api/host.ts` to a one-call wiring under its line cap.
 */
export function handleThreadGoalChanged(
  event: ThreadGoalChangedEvent,
  deps: {
    publishGlobalEvent: GlobalEventPublisher;
    isSessionBusy: (sessionId: string) => boolean;
    startContinuationTurn: (
      sessionId: string,
      content: string,
    ) => Promise<unknown>;
  },
): void {
  publishThreadGoalEvent(deps.publishGlobalEvent, event);
  void maybeKickThreadGoalContinuation(event, deps);
}
