import type { PluginSnapshotBuildInputs, PluginSnapshotBuildOptions } from '../../../contracts.js';
import { PluginSystemError } from '../../../errors.js';
import { deferred } from '../../../plugin-system-helpers.js';
import { isPublicationSuperseded, type PluginPublicationOptions } from '../../../publication.js';
import type { PluginSnapshot } from '../snapshot-builder.js';
import { listEnabledMiniAppDefinitions, type PluginMiniAppCandidate } from './candidate.js';
import { buildTargetedMiniAppInputs, type MiniAppSnapshotBuildContext } from './projection.js';

export interface MiniAppActivationInput {
  readonly pluginId: string;
  readonly signal?: AbortSignal;
}

interface MiniAppActivationCapability {
  readonly initialize: () => Promise<void>;
  readonly assertUsable: () => void;
  readonly runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly readAvailableSnapshot: () => Promise<PluginSnapshot>;
  readonly isAcceptedCandidateRunning: (candidate: PluginMiniAppCandidate) => boolean;
  readonly buildContext: (snapshot: PluginSnapshot) => MiniAppSnapshotBuildContext | undefined;
  readonly currentSnapshot: () => PluginSnapshot;
  readonly setDesiredSnapshot: (snapshot: PluginSnapshot) => void;
  readonly buildSnapshot: (
    input: PluginSnapshotBuildInputs,
    options: PluginSnapshotBuildOptions,
  ) => PluginSnapshot;
  readonly prepare: (snapshot: PluginSnapshot, options: PluginPublicationOptions) => Promise<void>;
}

/** Publishes and starts one definition without admitting the rest of the catalog. */
export async function activateAvailableMiniApp(
  input: MiniAppActivationInput,
  capability: MiniAppActivationCapability,
): Promise<void> {
  await capability.initialize();
  capability.assertUsable();
  input.signal?.throwIfAborted();
  await capability.runExclusive(async () => {
    const available = await capability.readAvailableSnapshot();
    const target = listEnabledMiniAppDefinitions(available).find(
      ({ candidate }) => candidate.pluginId === input.pluginId,
    )?.candidate;
    if (!target) {
      throw new PluginSystemError(
        'MINIAPP_NOT_AVAILABLE',
        'Enabled MiniApp definition is not available',
      );
    }
    if (capability.isAcceptedCandidateRunning(target)) return;
    const availableContext = capability.buildContext(available);
    if (!availableContext) {
      throw new PluginSystemError(
        'MINIAPP_CATALOG_STALE',
        'Mini App definition catalog cannot be activated',
      );
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      input.signal?.throwIfAborted();
      const current = capability.currentSnapshot();
      const currentContext = capability.buildContext(current);
      if (!currentContext) {
        throw new PluginSystemError(
          'MINIAPP_CATALOG_STALE',
          'Mini App runtime publication context is not available',
        );
      }
      const candidate = capability.buildSnapshot(
        buildTargetedMiniAppInputs({
          base: currentContext.input,
          available: availableContext.input,
          availableSnapshot: available,
          target,
        }),
        currentContext.options,
      );
      const completion = deferred<void>();
      const superseded = new PluginSystemError(
        'PUBLICATION_SUPERSEDED',
        'Mini App activation snapshot was superseded',
      );
      try {
        await capability.prepare(candidate, {
          completion,
          commit: async () => {
            if (capability.currentSnapshot().revision !== current.revision) throw superseded;
          },
          requiredMiniAppPluginId: input.pluginId,
          forceRuntimePublicationPluginId: input.pluginId,
          miniAppRosterSource: available,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        return;
      } catch (error) {
        capability.setDesiredSnapshot(capability.currentSnapshot());
        if (!isPublicationSuperseded(error) || attempt === 1) throw error;
      }
    }
  });
}
