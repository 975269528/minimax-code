import type { ChannelPlatform } from './route-api.js';
import type { LocalChannelContext, LocalChannelRoutePreview } from './infra.js';

/**
 * Owner-default routing for per-agent channel clients.
 *
 * Local IM bindings name their outbound client after the owning agent
 * (`wechat:<agentName>`, `telegram:<agentName>`, bare agent name for Feishu).
 * When no explicit route rule matches, the inbound turn should still land on
 * that agent's own root session instead of the global default agent. These
 * helpers derive the owner agent from the client name and patch the default
 * route preview accordingly.
 */
export function applyClientOwnerDefault(
  preview: LocalChannelRoutePreview,
  ctx: LocalChannelContext,
): LocalChannelRoutePreview {
  // Explicit route rules are operator intent and must win. The owner fallback
  // only fixes the no-rule/default-route path for per-agent channel clients
  // such as `wechat:<agentName>` and `telegram:<agentName>`.
  if (preview.ruleId) return preview;
  const ownerAgentName = inferAgentNameFromChannelClient(ctx.platform, ctx.clientName);
  if (!ownerAgentName) return preview;
  return { ...preview, agentId: ownerAgentName, ownerDefaultApplied: true };
}

function inferAgentNameFromChannelClient(
  platform: ChannelPlatform,
  clientName: string,
): string | undefined {
  const trimmed = clientName.trim();
  if (!trimmed) return undefined;

  if (platform === 'wechat') return readPrefixedClientAgent(trimmed, 'wechat');
  if (platform === 'telegram') return readPrefixedClientAgent(trimmed, 'telegram');

  // Feishu local bindings intentionally use the bare agent name as clientId
  // for DesktopService compatibility. Avoid treating generic legacy client
  // names (`feishu`, `feishu:bot`, `lark:bot`) as agent ids.
  if (platform === 'feishu') {
    const lower = trimmed.toLowerCase();
    if (lower === 'feishu' || lower === 'lark') return undefined;
    if (lower.startsWith('feishu:') || lower.startsWith('lark:')) return undefined;
    return trimmed;
  }

  return undefined;
}

function readPrefixedClientAgent(
  clientName: string,
  platform: ChannelPlatform,
): string | undefined {
  const prefix = `${platform}:`;
  if (!clientName.toLowerCase().startsWith(prefix)) return undefined;
  const agentName = clientName.slice(prefix.length).trim();
  return agentName || undefined;
}

export function inferPlatformFromClientName(clientName: string): ChannelPlatform | undefined {
  const lower = clientName.toLowerCase();
  if (lower.startsWith('telegram') || lower.includes(':telegram')) return 'telegram';
  if (lower.startsWith('wechat') || lower.includes(':wechat')) return 'wechat';
  if (lower.startsWith('feishu') || lower.startsWith('lark') || lower.includes(':feishu')) {
    return 'feishu';
  }
  return undefined;
}
