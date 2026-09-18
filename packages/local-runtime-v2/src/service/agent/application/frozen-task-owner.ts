import {
  isTrustedBuiltinCreationSource,
  toAgentRequestRef,
} from '@mavis/agent-tools/desktop/subagent-roles';

import { canonicalBuiltinName } from '../builtin/catalog.js';
import type { AgentStoreMeta, AgentStorePort, AgentView } from '../contracts.js';
import { validateLookupName } from '../domain/names.js';

/** Reads a frozen Task owner without opening mutable Custom-Agent files. */
export async function readFrozenTaskOwner(
  repository: AgentStorePort,
  exactOwnerName: string,
  readTrustedBuiltin: (meta: AgentStoreMeta, canonicalViewName: string) => Promise<AgentView>,
): Promise<AgentView | undefined> {
  const exact = validateLookupName(exactOwnerName);
  const meta = await repository.get(exact);
  if (!meta) return undefined;
  const canonicalViewName = canonicalBuiltinName(meta.name);
  if (isTrustedBuiltinCreationSource(meta.creationSource)) {
    return readTrustedBuiltin(meta, canonicalViewName);
  }
  const requestRef =
    toAgentRequestRef({ name: meta.name, creationSource: meta.creationSource }) ?? meta.name;
  return {
    name: meta.name,
    requestRef,
    canonicalViewName: meta.name,
    exactOwnerName: meta.name,
    resolvedAgentName: meta.name,
    agentRole: meta.agentRole,
    creationSource: meta.creationSource,
    ...(meta.rootSessionId ? { rootSessionId: meta.rootSessionId } : {}),
    displayName: meta.name,
    createdAtMs: meta.createdAtMs,
    updatedAtMs: meta.updatedAtMs,
  };
}
