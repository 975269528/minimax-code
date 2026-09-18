import type { AgentStorePort } from '../contracts.js';
import { validateLookupName } from '../domain/names.js';
import { AgentServiceError } from '../errors.js';

/** Clear only the reference that still points to the session being removed. */
export async function clearRootSessionReference(
  repository: AgentStorePort,
  agentName: string,
  sessionId: string,
  updatedAtMs: number,
): Promise<boolean> {
  // Historical names are exact database keys, not names for new Agent files.
  // Keep the conditional update so missing owners cannot recreate runtime state.
  return repository.update(agentName, {
    mainSessionId: null,
    expectedMainSessionId: sessionId,
    updatedAtMs,
  });
}

export async function setRootSessionReference(
  repository: AgentStorePort,
  agentName: string,
  sessionId: string,
  updatedAtMs: number,
): Promise<boolean> {
  if (!sessionId.trim()) {
    throw new AgentServiceError('AGENT_REQUEST_REF_INVALID', 'Session id is required.');
  }
  const exactName = validateLookupName(agentName);
  if (!(await repository.get(exactName))) return false;
  return repository.update(exactName, { mainSessionId: sessionId, updatedAtMs });
}
