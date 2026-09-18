import { imLogger as logger } from '../common/im-logger.js';
import type { LocalAccessControlStore } from './access-control-store.js';
import type { ChannelFamilyUnbindSnapshot } from './channel-family-mutation.js';
import type { LocalChannelBindingStore } from './infra.js';
import { clearOwnerAllConventions, type LocalChannelOwnerStore } from './owner-store.js';
import type { PrimaryFamilyPlatformPort } from './primary-agent-family-platforms.js';
import { LocalChannelRouteStore, type ChannelPlatform } from './route-api.js';

/** The primary-family names resolved by the host Agent resolver. */
export interface PrimaryAgentFamilyUnbindScope {
  readonly canonicalName: string;
  /** Exact credential/transport owner selected by Agent core. */
  readonly winnerName: string;
  readonly legacyNames: readonly string[];
}

/** Dependencies needed only while removing a primary-family credential. */
export interface PrimaryAgentFamilyUnbindCleanupInput {
  readonly bindingStore: LocalChannelBindingStore;
  readonly ownerStore: LocalChannelOwnerStore;
  readonly accessControlStore?: LocalAccessControlStore;
  readonly dataDir: () => string;
  readonly nowMs: () => number;
  readonly defaultAgentName: string;
  teardownTransport(platform: ChannelPlatform, agentName: string): Promise<void> | void;
  unregisterTransport(platform: ChannelPlatform, clientId: string): void;
}

/**
 * Clean up the exact client a primary-family unbind just deleted, before the
 * follow-up reconcile. Route cleanup is intentionally scoped to the matched
 * client ID: a sibling client may legitimately route to the same Agent.
 */
export async function cleanupPrimaryFamilyUnbound(
  input: PrimaryAgentFamilyUnbindCleanupInput,
  platform: ChannelPlatform,
  port: PrimaryFamilyPlatformPort,
  agentName: string,
  family?: PrimaryAgentFamilyUnbindScope,
): Promise<void> {
  const clientId = port.clientId(agentName);
  await input.teardownTransport(platform, agentName);
  input.unregisterTransport(platform, clientId);
  const routeStore = await LocalChannelRouteStore.load(
    input.dataDir(),
    input.defaultAgentName,
    input.nowMs,
  );
  const routeIds = routeStore
    .getRules(platform)
    .filter((rule) => rule.match.clientName === clientId)
    .map((rule) => rule.id);
  let removedRoutes = 0;
  for (const routeId of routeIds) {
    if (await routeStore.deleteRule(routeId)) removedRoutes += 1;
  }
  const removedBindings = await input.bindingStore.deleteByAgentPlatform(agentName, platform);
  const clearedOwners = await clearOwnerAllConventions(
    input.ownerStore,
    agentName,
    platform,
    clientId,
  );
  await input.accessControlStore?.delete(platform, clientId);
  logger.info(
    {
      platform,
      ...(family ? { canonical_agent: family.canonicalName, winner_agent: family.winnerName } : {}),
      agentName,
      clientId,
      reason: 'exact_unbind_cleanup',
      removedRoutes,
      removedBindings,
      clearedOwners,
    },
    'primary_agent_channel_unbind_cleanup',
  );
}

/**
 * A second explicit physical-winner unbind may encounter only the disabled shadow
 * left by its own successful migration. Delete that exact shadow before the
 * normal scan so it cannot become a new migration source. Every other state
 * keeps the existing reconcile path: identity is evidence, never a guess.
 */
export async function cleanupSettledPrimaryFamilyShadow(
  input: PrimaryAgentFamilyUnbindCleanupInput,
  platform: ChannelPlatform,
  port: PrimaryFamilyPlatformPort,
  family: PrimaryAgentFamilyUnbindScope,
  agentName: string,
  unbound: ChannelFamilyUnbindSnapshot | undefined,
): Promise<void> {
  if (agentName !== family.winnerName || unbound?.enabled !== true || !unbound.identity) return;
  const records = await port.list();
  if (records.some((record) => record.agentName === family.winnerName)) return;
  const legacies = records.filter((record) => family.legacyNames.includes(record.agentName));
  if (legacies.length !== 1) return;
  const [shadow] = legacies;
  if (!shadow || shadow.enabled || !shadow.identity || shadow.identity !== unbound.identity) return;
  if (!(await port.deleteCredential(shadow.agentName))) return;
  await cleanupPrimaryFamilyUnbound(input, platform, port, shadow.agentName, family);
}
