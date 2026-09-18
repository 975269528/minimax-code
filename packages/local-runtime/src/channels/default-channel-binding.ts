import type { LocalChannelBinding, LocalChannelContext, LocalChannelBridgeInfra } from './infra.js';
import type { ChannelPlatform } from './route-api.js';

export function buildAgentDefaultChannelContext(
  platform: ChannelPlatform,
  agentName: string,
  clientName: string,
): LocalChannelContext {
  return {
    platform,
    chatType: 'agent',
    chatId: agentName,
    senderId: agentName,
    clientName,
    lane: 'interactive',
  };
}

export async function bindAgentDefaultChannelBinding(
  infra: LocalChannelBridgeInfra,
  platform: ChannelPlatform,
  agentName: string,
  clientName: string,
): Promise<LocalChannelBinding | undefined> {
  const ctx = buildAgentDefaultChannelContext(platform, agentName, clientName);
  // Migration doc §Integration point 4: initialise the Access Control default
  // policy for the freshly-bound clientName so a UI panel can edit it
  // without an explicit API call. Best-effort and never overrides an
  // existing entry — see `LocalAccessControlStore.ensureDefaultPolicy`.
  if (infra.accessControlStore) {
    await infra.accessControlStore.ensureDefaultPolicy(platform, clientName);
  }
  // This helper is used only by pre-Connection bind ingress. Keep those
  // callers compatible for one transition period without allowing any new
  // `connection_id` chain to synthesize legacy route rows.
  const route = await infra.routeResolver.resolveLegacy(ctx);
  if (route.blocked || !route.sessionId) return undefined;
  return route.binding;
}

export async function deleteAgentPlatformChannelBindings(
  infra: LocalChannelBridgeInfra,
  platform: ChannelPlatform,
  agentName: string,
): Promise<number> {
  const bindings = await infra.bindingStore.list({ agentName });
  let deleted = 0;
  for (const binding of bindings) {
    if (binding.platform !== platform) continue;
    if (await infra.bindingStore.deleteByKey(binding.key)) deleted++;
  }
  return deleted;
}
