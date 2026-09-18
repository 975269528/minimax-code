import type { LocalChannelBindingStore, LocalChannelBridgeInfraOptions } from './infra.js';
import { LocalChannelRootlessError } from './rootless-route-resolver.js';
import { LocalChannelRouteStore } from './route-api.js';
import { imLogger as logger } from '../common/im-logger.js';
import {
  isCompatibleChannelAgentOwner,
  historicalChannelAgentReadErrorCode,
  type ChannelAgentReadScopeResolver,
} from './agent-owner-compatibility.js';

/** Historical route rows with these proofs are safe to leave opaque locally. */
function isRecoverableHistoricalBindingError(error: unknown): error is LocalChannelRootlessError {
  return (
    error instanceof LocalChannelRootlessError &&
    (error.code === 'CHANNEL_BINDING_SESSION_MISSING' ||
      error.code === 'CHANNEL_BINDING_OWNER_STALE' ||
      error.code === 'CHANNEL_BINDING_PROJECT_MISMATCH')
  );
}

/**
 * Route configuration is still validated on every ordinary route write. At
 * startup, however, an already-persisted legacy conflict must stay opaque so
 * it cannot prevent independent binding and IM recovery from running.
 */
function isRecoverableHistoricalRouteError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'CHANNEL_ROUTE_MULTI_PROJECT'
  );
}

/** Preserve Session identity/history; the snapshot port may complete an existing definition. */
export async function migrateRootlessChannelState(input: {
  dataDir: string;
  defaultAgentName: string;
  nowMs: () => number;
  bindingStore: LocalChannelBindingStore;
  getSessionById(sessionId: string): Promise<unknown>;
  rootless: NonNullable<LocalChannelBridgeInfraOptions['rootlessV2']>;
  resolveAgentReadScope?: ChannelAgentReadScopeResolver;
  reportDiagnostic?(event: { code: 'CHANNEL_ROUTE_PROJECT_DEFAULT_FALLBACK'; count: number }): void;
}): Promise<void> {
  type BindingResolution = Awaited<ReturnType<typeof resolveBinding>>;
  const resolutions = new Map<string, BindingResolution>();
  const skippedBindingKeys = new Set<string>();
  const profileBindings = new Map<string, Array<{ key: string; projectKey: string }>>();
  const bindings = await input.bindingStore.list();
  const resolveBinding = async (binding: (typeof bindings)[number]) => {
    const [session, snapshot, project] = await Promise.all([
      input.getSessionById(binding.sessionId),
      input.rootless.getSessionAgentRoutingSnapshot(binding.sessionId),
      input.rootless.getSessionProjectIdentity(binding.sessionId),
    ]);
    if (!session || typeof session !== 'object' || !snapshot) {
      throw new LocalChannelRootlessError(
        409,
        'CHANNEL_BINDING_SESSION_MISSING',
        'A Channel binding does not reference a concrete Session with a frozen Agent snapshot.',
      );
    }
    if (!project) {
      throw new LocalChannelRootlessError(
        409,
        'CHANNEL_BINDING_PROJECT_MISMATCH',
        'A Channel binding Session does not have a canonical Project identity.',
      );
    }
    const current = await input.rootless.getAgentOwnerIdentity(binding.agentName);
    if (
      !(await isCompatibleChannelAgentOwner({
        persisted: snapshot,
        current,
        ...(input.resolveAgentReadScope
          ? { resolveAgentReadScope: input.resolveAgentReadScope }
          : {}),
      }))
    ) {
      throw new LocalChannelRootlessError(
        409,
        'CHANNEL_BINDING_OWNER_STALE',
        'A Channel binding Session targets a stale Agent owner incarnation.',
      );
    }
    return {
      // Normalize a trusted primary-family alias (`main` → `mavis`) while
      // leaving the immutable Session snapshot untouched.
      exactOwnerName: current.exactOwnerName,
      ownerKind: current.ownerKind,
      ...(snapshot.ownerInstanceId ? { ownerInstanceId: snapshot.ownerInstanceId } : {}),
      projectKey: project.projectKey,
    };
  };
  /**
   * Safe wrapper around `resolveBinding` shared by the initial scan and the
   * late rehydrate inside `bindingStore.migrateToV2`. A deleted-Agent
   * reference or unreadable Agent is local to that row, so the
   * migration must skip it instead of throwing — throwing here would brick
   * the runtime on every launch. Historical stale-owner, project-mismatch
   * and missing-session rows are likewise retained locally for later recovery rather
   * than blocking an unrelated healthy platform.
   *
   * The first scan marks the row as skipped so the rehydrate callback can
   * short-circuit it without re-resolving or re-emitting the same warning
   * (key already in `skippedBindingKeys`).
   */
  const safeResolveBinding = async (
    binding: (typeof bindings)[number],
  ): Promise<BindingResolution | undefined> => {
    try {
      return await resolveBinding(binding);
    } catch (error) {
      if (historicalChannelAgentReadErrorCode(error)) {
        skippedBindingKeys.add(binding.key);
        logger.warn(
          {
            code: historicalChannelAgentReadErrorCode(error),
            bindingKey: binding.key,
          },
          '[im-guard] startup migration skipped a Channel binding whose bound Agent is unavailable',
        );
        return undefined;
      }
      if (isRecoverableHistoricalBindingError(error)) {
        skippedBindingKeys.add(binding.key);
        logger.warn(
          {
            code: error.code,
            bindingKey: binding.key,
          },
          '[im-guard] startup migration kept one untrusted historical Channel binding',
        );
        return undefined;
      }
      throw error;
    }
  };
  for (const binding of bindings) {
    const resolution = await safeResolveBinding(binding);
    if (!resolution) {
      // Deterministic dead reference: keep the binding untouched and let the
      // inbound route-broken receipt (4dd5b5e726) answer the user later.
      skippedBindingKeys.add(binding.key);
      continue;
    }
    resolutions.set(binding.key, resolution);
    const profile = channelProfile(resolution.exactOwnerName, binding.platform, binding.clientName);
    const rows = profileBindings.get(profile) ?? [];
    rows.push({ key: binding.key, projectKey: resolution.projectKey });
    profileBindings.set(profile, rows);
  }
  const profileProjects = new Map<string, string>();
  for (const [profile, rows] of profileBindings) {
    if (new Set(rows.map((row) => row.projectKey)).size > 1) {
      for (const row of rows) {
        resolutions.delete(row.key);
        skippedBindingKeys.add(row.key);
      }
      logger.warn(
        {
          code: 'CHANNEL_BINDING_MULTI_PROJECT',
          bindingKeys: rows.map((row) => row.key).sort(),
        },
        '[im-guard] startup migration kept conflicting historical Channel bindings',
      );
      continue;
    }
    profileProjects.set(profile, rows[0]!.projectKey);
  }
  const routeStore = await LocalChannelRouteStore.load(
    input.dataDir,
    input.defaultAgentName,
    input.nowMs,
  );
  let defaultFallbackCount = 0;
  let routeMigrationCompleted = false;
  try {
    await routeStore.migrateToV2(
      async (requestRef) => {
        try {
          return await input.rootless.getAgentOwnerIdentity(requestRef);
        } catch (error) {
          if (historicalChannelAgentReadErrorCode(error)) {
            // Keep the route target as-is; resolution happens (and is answered
            // with a receipt) at inbound time instead of bricking startup.
            logger.warn(
              { requestRef, code: historicalChannelAgentReadErrorCode(error) },
              '[im-guard] startup migration kept a Channel route whose Agent is unavailable',
            );
            return undefined;
          }
          throw error;
        }
      },
      ({ exactOwnerName, platform, clientName, currentProjectKey }) => {
        if (currentProjectKey !== 'default') return currentProjectKey;
        const exact = profileProjects.get(channelProfile(exactOwnerName, platform, clientName));
        if (exact) return exact;
        if (clientName !== '*') {
          defaultFallbackCount += 1;
          return currentProjectKey;
        }
        const candidates = new Set(
          [...profileProjects]
            .filter(([profile]) => profile.startsWith(`${exactOwnerName}|${platform}|`))
            .map(([, projectKey]) => projectKey),
        );
        if (candidates.size === 1) return [...candidates][0]!;
        defaultFallbackCount += 1;
        return currentProjectKey;
      },
    );
    routeMigrationCompleted = true;
  } catch (error) {
    if (!isRecoverableHistoricalRouteError(error)) throw error;
    logger.warn(
      { code: 'CHANNEL_ROUTE_MULTI_PROJECT' },
      '[im-guard] startup migration kept conflicting historical Channel routes',
    );
  }
  if (routeMigrationCompleted && defaultFallbackCount > 0) {
    const event = {
      code: 'CHANNEL_ROUTE_PROJECT_DEFAULT_FALLBACK' as const,
      count: defaultFallbackCount,
    };
    if (input.reportDiagnostic) input.reportDiagnostic(event);
    else logger.warn(event, 'Channel route migration used the default Project fallback');
  }
  await input.bindingStore.migrateToV2(
    async (binding) => {
      if (skippedBindingKeys.has(binding.key)) {
        // The initial scan already classified this row as a deterministic
        // dead reference. The late `bindingStore.mutate` rehydrates the
        // whole document from disk before this callback runs, so the same
        // row can reappear here. Short-circuit it without re-resolving and
        // without emitting a second warn for the same key.
        return undefined;
      }
      return resolutions.get(binding.key) ?? safeResolveBinding(binding);
    },
    {
      isSkipped: (binding) => skippedBindingKeys.has(binding.key),
    },
  );
}

function channelProfile(exactOwnerName: string, platform: string, clientName: string): string {
  return `${exactOwnerName}|${platform}|${clientName || '*'}`;
}
