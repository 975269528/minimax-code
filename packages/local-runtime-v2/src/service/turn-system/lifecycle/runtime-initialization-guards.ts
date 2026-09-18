import type { AgentHostRuntimeLifecycle } from '../agent-host/native-production-dependencies.js';
import type { TurnSystemOwner } from '../contracts.js';

export function requireAgentRuntime(
  lifecycle: AgentHostRuntimeLifecycle | undefined,
): AgentHostRuntimeLifecycle {
  if (!lifecycle) throw new Error('AgentHost runtime lifecycle was not initialized.');
  return lifecycle;
}

export function requireTurnSystem(owner: TurnSystemOwner | undefined): TurnSystemOwner {
  if (!owner) throw new Error('TurnSystem is not initialized.');
  return owner;
}
