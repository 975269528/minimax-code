import type {
  CanonicalHistoryMessage,
  CanonicalHistoryPort,
} from '../messages/history/history-store.js';
import type { SessionRecord } from '../sessions/repo/contract.js';
import {
  boundedCanonicalRecoveryHistoryCount,
  buildCanonicalRecoveryRecord,
  buildLegacyContextBoundary,
  canonicalRecoveryCandidate,
  canonicalRecoveryRejection,
  EMPTY_CANONICAL_RECOVERY_HISTORY,
  isDisplayReady,
  legacyContextBoundaryPreservation,
  LEGACY_CONTEXT_BOUNDARY_STRATEGY,
  type CanonicalRecoveryHistory,
  type CanonicalRecoveryHistoryState,
  type CanonicalRecoveryInput,
  type CanonicalRecoveryPreservedHistory,
  type CanonicalRecoveryTrigger,
  type LegacyCanonicalRecoveryEvent,
} from './canonical-recovery.js';
import type { LegacyMigrationRecord, LegacySessionMigrationRepository } from './repo/contract.js';

export interface CanonicalRecoveryPreservation {
  readonly preserved?: CanonicalRecoveryPreservedHistory;
  readonly reason?: string;
}

interface CanonicalRecoveryRunnerOptions {
  readonly migrations: Pick<LegacySessionMigrationRepository, 'upsert'>;
  readonly history: Pick<CanonicalHistoryPort, 'getPiHistory' | 'replacePiHistory'>;
  readonly nowMs: () => number;
  readonly selectPreservation: (
    history: readonly CanonicalHistoryMessage[],
    record: LegacyMigrationRecord,
  ) => CanonicalRecoveryPreservation;
  readonly onCanonicalRecovery: ((event: LegacyCanonicalRecoveryEvent) => void) | undefined;
}

export async function recoverLegacyCanonicalSession(
  input: CanonicalRecoveryInput,
  options: CanonicalRecoveryRunnerOptions,
): Promise<SessionRecord | undefined> {
  const candidate = canonicalRecoveryCandidate(input);
  if (!candidate) return undefined;
  const { existing, previous } = candidate;
  const { sessionId, trigger } = input;
  const reject = (
    reason: string,
    historyState: CanonicalRecoveryHistoryState = EMPTY_CANONICAL_RECOVERY_HISTORY,
  ): undefined => {
    emitCanonicalRecovery(options, {
      sessionId,
      existing,
      previous,
      trigger,
      historyCount: historyState.historyCount,
      historyReady: historyState.historyReady,
      result: 'rejected',
      reason,
    });
    return undefined;
  };

  const rejection = canonicalRecoveryRejection(sessionId, existing, previous);
  if (rejection) return reject(rejection);
  const canonicalHistory = await readCanonicalRecoveryHistory(sessionId, options);
  if (!canonicalHistory.history) {
    return canonicalHistory.reason === 'history_empty'
      ? replaceWithContextBoundary(input, existing, previous, options)
      : reject(canonicalHistory.reason, canonicalHistory);
  }

  const preservation = options.selectPreservation(canonicalHistory.history, previous);
  if (preservation.reason) {
    return replaceWithContextBoundary(input, existing, previous, options);
  }

  const nowMs = options.nowMs();
  const degraded = preservation.preserved?.contextBoundary === true;
  await options.migrations.upsert(
    buildCanonicalRecoveryRecord({ previous, trigger, nowMs, preserved: preservation.preserved }),
  );
  emitCanonicalRecovery(options, {
    sessionId,
    existing,
    previous,
    trigger,
    historyCount: canonicalHistory.historyCount,
    historyReady: canonicalHistory.historyReady,
    result: degraded ? 'degraded' : 'recovered',
    reason: degraded
      ? 'legacy_history_replaced_with_context_boundary'
      : 'canonical_history_preserved',
  });
  return existing;
}

async function replaceWithContextBoundary(
  input: CanonicalRecoveryInput,
  existing: SessionRecord,
  previous: LegacyMigrationRecord,
  options: CanonicalRecoveryRunnerOptions,
): Promise<SessionRecord> {
  const timestamp = Math.max(options.nowMs(), previous.migratedAtMs + 1);
  const boundary = buildLegacyContextBoundary(timestamp);
  await options.history.replacePiHistory(input.sessionId, [boundary], {
    snapshotId: LEGACY_CONTEXT_BOUNDARY_STRATEGY,
  });
  await options.migrations.upsert(
    buildCanonicalRecoveryRecord({
      previous,
      trigger: input.trigger,
      nowMs: options.nowMs(),
      preserved: legacyContextBoundaryPreservation([boundary]),
    }),
  );
  emitCanonicalRecovery(options, {
    sessionId: input.sessionId,
    existing,
    previous,
    trigger: input.trigger,
    historyCount: 1,
    historyReady: true,
    result: 'degraded',
    reason: 'legacy_history_replaced_with_context_boundary',
  });
  return existing;
}

async function readCanonicalRecoveryHistory(
  sessionId: string,
  options: CanonicalRecoveryRunnerOptions,
): Promise<CanonicalRecoveryHistory> {
  try {
    const history = await options.history.getPiHistory(sessionId);
    const historyCount = boundedCanonicalRecoveryHistoryCount(history.length);
    return history.length > 0
      ? { history, historyCount, historyReady: true }
      : { reason: 'history_empty', historyCount, historyReady: false };
  } catch {
    return {
      reason: 'history_read_or_validation_failed',
      historyCount: 0,
      historyReady: false,
    };
  }
}

function emitCanonicalRecovery(
  options: CanonicalRecoveryRunnerOptions,
  input: {
    readonly sessionId: string;
    readonly existing: SessionRecord | undefined;
    readonly previous: LegacyMigrationRecord | undefined;
    readonly trigger: CanonicalRecoveryTrigger;
    readonly historyCount: number;
    readonly historyReady: boolean;
    readonly result: LegacyCanonicalRecoveryEvent['result'];
    readonly reason: string;
  },
): void {
  if (!options.onCanonicalRecovery) return;
  try {
    options.onCanonicalRecovery({
      session_id: input.sessionId,
      trigger: input.trigger,
      previous_status: input.previous?.status ?? 'missing',
      runtime: input.existing?.runtime ?? 'missing',
      origin: input.existing?.sessionOrigin ?? 'unset',
      display_ready: isDisplayReady(input.previous),
      history_ready: input.historyReady,
      previous_strategy: input.previous?.piHistoryStrategy ?? 'missing',
      previous_converter_version: input.previous?.piHistoryConverterVersion ?? 'missing',
      history_count: input.historyCount,
      result: input.result,
      reason: input.reason,
    });
  } catch {
    // Production logging is best-effort and must not change migration recovery.
  }
}
