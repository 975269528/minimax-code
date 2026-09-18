const FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV1A_64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;
const COMPACT_CALL_KEY_WIDTH = 13;
const SHORT_CITATION_ALIAS_RE = /^[a-f0-9]{6}$/iu;

/**
 * Produces a compact, deterministic key for a tool call without exposing the
 * provider-sized tool_call_id to the model. The full tool_call_id remains in
 * structured source metadata and continues to own detail lookup.
 *
 * Citation matching is scoped to the source-bearing answer/turn. A 64-bit
 * fingerprint keeps collision risk negligible there while reducing common
 * provider call IDs from dozens of characters to a fixed 14-character token.
 */
export function compactToolCallCitationKey(toolCallId: string): string {
  let hash = FNV1A_64_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(toolCallId)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV1A_64_PRIME) & UINT64_MASK;
  }
  return `c${hash.toString(36).padStart(COMPACT_CALL_KEY_WIDTH, '0')}`;
}

export function buildToolCallCitationId(sourceId: string, toolCallId: string): string {
  return `${sourceId}:call:${compactToolCallCitationKey(toolCallId)}`;
}

/**
 * Recovers the single known six-character alias that differs from a
 * model-authored alias by exactly one character. Returning no match when the
 * correction is ambiguous keeps a damaged citation from opening the wrong
 * tool call.
 */
export function findUniqueSingleSubstitutionCitationAlias(
  value: string,
  candidates: Iterable<string>,
): string | undefined {
  if (!SHORT_CITATION_ALIAS_RE.test(value)) return undefined;

  const normalizedValue = value.toLowerCase();
  const matches = new Set<string>();
  for (const candidate of candidates) {
    if (!SHORT_CITATION_ALIAS_RE.test(candidate)) continue;
    const normalizedCandidate = candidate.toLowerCase();
    let differences = 0;
    for (let index = 0; index < normalizedValue.length; index += 1) {
      if (normalizedValue[index] !== normalizedCandidate[index]) differences += 1;
      if (differences > 1) break;
    }
    if (differences === 1) matches.add(normalizedCandidate);
  }

  return matches.size === 1 ? matches.values().next().value : undefined;
}

export function resolveKnownCitationAlias(
  value: string,
  knownCitationIds: Iterable<string>,
  citationIdsByAlias: ReadonlyMap<string, string>,
): string {
  const knownIds = new Set(knownCitationIds);
  if (knownIds.has(value)) return value;

  const exactCitationId =
    citationIdsByAlias.get(value) ?? citationIdsByAlias.get(value.toLowerCase());
  if (exactCitationId) return exactCitationId;

  const repairedAlias = findUniqueSingleSubstitutionCitationAlias(
    value,
    Array.from(citationIdsByAlias, ([alias, citationId]) =>
      knownIds.has(citationId) ? alias : '',
    ),
  );
  return (repairedAlias && citationIdsByAlias.get(repairedAlias)) ?? value;
}
