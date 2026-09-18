import { randomUUID } from 'node:crypto';

import {
  VerificationDispatchError,
  type SubagentVerificationExecutionPort,
  type SubagentVerificationRunInput,
  type SubagentVerificationRunResult,
  type VerificationDispatchFailureCode,
  type VerificationTraceRef,
  type VerificationUsage,
} from '@mavis/goal';

import { stripModelVerdictCandidates, type LocalTaskRunResult } from '@mavis/agent-tools/desktop';

import type { LocalTaskRunnerHostWithSessionLookup } from '../api/local-task-host.js';
import { runForegroundLocalTask } from '../api/local-task-runner.js';

/** The subset of dispatch failures a live child run can latch on itself. */
export type GoalVerifierRunIssueCode = Extract<
  VerificationDispatchFailureCode,
  'route_unavailable' | 'capability_violation' | 'child_budget_exhausted'
>;

/** Execution facts a settled child run reports back. Observation only. */
export interface GoalVerifierRunOutcome {
  readonly childTurns: number;
  readonly tokens: number;
  readonly usageIncomplete: boolean;
  readonly issue?: {
    readonly code: GoalVerifierRunIssueCode;
    readonly message: string;
  };
}

/**
 * Per-run counter owned by the runtime that hosts the child's Turn hooks.
 *
 * The child runs on the ordinary delegation path, so nothing here authorizes
 * it — it holds any configured execution caps and the counters those caps are
 * checked against, and reports what the run actually spent.
 */
export interface GoalVerifierRunRegistry {
  register(input: {
    readonly runId: string;
    readonly maxTurns?: number;
    readonly maxTokens?: number;
    readonly workerRouteProvider: string;
    readonly hostContext: SubagentVerificationRunInput['attempt']['hostContext'];
  }): void;
  release(runId: string): GoalVerifierRunOutcome | undefined;
}

export interface GoalVerifierExecutionObserver {
  onChildStarted(input: {
    readonly attempt: SubagentVerificationRunInput['attempt'];
    readonly traceRef: VerificationTraceRef;
  }): void;
}

/**
 * Runs the Goal verifier child as an ordinary foreground delegation.
 *
 * Everything the bespoke runtime used to build by hand — hidden child Session,
 * background task row, abort plumbing, verdict parsing — already exists on this
 * path and is exercised by every other `task` call. What stays Goal-specific is
 * the run id stamped into the child Turn's origin, which is what lets the host
 * recognize the Turn and attach the verifier reminder, the narrow tool guard,
 * and this run's caps.
 */
export function createLocalGoalVerifierExecution(
  host: LocalTaskRunnerHostWithSessionLookup,
  registry: GoalVerifierRunRegistry,
  observer?: GoalVerifierExecutionObserver,
): SubagentVerificationExecutionPort {
  return {
    async run(input): Promise<SubagentVerificationRunResult> {
      const parent = await host.getSessionById(input.attempt.sessionId);
      if (!parent) {
        throw dispatchFailure('spawn_failed', 'Goal verifier parent Session is unavailable.');
      }
      const workerRouteProvider = modelRouteProvider(input.attempt.workerModelKey);
      if (!workerRouteProvider) {
        throw dispatchFailure(
          'route_unavailable',
          'Goal verifier worker data route is unavailable.',
        );
      }

      const runId = randomUUID();
      const startedAt = Date.now();
      registry.register({
        runId,
        ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        workerRouteProvider,
        hostContext: input.attempt.hostContext,
      });
      // Released on every exit so a crashed run cannot leave its caps behind
      // for the next one; the outcome below is read from that same release.
      let outcome: GoalVerifierRunOutcome | undefined;
      const releaseRun = (): void => {
        outcome = registry.release(runId);
      };
      const elapsed = (): number => Math.max(0, Math.ceil((Date.now() - startedAt) / 1_000));
      /**
       * A latched issue always wins: it names what actually stopped the run,
       * while the delegation result only reports that the Turn ended.
       */
      const failure = (
        code: VerificationDispatchFailureCode,
        message: string,
        traceRef?: VerificationTraceRef,
      ): VerificationDispatchError =>
        outcome?.issue
          ? dispatchFailure(
              outcome.issue.code,
              outcome.issue.message,
              childUsage(outcome, elapsed()),
              traceRef,
            )
          : dispatchFailure(code, message, childUsage(outcome, elapsed()), traceRef);

      let result: LocalTaskRunResult;
      try {
        result = await runForegroundLocalTask({
          host,
          parentSession: parent,
          toolCtx: {
            sessionId: parent.sessionId,
            turnId: input.attempt.turnId,
            toolCallId: `goal-verifier:${runId}`,
          },
          taskInput: {
            description: 'Goal verification',
            prompt: input.prompt,
            agent_name: 'verifier',
            // Pins the child to the settled worker's data route rather than
            // letting the target Agent or inherited Session selection pick a different provider.
            model: input.attempt.workerModelKey,
          },
          origin: {
            goalVerifier: {
              runId,
              profile: input.profile,
              parentGoalId: input.attempt.goalId,
              parentTurnId: input.attempt.turnId,
            },
          },
          onChildStarted: (child) => {
            const traceRef = { sessionId: child.subSessionId, turnId: child.subTurnId };
            try {
              input.onTrace?.(traceRef);
            } catch {
              // The verifier's own trace propagation is best-effort.
            }
            try {
              observer?.onChildStarted({ attempt: input.attempt, traceRef });
            } catch {
              // Runtime observation must never change verifier execution.
            }
          },
          signal: input.signal,
        }).finally(releaseRun);
      } catch (error) {
        throw input.signal.aborted
          ? failure('aborted', 'Goal verifier child was aborted.')
          : failure('child_crash', describeError(error));
      }

      if (outcome?.issue) {
        const traceRef = traceRefOf(result);
        throw dispatchFailure(
          outcome.issue.code,
          outcome.issue.message,
          childUsage(outcome, elapsed()),
          traceRef,
        );
      }
      // A result that lands after cancellation is discarded: the dispatching
      // adapter stopped waiting on this run, so it must never become a verdict.
      if (input.signal.aborted) {
        throw failure('aborted', 'Goal verifier child was aborted.', traceRefOf(result));
      }
      if (result.status !== 'succeeded') {
        throw failure(
          result.status === 'aborted' ? 'aborted' : 'child_crash',
          result.errorMessage ?? 'Goal verifier child failed.',
          traceRefOf(result),
        );
      }

      const parsedVerdict = result.verification?.modelVerdict;
      const traceRef = traceRefOf(result);
      return {
        finalText: result.finalText ?? '',
        verdictProse: stripModelVerdictCandidates(result.finalText ?? ''),
        ...(parsedVerdict ? { modelVerdict: parsedVerdict } : {}),
        tokens: outcome ? outcome.tokens : null,
        childTurns: outcome?.childTurns ?? 0,
        incomplete: outcome?.usageIncomplete ?? true,
        ...(traceRef ? { traceRef } : {}),
      };
    },
  };
}

function childUsage(
  outcome: GoalVerifierRunOutcome | undefined,
  activeSeconds: number,
): VerificationUsage {
  return outcome
    ? {
        tokens: outcome.tokens,
        activeSeconds,
        childTurns: outcome.childTurns,
        incomplete: outcome.usageIncomplete,
      }
    : { tokens: null, activeSeconds, childTurns: 0, incomplete: true };
}

function dispatchFailure(
  code: VerificationDispatchFailureCode,
  message: string,
  usage: VerificationUsage = { tokens: null, activeSeconds: 0, childTurns: 0, incomplete: true },
  traceRef?: VerificationTraceRef,
): VerificationDispatchError {
  return new VerificationDispatchError(code, message, usage, { traceRef });
}

function traceRefOf(result: LocalTaskRunResult): VerificationTraceRef | undefined {
  return result.subSessionId
    ? {
        sessionId: result.subSessionId,
        ...(result.subTurnId ? { turnId: result.subTurnId } : {}),
      }
    : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Provider half of a source-qualified model key (`custom_provider:acme/model`). */
function modelRouteProvider(modelKey: string): string | undefined {
  const normalized = modelKey.trim();
  const separator = normalized.indexOf('/');
  return separator > 0 && separator < normalized.length - 1
    ? normalized.slice(0, separator)
    : undefined;
}
