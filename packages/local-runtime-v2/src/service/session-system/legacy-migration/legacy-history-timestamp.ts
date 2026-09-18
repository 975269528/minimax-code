import type { LegacyMigrationRecord } from './repo/contract.js';

const TIMESTAMP_ERROR_FRAGMENT = 'message.timestamp must be finite';
const TIMESTAMP_ERROR_KIND = 'canonical-history-message-timestamp';

const LEGACY_HISTORY_TIMESTAMP_COMPAT_VERSION = 1;

export function normalizeLegacyHistoryTimestamp(value: unknown, stableFallback?: unknown): unknown {
  const container = isRecord(value) ? value : undefined;
  const envelope = container && isCanonicalEnvelopeShape(container) ? container : undefined;
  const message = envelope?.['message'] ?? container;
  if (!isRecord(message)) return value;

  const timestamp = legacyTimestampMs(message['timestamp']) ?? legacyTimestampMs(stableFallback);
  if (timestamp === undefined || message['timestamp'] === timestamp) return value;

  const normalizedMessage = { ...message, timestamp };
  return envelope ? { ...envelope, message: normalizedMessage } : normalizedMessage;
}

export function isCanonicalEnvelopeShape(value: Readonly<Record<string, unknown>>): boolean {
  return (
    Object.hasOwn(value, 'message_id') &&
    Object.hasOwn(value, 'turn_id') &&
    isRecord(value['message'])
  );
}

export function shouldRetryLegacyHistoryTimestampFailure(
  record: LegacyMigrationRecord | undefined,
  historyRequested: boolean,
): boolean {
  return Boolean(
    historyRequested &&
    record?.status === 'failed' &&
    isLegacyHistoryTimestampFailure(record.error) &&
    legacyHistoryTimestampCompatVersion(record) < LEGACY_HISTORY_TIMESTAMP_COMPAT_VERSION,
  );
}

export function legacyHistoryTimestampFailureMetadata(
  error: unknown,
  retryAttempted: boolean,
): Record<string, unknown> {
  const knownTimestampFailure = isLegacyHistoryTimestampFailure(error);
  if (!knownTimestampFailure && !retryAttempted) return {};
  return {
    ...(knownTimestampFailure ? { kind: TIMESTAMP_ERROR_KIND } : {}),
    ...(retryAttempted ? { compatRetryVersion: LEGACY_HISTORY_TIMESTAMP_COMPAT_VERSION } : {}),
  };
}

export function legacyHistoryTimestampCompatReport(
  previous: unknown,
  retriedAtMs: number,
  result: 'migrated' | 'failed',
): Record<string, unknown> {
  return {
    ...(isRecord(previous) ? previous : {}),
    legacyHistoryTimestampCompat: {
      version: LEGACY_HISTORY_TIMESTAMP_COMPAT_VERSION,
      retriedAtMs,
      result,
    },
  };
}

function legacyTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isLegacyHistoryTimestampFailure(value: unknown): boolean {
  const pending = [value];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === undefined || candidate === null || visited.has(candidate)) continue;
    visited.add(candidate);
    if (collectTimestampFailureEvidence(candidate, pending)) return true;
  }
  return false;
}

function collectTimestampFailureEvidence(candidate: unknown, pending: unknown[]): boolean {
  if (typeof candidate === 'string') return candidate.includes(TIMESTAMP_ERROR_FRAGMENT);
  if (candidate instanceof AggregateError) pending.push(...candidate.errors);
  if (candidate instanceof Error) pending.push(candidate.message, candidate.cause);
  if (!isRecord(candidate)) return false;
  if (candidate['kind'] === TIMESTAMP_ERROR_KIND) return true;
  pending.push(candidate['message'], candidate['cause'], candidate['error']);
  return false;
}

function legacyHistoryTimestampCompatVersion(record: LegacyMigrationRecord): number {
  const errorVersion = nestedNumber(record.error, 'compatRetryVersion');
  const reportVersion = isRecord(record.report)
    ? nestedNumber(record.report['legacyHistoryTimestampCompat'], 'version')
    : 0;
  return Math.max(errorVersion, reportVersion);
}

function nestedNumber(value: unknown, key: string): number {
  if (!isRecord(value)) return 0;
  const candidate = value[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
