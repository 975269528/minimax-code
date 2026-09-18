import type { SessionPage, SessionRecord } from './contract.js';

export interface RecencyCursor {
  readonly updatedAtMs: number;
  readonly createdAtMs: number;
  readonly sessionId: string;
}

export interface CreationCursor {
  readonly createdAtMs: number;
  readonly sessionId: string;
}

export function sessionPageFromRows(records: readonly SessionRecord[], limit: number): SessionPage {
  const sessions = records.slice(0, limit);
  const hasMore = records.length > limit;
  const last = sessions.at(-1);
  return {
    sessions,
    hasMore,
    ...(hasMore && last ? { nextCursor: encodeRecencyCursor(last) } : {}),
  };
}

export function sortByRecency(records: readonly SessionRecord[]): SessionRecord[] {
  return [...records].sort(
    (left, right) =>
      right.updatedAtMs - left.updatedAtMs ||
      right.createdAtMs - left.createdAtMs ||
      left.sessionId.localeCompare(right.sessionId),
  );
}

export function sessionCreationPageFromRows(
  records: readonly SessionRecord[],
  limit: number,
  originCronId: string,
): SessionPage {
  const hasMore = records.length > limit;
  const sessions = records.slice(0, limit);
  const last = sessions.at(-1);
  return {
    sessions,
    hasMore,
    ...(hasMore && last ? { nextCursor: encodeCreationCursor(last, originCronId) } : {}),
  };
}

export function normalizePageLimit(value: number | undefined, maximum = 200): number {
  if (value === undefined || !Number.isFinite(value)) return 50;
  const normalized = Math.floor(value);
  return normalized > 0 ? Math.min(normalized, maximum) : 50;
}

function encodeRecencyCursor(record: SessionRecord): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      k: 'recency',
      updatedAtMs: record.updatedAtMs,
      createdAtMs: record.createdAtMs,
      sessionId: record.sessionId,
    }),
  ).toString('base64url');
}

export function decodeRecencyCursor(value: string | undefined): RecencyCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (!isRecord(parsed) || parsed.v !== 1 || parsed.k !== 'recency') return undefined;
    if (!Number.isSafeInteger(parsed.updatedAtMs) || !Number.isSafeInteger(parsed.createdAtMs)) {
      return undefined;
    }
    if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) return undefined;
    return {
      updatedAtMs: parsed.updatedAtMs as number,
      createdAtMs: parsed.createdAtMs as number,
      sessionId: parsed.sessionId,
    };
  } catch {
    return undefined;
  }
}

function encodeCreationCursor(record: SessionRecord, originCronId: string): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      k: 'cron-origin',
      createdAtMs: record.createdAtMs,
      sessionId: record.sessionId,
      originCronId,
    }),
  ).toString('base64url');
}

export function decodeCreationCursor(
  value: string | undefined,
  originCronId: string,
): CreationCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (
      !isRecord(parsed) ||
      parsed.v !== 1 ||
      parsed.k !== 'cron-origin' ||
      parsed.originCronId !== originCronId ||
      !Number.isSafeInteger(parsed.createdAtMs) ||
      typeof parsed.sessionId !== 'string' ||
      !parsed.sessionId
    ) {
      return undefined;
    }
    return {
      createdAtMs: parsed.createdAtMs as number,
      sessionId: parsed.sessionId,
    };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
