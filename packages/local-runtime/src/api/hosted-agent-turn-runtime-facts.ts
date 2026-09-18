import type { LocalRuntimeConfig } from '../config/types.js';
import { isCuModeActive } from '../cu/gate.js';
import { isEnabled as isCuEnabled } from '../services/cu/state.js';

export interface HostedTurnRuntimeFactSource {
  snapshot(): {
    readonly cuModeActive: boolean;
  };
}

export function resolveHostedCuModeActive(
  config: LocalRuntimeConfig,
  disableComputerUse: boolean,
): boolean {
  return (
    !disableComputerUse && isCuModeActive(config.beta?.cuMode, isCuEnabled())
  );
}

export function createHostedTurnRuntimeFactSource(input: {
  readonly configGetter: () => LocalRuntimeConfig;
  readonly disableComputerUse: boolean;
}): HostedTurnRuntimeFactSource {
  return {
    snapshot: () => ({
      cuModeActive: resolveHostedCuModeActive(
        input.configGetter(),
        input.disableComputerUse,
      ),
    }),
  };
}
