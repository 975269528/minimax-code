import type { LocalSessionListOptions, LocalSessionRecord } from './controller.js';

export function applyLocalSessionListOptions(
  records: LocalSessionRecord[],
  options?: LocalSessionListOptions,
): LocalSessionRecord[] {
  if (!options) return records.map((record) => ({ ...record }));
  const search = normalizeSearch(options.search);
  let result = records
    .slice()
    .sort(
      (left, right) =>
        right.updatedAtMs - left.updatedAtMs ||
        right.createdAtMs - left.createdAtMs ||
        left.sessionId.localeCompare(right.sessionId),
    );
  // Scan window first (newest by recency), filters apply within the window.
  const scanLimit = normalizePositiveInteger(options.scanLimit);
  if (scanLimit !== undefined) result = result.slice(0, scanLimit);
  result = result.filter((record) => matchesLocalSessionListOptions(record, options, search));
  if (options.cursor) {
    const cursorIndex = result.findIndex((record) => record.sessionId === options.cursor);
    if (cursorIndex >= 0) result = result.slice(cursorIndex + 1);
  }
  const offset = normalizeNonNegativeInteger(options.offset);
  if (offset > 0) result = result.slice(offset);
  const limit = normalizePositiveInteger(options.limit);
  if (limit !== undefined) result = result.slice(0, limit);
  return result.map((record) => ({ ...record }));
}

function matchesLocalSessionListOptions(
  record: LocalSessionRecord,
  options: LocalSessionListOptions,
  search: string,
): boolean {
  if (options.agentNames !== undefined) {
    if (!options.agentNames.includes(record.agentName)) return false;
  } else if (options.agentName && record.agentName !== options.agentName) {
    return false;
  }
  if (options.archived !== undefined && record.archived !== options.archived) return false;
  if (options.sessionType && record.sessionType !== options.sessionType) return false;
  if (options.includeHidden === false && record.visibility === 'hidden') return false;
  if (options.excludePurposePrefix && record.purpose?.startsWith(options.excludePurposePrefix)) {
    return false;
  }
  if (options.includePurposePrefix && !record.purpose?.startsWith(options.includePurposePrefix)) {
    return false;
  }
  if (!search) return true;
  return [
    record.sessionId,
    record.agentName,
    record.title,
    record.workspaceDir,
    record.purpose,
    record.status,
    record.sessionType,
  ].some((value) => normalizeSearch(value).includes(search));
}

function normalizeSearch(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeNonNegativeInteger(value: number | undefined): number {
  if (!Number.isFinite(value ?? 0)) return 0;
  return Math.max(0, Math.floor(value ?? 0));
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.floor(value));
}
