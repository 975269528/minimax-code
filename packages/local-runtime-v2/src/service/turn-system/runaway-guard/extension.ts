import { runawayGuardExtension, type RunawayGuardExtensionOptions } from '@mavis/agent-extension';
import { resolveRunawayGuardConfig } from '@mavis/config';
import { createProductionRunawayGuardToolPolicies } from './tool-policy.js';
import { createRunawayGuardObserver, type RunawayGuardObserverOptions } from './observation.js';

interface RunawayGuardHostOptions extends RunawayGuardObserverOptions {
  readonly readLocalConfig: () => unknown;
  readonly readRemoteConfig?: () => unknown;
  readonly readVerifiedProgress: RunawayGuardExtensionOptions['readVerifiedProgress'];
}

/** Config/file/Eval ownership stays in the host; the extension is process-neutral. */
export function createProductionRunawayGuardExtension(options: RunawayGuardHostOptions) {
  const emit = createRunawayGuardObserver(options);
  const local = readBestEffort(options.readLocalConfig);
  return runawayGuardExtension({
    toolPolicies: createProductionRunawayGuardToolPolicies(),
    readVerifiedProgress: options.readVerifiedProgress,
    isEnabled: () =>
      resolveRunawayGuardConfig(local, readBestEffort(options.readRemoteConfig)).enabled,
    shouldRemind: (ctx) => ctx.turnIntent?.kind !== 'goal-verifier',
    onSignal: (value) => emit('runaway_guard_signal', value),
    onReminder: (value) => emit('runaway_guard_reminder_injected', value),
    onTurnSummary: (value) => emit('runaway_guard_turn_summary', value),
  });
}

function readBestEffort(read: (() => unknown) | undefined): unknown {
  try {
    return read?.();
  } catch {
    return undefined;
  }
}
