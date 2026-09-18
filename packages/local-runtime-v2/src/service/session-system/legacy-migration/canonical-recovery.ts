import type { CanonicalHistoryMessage } from '../messages/history/history-store.js';
import type { SessionRecord } from '../sessions/repo/contract.js';
import type { LegacyMigrationRecord } from './repo/contract.js';

export type CanonicalRecoveryTrigger = 'failed_record' | 'source_missing';

export interface LegacyCanonicalRecoveryEvent {
  readonly session_id: string;
  readonly trigger: CanonicalRecoveryTrigger;
  readonly previous_status: LegacyMigrationRecord['status'] | 'missing';
  readonly runtime: SessionRecord['runtime'] | 'missing';
  readonly origin: SessionRecord['sessionOrigin'] | 'unset';
  readonly display_ready: boolean;
  readonly history_ready: boolean;
  readonly previous_strategy: string | 'missing';
  readonly previous_converter_version: number | 'missing';
  readonly history_count: number;
  readonly result: 'recovered' | 'degraded' | 'rejected';
  readonly reason: string;
}

export interface CanonicalRecoveryInput {
  readonly sessionId: string;
  readonly existing: SessionRecord | undefined;
  readonly previous: LegacyMigrationRecord | undefined;
  readonly trigger: CanonicalRecoveryTrigger;
}

export interface CanonicalRecoveryCandidate {
  readonly existing: SessionRecord;
  readonly previous: LegacyMigrationRecord;
}

export interface CanonicalRecoveryHistoryState {
  readonly historyCount: number;
  readonly historyReady: boolean;
}

export type CanonicalRecoveryHistory =
  | {
      readonly history: CanonicalHistoryMessage[];
      readonly historyCount: number;
      readonly historyReady: true;
    }
  | {
      readonly history?: never;
      readonly historyCount: number;
      readonly historyReady: false;
      readonly reason: string;
    };

export interface CanonicalRecoveryPreservedHistory {
  readonly strategy: string;
  readonly converterVersion?: number;
  readonly warnings: readonly string[];
  readonly contextBoundary?: boolean;
}

export interface CanonicalRecoveryLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

export const EMPTY_CANONICAL_RECOVERY_HISTORY: CanonicalRecoveryHistoryState = {
  historyCount: 0,
  historyReady: false,
};

export function canonicalRecoveryCandidate(
  input: CanonicalRecoveryInput,
): CanonicalRecoveryCandidate | undefined {
  const { existing, previous, trigger } = input;
  if (!existing || !previous || existing.runtime !== 'pi-agent' || !isDisplayReady(previous)) {
    return undefined;
  }
  if (trigger === 'failed_record' && !isKnownMissingLegacyHistoryFailure(previous)) {
    return undefined;
  }
  return { existing, previous };
}

export function canonicalRecoveryRejection(
  sessionId: string,
  session: SessionRecord,
  record: LegacyMigrationRecord,
): string | undefined {
  if (!hasCanonicalRecoveryIdentity(sessionId, record)) return 'migration_identity_conflict';
  if (session.sessionOrigin !== undefined && session.sessionOrigin !== 'legacy-opencode') {
    return 'session_origin_not_legacy';
  }
  if (hasFalseReadyDisplayRecord(record)) return 'false_ready_display_repair_required';
  return undefined;
}

export function buildCanonicalRecoveryRecord(input: {
  readonly previous: LegacyMigrationRecord;
  readonly trigger: CanonicalRecoveryTrigger;
  readonly nowMs: number;
  readonly preserved: CanonicalRecoveryPreservedHistory | undefined;
}): LegacyMigrationRecord {
  const { previous, trigger, nowMs, preserved } = input;
  const degraded = preserved?.contextBoundary === true;
  return {
    ...previous,
    status: 'migrated',
    piHistoryStrategy:
      preserved?.strategy ??
      existingCanonicalHistoryStrategy(previous) ??
      CANONICAL_RECOVERY_VERSION,
    piHistoryConverterVersion: preserved
      ? preserved.converterVersion
      : previous.piHistoryConverterVersion,
    piHistoryReadyAtMs: nowMs,
    warnings: mergeWarnings(previous.warnings, preserved?.warnings, [
      canonicalRecoveryWarning(trigger),
    ]),
    report: canonicalRecoveryReport(previous.report, nowMs, trigger, degraded),
    error: undefined,
  };
}

export function buildLegacyContextBoundary(timestamp: number): CanonicalHistoryMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `<system-reminder>\n${LEGACY_CONTEXT_BOUNDARY_SUMMARY}\n</system-reminder>`,
      },
    ],
    timestamp,
    archonCompaction: {
      schemaVersion: 1,
      summary: LEGACY_CONTEXT_BOUNDARY_SUMMARY,
    },
    archonLegacyContextBoundary: {
      schemaVersion: 1,
      reason: 'legacy_history_unavailable',
    },
  };
}

export function legacyContextBoundaryPreservation(
  history: readonly CanonicalHistoryMessage[],
): CanonicalRecoveryPreservedHistory | undefined {
  const first = history[0];
  if (
    !first ||
    first.role !== 'user' ||
    !isCompactionMarker(first['archonCompaction']) ||
    !isLegacyContextBoundaryMarker(first['archonLegacyContextBoundary'])
  ) {
    return undefined;
  }
  return {
    strategy: LEGACY_CONTEXT_BOUNDARY_STRATEGY,
    warnings: [LEGACY_CONTEXT_BOUNDARY_WARNING],
    contextBoundary: true,
  };
}

export function boundedCanonicalRecoveryHistoryCount(count: number): number {
  return Math.min(Math.max(0, count), CANONICAL_RECOVERY_HISTORY_COUNT_LIMIT);
}

export function hasFalseReadyDisplayRecord(record: LegacyMigrationRecord | undefined): boolean {
  return Boolean(
    record &&
    isDisplayReady(record) &&
    record.sourceMessageCount === 0 &&
    record.importedMessageCount === 0 &&
    displaySourceSessionIdVersion(record.report) < LEGACY_DISPLAY_SOURCE_SESSION_ID_VERSION,
  );
}

export function isDisplayReady(record: LegacyMigrationRecord | undefined): boolean {
  return Boolean(record?.displayReadyAtMs ?? record?.projectionReadyAtMs);
}

export function createCanonicalRecoveryLoggerAdapter(
  logger: CanonicalRecoveryLogger,
): (event: LegacyCanonicalRecoveryEvent) => void {
  return (event) =>
    logger.info({ ...event }, '[local-runtime-v2] legacy Session canonical recovery');
}

function isKnownMissingLegacyHistoryFailure(record: LegacyMigrationRecord): boolean {
  if (record.status !== 'failed' || !isRecord(record.error)) return false;
  const message = record.error['message'];
  return (
    message === 'legacy source not found' ||
    message === 'native OpenCode history is unavailable for a stale native migration' ||
    message === LEGACY_CONTEXT_BOUNDARY_FINALIZATION_ERROR
  );
}

function hasCanonicalRecoveryIdentity(sessionId: string, record: LegacyMigrationRecord): boolean {
  return record.sourceRuntime === 'opencode' && record.localSessionId === sessionId;
}

function existingCanonicalHistoryStrategy(
  record: LegacyMigrationRecord,
): LegacyMigrationRecord['piHistoryStrategy'] | undefined {
  return typeof record.piHistoryStrategy === 'string' && record.piHistoryStrategy.length > 0
    ? record.piHistoryStrategy
    : undefined;
}

function canonicalRecoveryWarning(trigger: CanonicalRecoveryTrigger): string {
  return `legacy_canonical_recovery:${CANONICAL_RECOVERY_VERSION}:${trigger}`;
}

function canonicalRecoveryReport(
  previous: unknown,
  recoveredAtMs: number,
  trigger: CanonicalRecoveryTrigger,
  degraded: boolean,
): Record<string, unknown> {
  return {
    ...(isRecord(previous) ? previous : {}),
    canonicalRecovery: {
      version: CANONICAL_RECOVERY_VERSION,
      recoveredAtMs,
      trigger,
      displayReady: true,
      historyReady: true,
      result: degraded ? 'degraded' : 'recovered',
      ...(degraded ? { contextBoundary: true } : {}),
    },
  };
}

function isLegacyContextBoundaryMarker(value: unknown): boolean {
  return (
    isRecord(value) &&
    value['schemaVersion'] === 1 &&
    value['reason'] === 'legacy_history_unavailable'
  );
}

function isCompactionMarker(value: unknown): boolean {
  return isRecord(value) && value['schemaVersion'] === 1 && typeof value['summary'] === 'string';
}

function displaySourceSessionIdVersion(report: unknown): number {
  if (!isRecord(report) || !isRecord(report['display'])) return 0;
  const version = report['display']['sourceSessionIdVersion'];
  return typeof version === 'number' ? version : 0;
}

function mergeWarnings(...groups: Array<readonly string[] | undefined>): string[] | undefined {
  const warnings = [...new Set(groups.flatMap((group) => group ?? []).filter(Boolean))];
  return warnings.length > 0 ? warnings : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const CANONICAL_RECOVERY_VERSION = 'existing-canonical-recovered-v1';
const CANONICAL_RECOVERY_HISTORY_COUNT_LIMIT = 10_000;
const LEGACY_DISPLAY_SOURCE_SESSION_ID_VERSION = 1;
export const LEGACY_CONTEXT_BOUNDARY_STRATEGY = 'legacy-context-boundary-v1';
export const LEGACY_CONTEXT_BOUNDARY_WARNING = 'legacy_context_unavailable:new_context_boundary';
export const LEGACY_CONTEXT_BOUNDARY_FINALIZATION_ERROR =
  'legacy context boundary finalization incomplete';
const LEGACY_CONTEXT_BOUNDARY_SUMMARY =
  'Earlier legacy conversation context could not be safely recovered during migration. ' +
  'Continue from the next user message as a new context boundary and do not assume details from unavailable history.';
