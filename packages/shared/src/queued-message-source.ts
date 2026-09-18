/**
 * queued-message-source — aggregate the routing source of a drained
 * batch of queued user messages into a single "merged" source that
 * downstream dispatch / reply routing can rely on.
 *
 * Why this lives here (shared): local-runtime compatibility imports and
 * cloud-runtime both drain the same kind of queued user input, and the new
 * injection design (see
 * `queued-message-injection-redesign.html`) demands one identical rule
 * for "what source does the MERGED user message carry?":
 *
 *   1. If every drained item is `'api'` (Web) → merged source is `'api'`.
 *   2. If ANY item is from an IM channel (`'channel:*'`) → merged
 *      source is IM. When multiple IM items are present, take the
 *      **last** IM in FIFO order — that is the most recent IM
 *      participant and the one most likely to be waiting for a reply,
 *      so we route the merged user message (and any reply receipt)
 *      back to that channel.
 *   3. Empty input falls back to a caller-supplied default (`'api'` by
 *      default) — empty drain should not actually call this, but the
 *      defensive default avoids `undefined` propagating into
 *      `MessageRequest.source`.
 *
 * The function is intentionally pure / structural — it returns a fresh
 * `{ source, origin?, inboundContext? }` triple. Callers decide what to
 * do with it (local-runtime fills `MessageRequest`; cloud-runtime uses it
 * for log attribution).
 */

/** Minimum shape we need from a queued item to compute the merged
 *  source. Both daemon `SessionQueueItem` and the
 *  `DrainedQueueItem` shape returned over HTTP satisfy this. */
export interface QueuedItemSourceLike {
  source?: string;
  origin?: unknown;
  inboundContext?: unknown;
}

/** Aggregated routing source for a merged user message. `origin` /
 *  `inboundContext` are only populated when the winning item is an IM
 *  channel item that carried them. */
export interface AggregatedQueuedSource {
  source: string;
  origin?: unknown;
  inboundContext?: unknown;
}

/** Channel-source predicate — anything starting with `channel:` is
 *  treated as IM (matches daemon's `isChannelSource` and the
 *  `MessageSource` union in `packages/daemon/src/common/types.ts`). */
export function isChannelSource(source: string | undefined): boolean {
  return typeof source === 'string' && source.startsWith('channel:');
}

/**
 * Compute the merged source for a drained batch.
 *
 * Rules (see file header for full rationale):
 *   - All API / no IM → returns `{ source: fallbackSource }`.
 *   - Any IM present → returns the LAST IM item's
 *     `{ source, origin, inboundContext }` in FIFO order.
 *   - Empty input → returns `{ source: fallbackSource }`.
 *
 * Pure: never throws, never mutates input. Items missing a `source`
 * are treated as non-IM (they cannot be the IM winner).
 */
export function aggregateQueuedSource(
  items: ReadonlyArray<QueuedItemSourceLike>,
  fallbackSource = 'api',
): AggregatedQueuedSource {
  let lastIm: QueuedItemSourceLike | undefined;
  for (const item of items) {
    if (isChannelSource(item.source)) {
      lastIm = item;
    }
  }
  if (lastIm && typeof lastIm.source === 'string') {
    const aggregated: AggregatedQueuedSource = { source: lastIm.source };
    if (lastIm.origin !== undefined) aggregated.origin = lastIm.origin;
    if (lastIm.inboundContext !== undefined) aggregated.inboundContext = lastIm.inboundContext;
    return aggregated;
  }
  return { source: fallbackSource };
}
