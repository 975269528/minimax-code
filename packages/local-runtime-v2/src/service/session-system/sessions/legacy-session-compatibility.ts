import type { SessionRecord } from './repo/contract.js';

/**
 * Narrow compatibility capability for legacy OpenCode metadata and readiness.
 * It deliberately exposes no v1 store, application handler or production adapter.
 */
export interface LegacySessionCompatibilityPort {
  discover(agentName?: string): Promise<void>;
  ensureMetadataReady(sessionId: string): Promise<SessionRecord | undefined>;
  adopt(agentName: string): Promise<SessionRecord | undefined>;
  ensureDisplayReady(sessionId: string): Promise<void>;
  ensureExecutionReady(sessionId: string): Promise<SessionRecord | undefined>;
}

export function createLegacySessionCompatibilityPort(
  importer: LegacySessionCompatibilityPort,
): LegacySessionCompatibilityPort {
  return importer;
}
