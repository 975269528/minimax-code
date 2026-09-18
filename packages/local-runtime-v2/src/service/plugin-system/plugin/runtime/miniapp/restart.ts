import { PluginSystemError } from '../../../errors.js';
import { deferred } from '../../../plugin-system-helpers.js';
import { isPublicationSuperseded, type PluginPublicationOptions } from '../../../publication.js';
import type { PluginSnapshot } from '../snapshot-builder.js';

export interface MiniAppRestartInput {
  readonly pluginId: string;
  readonly signal?: AbortSignal;
}

interface MiniAppRestartCapability {
  readonly initialize: () => Promise<void>;
  readonly assertUsable: () => void;
  readonly runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly currentSnapshot: () => PluginSnapshot;
  readonly setDesiredSnapshot: (snapshot: PluginSnapshot) => void;
  readonly prepare: (snapshot: PluginSnapshot, options: PluginPublicationOptions) => Promise<void>;
}

/** Re-enters an explicit restart through the ordinary Plugin publication transaction. */
export async function restartSupervisedMiniAppPublication(
  input: MiniAppRestartInput,
  capability: MiniAppRestartCapability,
): Promise<void> {
  await capability.initialize();
  capability.assertUsable();
  await capability.runExclusive(async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const completion = deferred<void>();
      const current = capability.currentSnapshot();
      const superseded = new PluginSystemError(
        'PUBLICATION_SUPERSEDED',
        'Mini App restart snapshot was superseded',
      );
      try {
        await capability.prepare(current, {
          completion,
          commit: async () => {
            if (capability.currentSnapshot().revision !== current.revision) throw superseded;
          },
          requiredMiniAppPluginId: input.pluginId,
          forceRuntimePublicationPluginId: input.pluginId,
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
