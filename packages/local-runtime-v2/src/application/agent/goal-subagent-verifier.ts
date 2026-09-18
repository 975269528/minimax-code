import { GOAL_VERIFIER_READONLY_PROFILE } from '@mavis/config';
import {
  createSubagentVerifierAdapter,
  VerificationDispatchError,
  type SubagentVerificationExecutionPort,
  type VerifierPort,
} from '@mavis/goal';
import type { AgentExtension } from '@mavis/agent-runtime';

import type { LocalConversationRuntimeConfig } from '../../service/model-system/index.js';
import {
  createGoalVerifierChildExtension,
  createGoalVerifierOutputTokenCapResolver,
  GoalVerifierChildCoordinator,
  type GoalVerifierOutputTokenCapResolver,
} from './goal-subagent-coordinator.js';

export interface GoalSubagentVerifierOptions {
  /**
   * The v1 delegation runner this backend dispatches into. Absent on a host
   * with no local task path, where subagent verification cannot run at all.
   */
  readonly createExecution: (
    registry: GoalVerifierChildCoordinator,
  ) => SubagentVerificationExecutionPort | undefined;
  readonly config: () => LocalConversationRuntimeConfig;
  readonly nowMs?: () => number;
}

export interface GoalSubagentVerifierRuntime {
  readonly verifier: VerifierPort;
  readonly extension: AgentExtension;
  /** Binds an opt-in attempt cap to every provider request of the child Turn. */
  readonly outputTokenCap: GoalVerifierOutputTokenCapResolver;
}

/**
 * Composes the Goal verifier backend: the generic adapter, the per-run counter
 * that the child Turn's hooks feed, and the reminder that carries the
 * verification contract.
 *
 * The child itself is an ordinary `verifier` delegation. Nothing here creates a
 * Session, submits a Turn, or touches a Goal repository.
 */
export function createGoalSubagentVerifierRuntime(
  options: GoalSubagentVerifierOptions,
): GoalSubagentVerifierRuntime {
  const coordinator = new GoalVerifierChildCoordinator();
  const execution = options.createExecution(coordinator);
  return {
    extension: createGoalVerifierChildExtension(coordinator),
    outputTokenCap: createGoalVerifierOutputTokenCapResolver(coordinator),
    verifier: {
      async dispatch(attempt, signal) {
        if (!execution) {
          throw new VerificationDispatchError(
            'route_unavailable',
            'This host has no local delegation path for the Goal verifier child.',
            { tokens: 0, activeSeconds: 0, childTurns: 0, incomplete: false },
          );
        }
        const policy = options.config().goal?.subagent;
        return createSubagentVerifierAdapter({
          profile: policy?.profile ?? GOAL_VERIFIER_READONLY_PROFILE,
          requiredProfile: GOAL_VERIFIER_READONLY_PROFILE,
          ...(policy?.maxTurns !== undefined ? { maxTurns: policy.maxTurns } : {}),
          ...(policy?.maxTokens !== undefined ? { maxTokens: policy.maxTokens } : {}),
          ...(policy?.timeoutSeconds !== undefined
            ? { timeoutSeconds: policy.timeoutSeconds }
            : {}),
          execution,
          ...(options.nowMs ? { nowMs: options.nowMs } : {}),
        }).dispatch(attempt, signal);
      },
    },
  };
}
