import { getRuntimeBuildEnv } from '@mavis/config';

import {
  ContextUsageCalibrationCoordinator,
  type ContextUsageToolCalibration,
} from '../context/context-usage-calibration.js';
import {
  HttpRemoteTokenCounter,
  type RemoteTokenCounter,
} from '../context/remote-token-counter.js';

interface ContextUsageRuntimeOptions {
  fetchImpl?: typeof fetch;
  contextUsageProviderDiagnosticCounter?: RemoteTokenCounter;
  contextUsageCalibrationCounter?: RemoteTokenCounter;
}

export interface ContextUsageRuntime {
  providerDiagnosticCounter?: RemoteTokenCounter;
  calibrationCoordinator: ContextUsageCalibrationCoordinator;
  getCachedToolCalibration: ContextUsageCalibrationCoordinator['getCachedToolCalibration'];
}

export function createContextUsageRuntime(
  options: ContextUsageRuntimeOptions,
): ContextUsageRuntime {
  const calibrationCoordinator = new ContextUsageCalibrationCoordinator(
    options.contextUsageCalibrationCounter ??
      new HttpRemoteTokenCounter({
        timeoutMs: 3_000,
        ...(options.fetchImpl ? { fetchFn: options.fetchImpl } : {}),
      }),
  );
  const providerDiagnosticCounter =
    getRuntimeBuildEnv() !== 'prod' &&
    (options.contextUsageProviderDiagnosticCounter ||
      process.env.MAVIS_CONTEXT_USAGE_PROVIDER_DIAGNOSTICS === '1')
      ? (options.contextUsageProviderDiagnosticCounter ??
        new HttpRemoteTokenCounter({
          timeoutMs: 10_000,
          ...(options.fetchImpl ? { fetchFn: options.fetchImpl } : {}),
        }))
      : undefined;
  return {
    ...(providerDiagnosticCounter ? { providerDiagnosticCounter } : {}),
    calibrationCoordinator,
    getCachedToolCalibration: (input): ContextUsageToolCalibration | undefined =>
      calibrationCoordinator.getCachedToolCalibration(input),
  };
}
