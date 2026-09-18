interface AgentChannelBinding {
  platform: string;
  clientName: string;
  sessionId: string;
  strategy: string;
}

interface AgentChannelBindingStore {
  list(filter: { agentName?: string }): Promise<AgentChannelBinding[]>;
  getMessageFilter(clientId: string): Promise<unknown>;
}

export async function buildAgentChannelConfig(
  bindingStore: AgentChannelBindingStore,
  agentName: string,
): Promise<Record<string, unknown> | undefined> {
  const bindings = await bindingStore.list({ agentName });
  if (bindings.length === 0) return undefined;
  const config: Record<string, unknown> = {};
  for (const binding of bindings) {
    if (config[binding.platform]) continue;
    config[binding.platform] = {
      session: {
        strategy: binding.strategy === 'pin' ? 'root' : binding.strategy,
        pinned_session_id: null,
      },
      message_filter: await bindingStore.getMessageFilter(binding.clientName),
    };
  }
  return config;
}

/**
 * Build the read-only channel config for one resolved AgentName family.
 *
 * Bindings stay exact-owner records. A platform can be merged when it has a
 * single configured family owner; two different owners on the same platform
 * are intentionally surfaced as ambiguity instead of selecting whichever
 * binding happens to be listed first.
 */
export async function buildAgentChannelConfigForAgents(
  bindingStore: AgentChannelBindingStore,
  agentNames: readonly string[],
): Promise<{
  config?: Record<string, unknown>;
  candidates: Array<{ agentName: string; platform: string }>;
}> {
  const names = [...new Set(agentNames)].filter((name) => name.length > 0);
  const config: Record<string, unknown> = {};
  const owners = new Map<string, string>();
  const candidates: Array<{ agentName: string; platform: string }> = [];
  const seenCandidates = new Set<string>();

  for (const agentName of names) {
    const ownerConfig = await buildAgentChannelConfig(bindingStore, agentName);
    if (!ownerConfig) continue;
    for (const [platform, value] of Object.entries(ownerConfig)) {
      const existingOwner = owners.get(platform);
      if (existingOwner !== undefined && existingOwner !== agentName) {
        for (const candidate of [
          { agentName: existingOwner, platform },
          { agentName, platform },
        ]) {
          const key = `${candidate.platform}:${candidate.agentName}`;
          if (seenCandidates.has(key)) continue;
          seenCandidates.add(key);
          candidates.push(candidate);
        }
        continue;
      }
      if (existingOwner === undefined) {
        owners.set(platform, agentName);
        config[platform] = value;
      }
    }
  }

  return {
    ...(Object.keys(config).length > 0 ? { config } : {}),
    candidates,
  };
}
