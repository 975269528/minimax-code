/**
 * `<queued-user-message>` — out-of-band user input that arrived mid-turn.
 *
 * When a user types into Web (or any inbound source) while an agent's turn
 * is still running, the daemon parks the message on `SessionInboundQueue`.
 * Path A (local legacy local runtime) and Path B (cloud pi) both drain those queued
 * items at a turn-loop boundary and inject them back to the model as a
 * fresh `role:"user"` message. To keep the model honest about provenance,
 * the injected text is wrapped in `<queued-user-message>...</queued-user-message>`
 * — the model can see the inner content but knows it was inserted out of
 * band, not as the original prompt of the current turn.
 *
 * Anti-spoofing: user text might itself contain literal `<queued-user-message>`
 * tags (legitimately discussing the feature, or maliciously trying to fake
 * an out-of-band insertion to elevate priority / override prior instructions).
 * Before wrapping, the helper escapes any embedded opening / closing tags so
 * the only real wrapper boundary is the one this helper generates. The
 * regex is case-insensitive and attribute-tolerant to match the wrapping
 * shape produced by `wrapQueuedMessageText`.
 *
 * This module is framework-agnostic (no daemon / legacy local-runtime plugin /
 * cloud-runtime imports) so both injection paths can reuse it without
 * duplicating regex.
 */

/** Tag name — keep in one place; changing it requires updating both injection paths. */
export const QUEUED_USER_MESSAGE_TAG = 'queued-user-message';

/**
 * Match any literal `<queued-user-message ...>` or `</queued-user-message>`
 * sequence the user might have typed verbatim. Case-insensitive, attribute-
 * tolerant, and matches both open and close forms in one pass so the
 * sanitizer is a single-replace.
 */
const QUEUED_USER_MESSAGE_TAG_RE = /<\/?queued-user-message\b[^>]*>/giu;

/**
 * Replace any literal opening / closing `<queued-user-message>` tag in `text`
 * with an escaped form (`&lt;queued-user-message&gt;` / `&lt;/queued-user-message&gt;`)
 * so the only real wrapper boundary is the one `wrapQueuedMessageText`
 * inserts. Idempotent on already-escaped input (`&lt;...&gt;` does not
 * contain `<`).
 */
export function escapeQueuedUserMessageTags(text: string): string {
  if (!text) return '';
  return text.replace(QUEUED_USER_MESSAGE_TAG_RE, (match) => {
    // Replace `<` and `>` only — preserve everything in between verbatim.
    return match.replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
  });
}

/** Metadata stamped onto a wrapped queued user message. Optional fields are
 *  emitted as attributes only when non-empty so the wrapped form stays
 *  compact for the common case (text-only Web message). */
export interface QueuedMessageMetadata {
  /** Inbound source — `'api'` for Web, `'channel:feishu'` for IM, etc. */
  source?: string;
  /** Queue item id from `SessionInboundQueue`. Useful for debugging /
   *  correlating logs across daemon → plugin → model output. */
  itemId?: string;
  /** Original enqueue timestamp (Unix ms). Lets the model see how stale
   *  the message is by the time injection happens. */
  enqueuedAtMs?: number;
}

/** Escape a value so it is safe to embed inside an XML attribute. Replaces
 *  the four characters that break attribute parsing. Conservative — keeps
 *  Unicode and whitespace as-is. */
function escapeAttributeValue(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

/**
 * Wrap a single drained user message in `<queued-user-message>` with metadata
 * attributes. Input text is sanitized first so embedded tags cannot fake an
 * outer boundary. Returns a single line of XML-ish text suitable for
 * appending directly to an assistant transcript as `role:"user"` content.
 *
 * Empty / whitespace-only input returns an empty string — caller should
 * skip injection entirely instead of emitting an empty wrapper.
 */
export function wrapQueuedMessageText(text: string, metadata: QueuedMessageMetadata = {}): string {
  if (!text || !text.trim()) return '';
  const safeBody = escapeQueuedUserMessageTags(text);

  const attrs: string[] = [];
  if (metadata.source) attrs.push(`source="${escapeAttributeValue(metadata.source)}"`);
  if (metadata.itemId) attrs.push(`item-id="${escapeAttributeValue(metadata.itemId)}"`);
  if (metadata.enqueuedAtMs && Number.isFinite(metadata.enqueuedAtMs)) {
    attrs.push(`enqueued-at-ms="${metadata.enqueuedAtMs}"`);
  }
  const attrSuffix = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
  return `<${QUEUED_USER_MESSAGE_TAG}${attrSuffix}>\n${safeBody}\n</${QUEUED_USER_MESSAGE_TAG}>`;
}

/** Concatenate multiple wrapped queued messages with a blank line between
 *  them so the model sees each one as a distinct out-of-band insertion.
 *  Drops empty entries silently. */
export function wrapQueuedMessageBatch(
  items: Array<{ text: string; metadata?: QueuedMessageMetadata }>,
): string {
  const wrapped = items
    .map((item) => wrapQueuedMessageText(item.text, item.metadata))
    .filter((text) => text.length > 0);
  return wrapped.join('\n\n');
}
