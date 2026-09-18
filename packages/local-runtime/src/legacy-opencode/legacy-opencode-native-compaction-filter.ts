/**
 * M0 — opencode compaction truncation.
 *
 * Mirrors `filterCompacted` from `sst/opencode`
 * `packages/opencode/src/session/message-v2.ts`. Extracted from
 * `legacy-opencode-native-conversion.ts` to keep both files under the
 * local-runtime layout gate's default 500-line budget.
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
 * ── SoT / verbatim boundary ────────────────────────────────────────────
 * The final `slice + slice + slice` reorder segment MUST stay byte-for-
 * byte aligned with opencode's `filterCompacted`. Divergences allowed:
 * (a) our input is already time-ascending, so we skip opencode's
 *     "collect DESC then reverse to ASC" stream-safety pre-pass —
 *     equivalent to identity on ASC input;
 * (b) we return `{ messages, warnings }` instead of a bare list so ops
 *     can trace missing tail_start_id / summary / tailIndex mismatches;
 * (c) field lookups use small helpers (`readCompactionTailStartId` /
 *     `readMessageSummaryFlag` / `readMessageParentId`) so we tolerate
 *     opencode's snake_case ↔ camelCase drift across versions.
 * Every other line — the reverse-scan compactionIndex + `findIndex`
 * predicates, the `tailIndex < compactionIndex &&
 * summaryIndex > compactionIndex` guard, and the final
 * `[compaction..summary, ...tail, ...post]` concat order — is fixed.
 * Any reorder variant here counts as reinvention and is disallowed.
 * Sync base: `sst/opencode` message-v2.ts `filterCompacted` (as of the
 * v0.7 series, snake_case `tail_start_id`).
 * ── /verbatim boundary ────────────────────────────────────────────────
 */
import type {
  LegacyOpenCodeNativeMessage,
  LegacyOpenCodeNativePart,
} from './legacy-opencode-store.js';

export interface FilterCompactedResult {
  messages: LegacyOpenCodeNativeMessage[];
  warnings: string[];
}

export function filterCompactedNativeMessages(
  messages: LegacyOpenCodeNativeMessage[],
): FilterCompactedResult {
  const result = messages;
  const warnings: string[] = [];

  // ── verbatim from opencode filterCompacted ─────────────────────────
  // Target lib is ES2022 in this workspace and `Array.findLastIndex` is
  // ES2023-only; use a manual reverse loop with an equivalent predicate
  // (this is the ONE unavoidable syntactic accommodation vs opencode's
  // `.findLastIndex(...)`; semantics stay identical — first match seen
  // when scanning from the tail).
  let compactionIndex = -1;
  for (let i = result.length - 1; i >= 0; i -= 1) {
    const msg = result[i];
    if (
      msg &&
      msg.role === 'user' &&
      msg.parts.some(
        (candidate) =>
          candidate.type === 'compaction' && readCompactionTailStartId(candidate) !== undefined,
      )
    ) {
      compactionIndex = i;
      break;
    }
  }
  const compaction = compactionIndex >= 0 ? result[compactionIndex] : undefined;
  const part = compaction?.parts.find(
    (item) => item.type === 'compaction' && readCompactionTailStartId(item) !== undefined,
  );
  const tailStartId = part ? readCompactionTailStartId(part) : undefined;
  const summaryIndex = compaction
    ? result.findIndex(
        (msg, index) =>
          index > compactionIndex &&
          msg.role === 'assistant' &&
          readMessageSummaryFlag(msg) === true &&
          readMessageParentId(msg) === compaction.id,
      )
    : -1;
  const tailIndex = tailStartId ? result.findIndex((msg) => msg.id === tailStartId) : -1;
  if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
    return {
      messages: [
        ...result.slice(compactionIndex, summaryIndex + 1), // [compaction-user, summary]
        ...result.slice(tailIndex, compactionIndex), // tail messages
        ...result.slice(summaryIndex + 1), // Subsequent conversation
      ],
      warnings,
    };
  }
  // ── /verbatim ──────────────────────────────────────────────────────

  // Anything below here is our own diagnostics layer — opencode's
  // filterCompacted just returns `result` unchanged in these branches.
  // We add structured `warnings` so ops can spot data-shape drift.
  if (compactionIndex >= 0 && !tailStartId && compaction) {
    warnings.push(`compaction_part_missing_tail_start_id:${compaction.id}`);
  }
  if (compactionIndex >= 0 && tailStartId && tailIndex < 0 && compaction) {
    warnings.push(`compaction_tail_start_id_unresolved:${compaction.id}:${tailStartId}`);
  }
  if (compactionIndex >= 0 && tailStartId && tailIndex >= 0 && summaryIndex < 0 && compaction) {
    warnings.push(`compaction_summary_missing:${compaction.id}`);
  }
  return { messages: result, warnings };
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
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  return undefined;
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
