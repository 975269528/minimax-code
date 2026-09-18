export type V3PostCompactionSkipReason =
  | 'all-rows-after-watermark'
  | 'archon-compaction-marker'
  | 'legacy-compaction-summary';

export function detectPostPiCompactionReplacement(
  rows: readonly unknown[],
  legacyRowsNow: number,
): V3PostCompactionSkipReason | undefined {
  if (legacyRowsNow === 0) return 'all-rows-after-watermark';
  const first = rows[0];
  if (!first) return undefined;
  if (hasArchonCompactionMarker(first)) return 'archon-compaction-marker';
  if (hasLegacyCompactionSummary(first)) return 'legacy-compaction-summary';
  return undefined;
}

function hasArchonCompactionMarker(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const marker = (message as { archonCompaction?: unknown }).archonCompaction;
  if (!marker || typeof marker !== 'object') return false;
  const summary = (marker as { summary?: unknown }).summary;
  return typeof summary === 'string';
}

function hasLegacyCompactionSummary(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as { role?: unknown; summary?: unknown };
  return candidate.role === 'compactionSummary' && typeof candidate.summary === 'string';
}
