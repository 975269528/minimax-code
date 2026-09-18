import { createAgentRuntime } from '@mavis/agent-runtime';

import type { AgentExecutionSnapshot, AgentHostDependencies } from './contracts.js';

export type EmptyAgentHostCapability =
  | 'agent-runtime'
  | 'session-system-read'
  | 'agent-execution-source'
  | 'turn-preparation'
  | 'compaction-preparation'
  | 'context-compactor'
  | 'compaction-control'
  | 'compaction-lifecycle'
  | 'canonical-history'
  | 'agent-event-delivery'
  | 'local-turn-executor'
  | 'turn-control'
  | 'canonical-history-provider'
  | 'session-event-projector'
  | 'message-event-projector'
  | 'message-history-projector'
  | 'stream-event-projector'
  | 'turn-fact-event-projector'
  | 'history-failure-projector'
  | 'history-settle-turn-tail'
  | 'history-retract-turn'
  | 'local-runtime-turn-runner'
  | 'turn-execution-preparation'
  | 'turn-file-change-lifecycle'
  | 'attachment-materializer'
  | 'background-reminder-facts'
  | 'background-task-read-confirmation'
  | 'system-reminder-facts'
  | 'permission-decision-source'
  | 'permission-approval-owner'
  | 'permission-execution-plan-validator'
  | 'usage-projector';

const unavailableMarkers = new WeakMap<object, EmptyAgentHostCapability>();

export class AgentHostDependencyUnavailableError extends Error {
  override readonly name = 'AgentHostDependencyUnavailableError';

  constructor(readonly capability: EmptyAgentHostCapability) {
    super(`AgentHost dependency is not wired: ${capability}.`);
  }
}

/**
 * Explicit placeholder for target branches that do not yet have every owner.
 *
 * This is an all-or-nothing sentinel. LocalAgentHost rejects any dependency bag
 * that still contains one of these placeholders before execution starts.
 */
export async function createEmptyAgentHostDependencies<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
>(): Promise<AgentHostDependencies<TAgent>> {
  const normal = await createAgentRuntime({ base: [] });
  return {
    sessions: {
      get: unavailableAsync('session-system-read'),
    },
    agentRuntimes: {
      normal: {
        assembleModelContext: unavailableAsync('agent-runtime'),
        assembleTurn: (context) => normal.assembleTurn(context),
      },
    },
    agents: {
      getExecutionSnapshot: unavailableAsync('agent-execution-source'),
    },
    preparation: {
      prepare: unavailableAsync('turn-preparation'),
    },
    history: {
      read: unavailableAsync('canonical-history'),
      append: unavailableAsync('canonical-history'),
      replace: unavailableAsync('canonical-history'),
      settleTurnTail: unavailableAsync('history-settle-turn-tail'),
      retractTurn: unavailableAsync('history-retract-turn'),
    },
    events: {
      handleRuntimeEvent: unavailableAsync('agent-event-delivery'),
      handleHistoryCommitted: unavailableAsync('agent-event-delivery'),
    },
    executor: {
      execute: unavailableAsync('local-turn-executor'),
    },
    compaction: {
      preparation: {
        prepareCompaction: unavailableAsync('compaction-preparation'),
      },
      automatic: {
        compactBeforeLlm: unavailableAsync('context-compactor'),
      },
      manual: {
        compactManual: unavailableAsync('context-compactor'),
      },
      control: {
        beginClose: unavailableSync('compaction-control'),
      },
      lifecycle: {
        completeCommittedHistory: unavailableAsync('compaction-lifecycle'),
        failCommittedHistory: unavailableAsync('compaction-lifecycle'),
      },
    },
    turnControl: {
      scope: unavailableSync('turn-control'),
    },
  };
}

export function assertAgentHostDependenciesReady<TAgent extends AgentExecutionSnapshot>(
  dependencies: AgentHostDependencies<TAgent>,
): void {
  assertAgentHostCapabilityAvailable(
    'session-system-read',
    typeof dependencies.sessions?.get === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'agent-runtime',
    typeof dependencies.agentRuntimes?.normal?.assembleTurn === 'function' &&
      typeof dependencies.agentRuntimes.normal.assembleModelContext === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'local-turn-executor',
    typeof dependencies.executor?.execute === 'function',
  );
  assertNoUnavailableFunctions(dependencyFunctions(dependencies));
}

export function assertAgentHostCompactionDependenciesReady<TAgent extends AgentExecutionSnapshot>(
  dependencies: AgentHostDependencies<TAgent>,
): void {
  const compaction = dependencies.compaction;
  assertAgentHostCapabilityAvailable(
    'session-system-read',
    typeof dependencies.sessions?.get === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'agent-runtime',
    typeof dependencies.agentRuntimes?.normal?.assembleModelContext === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'agent-execution-source',
    typeof dependencies.agents?.getExecutionSnapshot === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'canonical-history',
    typeof dependencies.history?.read === 'function' &&
      typeof dependencies.history.replace === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'agent-event-delivery',
    typeof dependencies.events?.handleHistoryCommitted === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'compaction-preparation',
    typeof compaction?.preparation?.prepareCompaction === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'context-compactor',
    typeof compaction?.automatic?.compactBeforeLlm === 'function' &&
      typeof compaction.manual?.compactManual === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'compaction-control',
    typeof compaction?.control?.beginClose === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'compaction-lifecycle',
    typeof compaction?.lifecycle?.completeCommittedHistory === 'function' &&
      typeof compaction.lifecycle.failCommittedHistory === 'function',
  );
  assertNoUnavailableFunctions(compactionDependencyFunctions(dependencies));
}

function assertNoUnavailableFunctions(dependencies: readonly unknown[]): void {
  const capability = dependencies
    .map((dependency) =>
      typeof dependency === 'function' ? unavailableMarkers.get(dependency) : undefined,
    )
    .find((candidate) => candidate !== undefined);
  if (capability) throw new AgentHostDependencyUnavailableError(capability);
}

export function assertAgentHostCapabilityAvailable(
  capability: EmptyAgentHostCapability,
  available: boolean,
): void {
  if (!available) throw new AgentHostDependencyUnavailableError(capability);
}

function dependencyFunctions<TAgent extends AgentExecutionSnapshot>(
  dependencies: AgentHostDependencies<TAgent>,
): readonly unknown[] {
  return [
    dependencies.sessions.get,
    dependencies.agents.getExecutionSnapshot,
    dependencies.preparation.prepare,
    dependencies.history.read,
    dependencies.history.append,
    dependencies.history.replace,
    dependencies.history.settleTurnTail,
    dependencies.history.retractTurn,
    dependencies.events.handleRuntimeEvent,
    dependencies.events.handleHistoryCommitted,
    dependencies.executor.execute,
    dependencies.turnControl.scope,
    ...compactionDependencyFunctions(dependencies),
  ];
}

function compactionDependencyFunctions<TAgent extends AgentExecutionSnapshot>(
  dependencies: AgentHostDependencies<TAgent>,
): readonly unknown[] {
  return [
    dependencies.sessions?.get,
    dependencies.agents?.getExecutionSnapshot,
    dependencies.history?.read,
    dependencies.history?.replace,
    dependencies.events?.handleHistoryCommitted,
    dependencies.agentRuntimes?.normal?.assembleModelContext,
    dependencies.compaction?.preparation?.prepareCompaction,
    dependencies.compaction?.automatic?.compactBeforeLlm,
    dependencies.compaction?.manual?.compactManual,
    dependencies.compaction?.control?.beginClose,
    dependencies.compaction?.lifecycle?.completeCommittedHistory,
    dependencies.compaction?.lifecycle?.failCommittedHistory,
  ];
}

function unavailableAsync<T>(capability: EmptyAgentHostCapability): () => Promise<T> {
  return markUnavailable(capability, () =>
    Promise.reject(new AgentHostDependencyUnavailableError(capability)),
  );
}

function unavailableSync<T>(capability: EmptyAgentHostCapability): () => T {
  return markUnavailable(capability, () => {
    throw new AgentHostDependencyUnavailableError(capability);
  });
}

function markUnavailable<T extends object>(capability: EmptyAgentHostCapability, value: T): T {
  unavailableMarkers.set(value, capability);
  return value;
}
