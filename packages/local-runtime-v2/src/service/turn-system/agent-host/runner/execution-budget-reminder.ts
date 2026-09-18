import type { PiBeforeLlmCallHook, PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';
import type { ExecutionBudgetReminderAdmission } from '../execution/contracts.js';

/**
 * Request-only context; the caller's existing cancellation timer remains
 * authoritative. `replaceRequestMessages` keeps the marker out of durable
 * history, so it must be registered before any hook that returns
 * `appendMessage` — `runBeforeLLM` ends the pipeline on a successful append.
 */
export function createExecutionBudgetReminder(
  executionDeadlineAtMs: number | undefined,
  nowMs: () => number = Date.now,
  canAppend?: ExecutionBudgetReminderAdmission,
  logger?: Pick<PiTurnRunnerLogger, 'info'>,
): PiBeforeLlmCallHook | undefined {
  if (executionDeadlineAtMs === undefined || !canAppend) return undefined;
  let previousSampleAtMs: number | undefined;
  return (input) => {
    try {
      if (input.signal?.aborted) return undefined;
      const now = nowMs();
      const remainingMs = executionDeadlineAtMs - now;
      if (remainingMs <= 0) return undefined;
      const elapsedMs =
        previousSampleAtMs !== undefined && now >= previousSampleAtMs
          ? now - previousSampleAtMs
          : undefined;
      previousSampleAtMs = now;
      const elapsed =
        elapsedMs !== undefined
          ? ` Since the previous model request was prepared: ${Math.floor(elapsedMs / 1_000)} seconds (model generation, tools, and waiting).`
          : ' This budget includes model generation, tools, and waiting.';
      const marker = {
        role: 'user' as const,
        content: `<system-reminder>Execution time remaining at request preparation: ${Math.ceil(remainingMs / 1_000)} seconds.${elapsed}</system-reminder>`,
        timestamp: now,
      };
      if (!canAppend(input, marker)) return undefined;
      try {
        logger?.info?.(
          {
            session_id: input.sessionId,
            turn_id: input.turnId,
            sampled_at_ms: now,
            remaining_ms: remainingMs,
            elapsed_since_previous_request_ms: elapsedMs ?? null,
          },
          'execution budget context sampled',
        );
      } catch {
        // Diagnostics must not affect the request context.
      }
      return {
        type: 'replaceRequestMessages',
        reason: 'execution-budget-context',
        messages: [...input.messages, marker],
      };
    } catch {
      return undefined;
    }
  };
}
