import type { InitializedPluginService } from '../../service/plugin-system/index.js';
import {
  configureLocalPluginHookEnabledResolver,
  configureLocalPluginHookObservability,
  configureLocalPluginHookSessionEndFence,
  endAllLocalPluginHookSessionsForLogout,
  type TurnSystemOwner,
} from '../../service/turn-system/index.js';

import { createRuntimePluginAuthContextNotifier } from './runtime-services-lifecycle.js';

export interface RuntimePluginHookCompositionInput {
  readonly plugin: InitializedPluginService;
  readonly turnSystem: TurnSystemOwner;
  readonly logger?: { warn(fields: Readonly<Record<string, unknown>>, message: string): void };
  readonly metrics?: {
    counter(name: string, delta?: number, labels?: Record<string, string>): void;
    histogram(name: string, value: number, labels?: Record<string, string>): void;
  };
}

/** Binds process-local Plugin Hook observation, SessionEnd fencing, and auth lifecycle. */
export function configureRuntimePluginHooks(
  input: RuntimePluginHookCompositionInput,
): ReturnType<typeof createRuntimePluginAuthContextNotifier> {
  const { plugin, turnSystem } = input;
  configureLocalPluginHookEnabledResolver(() => plugin.enabledHookPluginNames());
  configureLocalPluginHookSessionEndFence({
    run: async (fenceInput) => {
      const tryRunExclusive = turnSystem.sessionLifecycle.tryRunExclusive;
      if (!tryRunExclusive) {
        return { status: 'executed', result: await fenceInput.operation() };
      }
      const attempt = await tryRunExclusive(fenceInput.sessionId, async (maintenanceSignal) => {
        const ownershipClaimId = fenceInput.sessionOwnershipClaim;
        if (!ownershipClaimId) return { status: 'superseded' as const };
        const latestOwnership = await turnSystem.pluginHookSessionOwnership.latest(
          fenceInput.sessionId,
        );
        if (latestOwnership?.ownershipClaimId !== ownershipClaimId) {
          return { status: 'superseded' as const };
        }
        const latest = await turnSystem.inspection?.latestTurnActivity?.(fenceInput.sessionId);
        if (fenceInput.reason === 'idle_timeout' && fenceInput.idleSinceMs !== undefined) {
          if (latest && latest.activityAtMs > fenceInput.idleSinceMs) {
            return { status: 'deferred' as const, latestActivityAtMs: latest.activityAtMs };
          }
        }
        const sessionEndClaimId = `${ownershipClaimId}:session-end`;
        const claimed = await turnSystem.pluginHookSessionOwnership.tryClaimSessionEnd({
          sessionId: fenceInput.sessionId,
          ownershipClaimId,
          sessionEndClaimId,
          reason: fenceInput.reason,
        });
        if (claimed.status !== 'claimed') return { status: 'superseded' as const };
        try {
          return {
            status: 'executed' as const,
            result: await fenceInput.operation(maintenanceSignal),
          };
        } finally {
          await turnSystem.pluginHookSessionOwnership.completeSessionEnd({
            sessionId: fenceInput.sessionId,
            ownershipClaimId,
            sessionEndClaimId,
          });
        }
      });
      return attempt.acquired ? attempt.value : { status: 'deferred' };
    },
  });
  configureLocalPluginHookObservability({
    ...(input.logger ? { logger: input.logger } : {}),
    ...(input.metrics ? { metrics: input.metrics } : {}),
  });
  return createRuntimePluginAuthContextNotifier({
    authContextChanged: () => plugin.authContextChanged(),
    enabledHookPluginNames: () => plugin.enabledHookPluginNames(),
    abortSession: (sessionId) => turnSystem.turns.abort({ sessionId, reason: 'logout' }),
    endAllSessionsForLogout: endAllLocalPluginHookSessionsForLogout,
  });
}
