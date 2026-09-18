import { validateLookupName } from '../domain/names.js';
import type { AgentStorePort } from '../contracts.js';

export async function readAgentGreetingState(
  repository: AgentStorePort,
  exactOwnerName: string,
): Promise<{ readonly greetingSent: boolean; readonly rootSessionId?: string } | undefined> {
  const meta = await repository.get(validateLookupName(exactOwnerName));
  if (!meta) return undefined;
  return {
    greetingSent: meta.greetingSent,
    ...(meta.rootSessionId === undefined ? {} : { rootSessionId: meta.rootSessionId }),
  };
}

export function markAgentGreetingSent(
  repository: AgentStorePort,
  exactOwnerName: string,
  nowMs: number,
): Promise<boolean> {
  return repository.update(validateLookupName(exactOwnerName), {
    greetingSent: true,
    updatedAtMs: nowMs,
  });
}
