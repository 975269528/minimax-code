import { emitResourceAmbiguityTelemetry } from '../agent/subagent-telemetry.js';
import type { LocalChannelBridgeInfraOptions } from './infra.js';

/** Report a bounded ambiguity observation for a local channel request. */
export function reportChannelResourceAmbiguity(
  options: Pick<LocalChannelBridgeInfraOptions, 'emitBusEvent' | 'metrics'>,
  memberCount: number,
): void {
  emitResourceAmbiguityTelemetry(
    { emitBusEvent: options.emitBusEvent, metrics: options.metrics },
    'channel',
    memberCount,
  );
}
