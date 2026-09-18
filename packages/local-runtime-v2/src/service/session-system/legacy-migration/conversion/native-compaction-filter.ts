/**
 * M0 — opencode compaction truncation.
 *
 * Mirrors `filterCompacted` from `sst/opencode`
 * `packages/opencode/src/session/message-v2.ts`. Extracted from
 * `legacy-opencode-native-conversion.ts` so upstream parity logic stays
 * isolated from conversion orchestration.
 *
 * Opencode's compaction flow inserts a `role: 'user'` message whose
 * `parts` include a `type: 'compaction'` part with `tail_start_id`
 * (pointing at the earliest message that must stay in the "tail" — the
 * uncompacted recent turns), immediately followed by a
 * `role: 'assistant'` `summary: true` message that summarises everything
 * before `tail_start_id`. Opencode itself replays only the summary +
 * tail + post-compaction turns when preparing model input; anything
 * before `tail_start_id` gets dropped from replay.
 *
 * Before v3 the migrator flattened the entire opencode message list
 * into pi-history, so a compacted session's pi-history exploded past the
 * model's context window (see `mvs_bf6ea07bd2144458bc734a6b6305c632`).
 * Running this filter before conversion mirrors opencode's own
 * behaviour: pre-compaction bulk is dropped, only the summary + tail +
 * post-compaction turns survive.
 *
 * ── SoT / oracle-parity boundary ───────────────────────────────────────
 * The final `slice + slice + slice` ordering and window predicates MUST
 * preserve opencode's `filterCompacted` oracle semantics. Structural
 * decomposition into helpers is allowed. Other intentional differences:
 * (a) our input is already time-ascending, so we skip opencode's
 *     "collect DESC then reverse to ASC" stream-safety pre-pass —
 *     equivalent to identity on ASC input;
 * (b) we return `{ messages, warnings }` instead of a bare list so ops
 *     can trace missing tail_start_id / summary / tailIndex mismatches;
 * (c) field lookups use small helpers (`readCompactionTailStartId` /
 *     `readMessageSummaryFlag` / `readMessageParentId`) so we tolerate
 *     opencode's snake_case ↔ camelCase drift across versions.
 * The reverse-scan compactionIndex + `findIndex` predicates, the
 * `tailIndex < compactionIndex &&
 * summaryIndex > compactionIndex` guard, and the final
 * `[compaction..summary, ...tail, ...post]` concat order are fixed.
 * Any reorder variant here counts as reinvention and is disallowed.
 * Sync base: `sst/opencode` message-v2.ts `filterCompacted` (as of the
 * v0.7 series, snake_case `tail_start_id`).
 * ── /oracle-parity boundary ───────────────────────────────────────────
 */
import type { LegacyOpenCodeNativeMessage, LegacyOpenCodeNativePart } from '../repo/contract.js';

export interface FilterCompactedResult {
  messages: readonly LegacyOpenCodeNativeMessage[];
  warnings: string[];
}

export function filterCompactedNativeMessages(
  messages: readonly LegacyOpenCodeNativeMessage[],
): FilterCompactedResult {
  const result = messages;
  const window = findCompactionWindow(result);
  if (isValidCompactionWindow(window)) {
    return {
      messages: [
        ...result.slice(window.compactionIndex, window.summaryIndex + 1),
        ...result.slice(window.tailIndex, window.compactionIndex),
        ...result.slice(window.summaryIndex + 1),
      ],
      warnings: [],
    };
  }
  return { messages: result, warnings: compactionWarnings(window) };
}

interface CompactionWindow {
  readonly compactionIndex: number;
  readonly compaction: LegacyOpenCodeNativeMessage | undefined;
  readonly tailStartId: string | undefined;
  readonly tailIndex: number;
  readonly summaryIndex: number;
}

function findCompactionWindow(messages: readonly LegacyOpenCodeNativeMessage[]): CompactionWindow {
  const compactionIndex = findLatestCompactionIndex(messages);
  const compaction = messageAt(messages, compactionIndex);
  const tailStartId = compactionTailStartId(compaction);
  return {
    compactionIndex,
    compaction,
    tailStartId,
    tailIndex: findMessageIndex(messages, tailStartId),
    summaryIndex: findSummaryIndex(messages, compactionIndex, compaction),
  };
}

function findLatestCompactionIndex(messages: readonly LegacyOpenCodeNativeMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isCompactionMessage(messages[index])) return index;
  }
  return -1;
}

function isCompactionMessage(message: LegacyOpenCodeNativeMessage | undefined): boolean {
  if (message?.role !== 'user') return false;
  return message.parts.some(isCompactionPartWithTail);
}

function isCompactionPartWithTail(part: LegacyOpenCodeNativePart): boolean {
  return part.type === 'compaction' && readCompactionTailStartId(part) !== undefined;
}

function messageAt(
  messages: readonly LegacyOpenCodeNativeMessage[],
  index: number,
): LegacyOpenCodeNativeMessage | undefined {
  return index < 0 ? undefined : messages[index];
}

function compactionTailStartId(
  compaction: LegacyOpenCodeNativeMessage | undefined,
): string | undefined {
  const part = compaction?.parts.find(isCompactionPartWithTail);
  return part ? readCompactionTailStartId(part) : undefined;
}

function findMessageIndex(
  messages: readonly LegacyOpenCodeNativeMessage[],
  messageId: string | undefined,
): number {
  return messageId ? messages.findIndex(({ id }) => id === messageId) : -1;
}

function findSummaryIndex(
  messages: readonly LegacyOpenCodeNativeMessage[],
  compactionIndex: number,
  compaction: LegacyOpenCodeNativeMessage | undefined,
): number {
  if (!compaction) return -1;
  return messages.findIndex(
    (message, index) =>
      index > compactionIndex &&
      message.role === 'assistant' &&
      readMessageSummaryFlag(message) &&
      readMessageParentId(message) === compaction.id,
  );
}

function isValidCompactionWindow(window: CompactionWindow): boolean {
  if (window.tailIndex < 0) return false;
  if (window.tailIndex >= window.compactionIndex) return false;
  return window.summaryIndex > window.compactionIndex;
}

function compactionWarnings(window: CompactionWindow): string[] {
  return [
    missingTailWarning(window),
    unresolvedTailWarning(window),
    missingSummaryWarning(window),
  ].filter((warning): warning is string => warning !== undefined);
}

function missingTailWarning(window: CompactionWindow): string | undefined {
  if (window.compactionIndex < 0 || window.tailStartId || !window.compaction) return undefined;
  return `compaction_part_missing_tail_start_id:${window.compaction.id}`;
}

function unresolvedTailWarning(window: CompactionWindow): string | undefined {
  if (!window.compaction || !window.tailStartId || window.tailIndex >= 0) return undefined;
  return `compaction_tail_start_id_unresolved:${window.compaction.id}:${window.tailStartId}`;
}

function missingSummaryWarning(window: CompactionWindow): string | undefined {
  if (!window.compaction || !window.tailStartId) return undefined;
  if (window.tailIndex < 0 || window.summaryIndex >= 0) return undefined;
  return `compaction_summary_missing:${window.compaction.id}`;
}

/**
 * Read `tail_start_id` from an opencode compaction part. Opencode 0.7+
 * uses `snake_case` inside `data`, older builds may have used camelCase
 * or hoisted the field onto the raw row — try each in priority order so
 * cross-version data stays readable.
 */
function readCompactionTailStartId(part: LegacyOpenCodeNativePart): string | undefined {
  const dataRecord = readObject(part.data);
  const rawRecord = part.raw;
  return (
    readString(dataRecord, ['tail_start_id', 'tailStartId']) ??
    readString(rawRecord, ['tail_start_id', 'tailStartId'])
  );
}

/**
 * Read the `summary: true` flag from an opencode message. On 0.7+ the
 * store may hoist the flag onto the outer row, but the truth normally
 * lives inside the JSON `data` blob. We try both: outer row first (fast
 * path), then the parsed `data`, then any lifted `raw.data` block on
 * legacy shapes.
 */
function readMessageSummaryFlag(message: LegacyOpenCodeNativeMessage): boolean {
  const raw = message.raw;
  if (raw && typeof raw['summary'] === 'boolean') return raw['summary'] === true;
  const dataRecord = extractDataRecord(raw);
  if (dataRecord && typeof dataRecord['summary'] === 'boolean') {
    return dataRecord['summary'] === true;
  }
  return false;
}

/**
 * Read `parentID` (opencode 0.7+) or `parent_id` (older builds), first
 * on the raw envelope and then inside `data`, so cross-version data
 * stays traceable.
 */
function readMessageParentId(message: LegacyOpenCodeNativeMessage): string | undefined {
  const raw = message.raw;
  const rawParent = readString(raw, ['parentID', 'parent_id']);
  if (rawParent) return rawParent;
  const dataRecord = extractDataRecord(raw);
  return readString(dataRecord, ['parentID', 'parent_id']);
}

/**
 * `LegacyOpencodeStore.nativeMessageFromRow` stashes the raw SQLite row
 * under `.raw`, so any JSON-encoded fields (`summary`, `parentID`,
 * `data` payload) still live inside `raw.data` as a string. Try both:
 * an already-parsed object (older tests / builds) and the string form.
 */
function extractDataRecord(
  raw: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const value = raw['data'];
  const direct = readObject(value);
  if (direct) return direct;
  if (typeof value === 'string' && value.length > 0) return parseDataRecord(value);
  return undefined;
}

function parseDataRecord(raw: string): Record<string, unknown> | undefined {
  try {
    return readObject(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
