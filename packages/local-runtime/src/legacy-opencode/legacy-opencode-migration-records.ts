import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';

import type { LegacyMigrationRecord } from '../persistence/migration/legacy-migration-store.js';
import {
  NATIVE_PI_HISTORY_CONVERTER_VERSION,
  type PiHistoryGroup,
} from './legacy-opencode-native-conversion.js';

/**
 * Legacy-migration record readiness predicates + pi-history watermark and
 * regrouping helpers, shared by `legacy-opencode-migrator.ts`. Extracted from
 * that file (verbatim) to keep it under the local-runtime layout budget;
 * behaviour is unchanged. All functions are pure.
 */

export function isLegacyProjectionReady(record: LegacyMigrationRecord | undefined): boolean {
  return Boolean(
    record?.status === 'migrated' && record.ledgerImportedAtMs && record.projectionReadyAtMs,
  );
}

export function isLegacyDisplayReady(record: LegacyMigrationRecord | undefined): boolean {
  return Boolean(record?.displayReadyAtMs ?? record?.projectionReadyAtMs);
}

/**
 * `native-*` strategies produce role/content blocks whose shape has evolved.
 * The v1 converter emitted `type: 'reasoning'`, `type: 'tool-call'` and
 * `role: 'tool'`, none of which the pi-agent runtime recognises — the
 * effect on already-migrated sessions is that tool calls / results
 * silently vanish from replay. A stale native record therefore needs to
 * fall through the ready gate so `ensurePiHistoryMigrated` re-runs the
 * converter (writer.importPiHistory fully replaces the rows).
 *
 * Non-native strategies (`display-seed-*`, `existing-seed-preserved`,
 * `deferred`) produce a single user-role seed message whose shape has not
 * changed, so this stamp-and-check dance only applies when the record was
 * produced from A2 native opencode sources.
 */
export function isLegacyPiHistoryConverterCurrent(
  record: LegacyMigrationRecord | undefined,
): boolean {
  if (!record) return true;
  const strategy = record.piHistoryStrategy ?? '';
  if (!strategy.startsWith('native-')) return true;
  return (record.piHistoryConverterVersion ?? 0) >= NATIVE_PI_HISTORY_CONVERTER_VERSION;
}

export function isLegacyPiHistoryReady(record: LegacyMigrationRecord | undefined): boolean {
  const flagged = Boolean(
    record?.piHistoryReadyAtMs ??
    (isLegacyProjectionReady(record) ? record?.projectionReadyAtMs : undefined),
  );
  return flagged && isLegacyPiHistoryConverterCurrent(record);
}

/**
 * True when this record has a `native-*` strategy that predates the
 * current converter version — i.e. it needs the v3 upgrade path. We
 * only take the scenario-B shortcut in `ensurePiHistoryMigrated` when
 * this is true; other paths (fresh, non-native, or already-current)
 * follow the regular migrate flow.
 */
export function needsV3Upgrade(record: LegacyMigrationRecord | undefined): boolean {
  if (!record) return false;
  const strategy = record.piHistoryStrategy ?? '';
  if (!strategy.startsWith('native-')) return false;
  return (record.piHistoryConverterVersion ?? 0) < NATIVE_PI_HISTORY_CONVERTER_VERSION;
}

/**
 * Count pi-history rows whose message-level `.timestamp` sits at or
 * before `watermarkMs` — the "legacy segment" of pi-history relative
 * to the previous migration's watermark. Used by the v3 upgrade path
 * to distinguish scenario A (some legacy rows still around → full
 * re-migrate) from scenario B (all rows post-migration → no-op stamp).
 */
export function countRowsAtOrBefore(rows: PiAgentMessage[], watermarkMs: number): number {
  let n = 0;
  for (const row of rows) {
    if (readMessageTimestamp(row) <= watermarkMs) n += 1;
  }
  return n;
}

/**
 * When re-migrating a session whose first migration wrote rows that we
 * now know are broken (v1 converter silently dropped tool calls),
 * preserve the user-driven continued conversation rows that were
 * appended on top by the real pi-agent runtime. The boundary is the
 * previous migration's `migratedAtMs` watermark: rows whose message
 * timestamp is strictly greater than that were produced after the
 * original import and must survive untouched; rows on the other side
 * were written by v1 of the converter and are about to be replaced by
 * the v2 native output below.
 *
 * Behaviour when `previousMigratedAtMs` is undefined (fresh import, no
 * prior record): keep everything — there is no v1 output to
 * distinguish from. When the watermark is set but every existing
 * message has `timestamp <= previousMigratedAtMs`: keep nothing — the
 * existing rows were all v1 output and are about to be replaced.
 */
export function filterPostMigrationMessages(
  existingPiHistory: PiAgentMessage[],
  previousMigratedAtMs?: number,
): PiAgentMessage[] {
  if (!previousMigratedAtMs) return existingPiHistory;
  return existingPiHistory.filter((message) => {
    const ts = readMessageTimestamp(message);
    return ts > previousMigratedAtMs;
  });
}

/**
 * Read the message-level `timestamp` field defensively. Missing /
 * non-numeric values fall back to 0 so the stable sort in
 * `buildPiHistory` still terminates without throwing, and any such row
 * sorts to the front (the earliest possible slot) rather than
 * accidentally being reordered against later rows. Kept next to
 * `filterPostMigrationMessages` so the two watermark helpers share the
 * same timestamp-extraction rule.
 */
export function readMessageTimestamp(message: PiAgentMessage): number {
  const value = (message as { timestamp?: unknown }).timestamp;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Re-group a flat pi-history segment into PiHistoryGroup atoms so it
 * can be merged with the freshly-converted native side without losing
 * `assistant → toolResult` adjacency.
 *
 * Rules (mirror opencode's own "one message = one atom" view):
 *   - Every `assistant` message opens a new group; the group greedily
 *     absorbs any run of subsequent `toolResult` messages (that's the
 *     pi-agent convention — call blocks live on the assistant, results
 *     land as their own messages right after).
 *   - Every `user` message is its own single-row group.
 *   - Standalone `toolResult` (no preceding assistant in this segment)
 *     is a single-row group with `kind='tool'`; the merge is neutral
 *     but the sanitizer will drop it as R2 orphan if it ever leaks
 *     into the native segment.
 *   - Anything else (unknown role) becomes a single-row group with
 *     `kind='unknown'` so it stays in place and doesn't get dropped
 *     silently.
 *
 * `leaderTimestamp` = the atom's leading message timestamp (readMessageTimestamp
 * fallback to 0 for missing/non-numeric).
 */
export function regroupPiAgentMessages(messages: PiAgentMessage[]): PiHistoryGroup[] {
  const out: PiHistoryGroup[] = [];
  let i = 0;
  while (i < messages.length) {
    const head = messages[i];
    if (!head) {
      i += 1;
      continue;
    }
    const role = (head as { role?: unknown }).role;
    if (role === 'assistant') {
      const group: PiAgentMessage[] = [head];
      let j = i + 1;
      while (j < messages.length) {
        const next = messages[j];
        if (!next) break;
        if ((next as { role?: unknown }).role !== 'toolResult') break;
        group.push(next);
        j += 1;
      }
      out.push({
        leaderTimestamp: readMessageTimestamp(head),
        kind: 'assistant',
        messages: group,
      });
      i = j;
      continue;
    }
    const kind: PiHistoryGroup['kind'] =
      role === 'user' ? 'user' : role === 'toolResult' ? 'tool' : 'unknown';
    out.push({
      leaderTimestamp: readMessageTimestamp(head),
      kind,
      messages: [head],
    });
    i += 1;
  }
  return out;
}
