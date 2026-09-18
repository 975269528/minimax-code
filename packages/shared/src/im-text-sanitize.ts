/**
 * Shared IM-outbound text sanitizers for agent-emitted XML tags that have
 * no native IM representation.
 *
 * P0-3 minimal stopgap: agent reply text may contain `<media src=... />`
 * (single media reference) or `<deliver-assets>...</deliver-assets>`
 * (multi-asset wrapper) blocks. The real out-of-band media upload pipeline
 * (P2) is not built yet, so without a sanitizer these tags reach the user
 * as literal text — e.g. `<media src="/tmp/foo.png" caption="Architecture diagram" />`
 * showing up verbatim in Feishu / Telegram / WeChat. This helper rewrites
 * those tags to short human-readable placeholders so the user at least
 * sees a meaningful hint that "the agent intended to deliver media".
 *
 * Lives in `@mavis/shared` because TWO outbound surfaces need it:
 *
 *   1. `IMGatewayChannelClient.sanitizeForIM` (Feishu / WeChat via the
 *      electron-side IM gateway).
 *   2. `collectChannelResponseFromSse` (Telegram and the mock outbound,
 *      which never pass through the electron sanitizer).
 *
 * Replacement rules:
 *
 *   - `<media ... />` (or opening tag, self-closing or not) → either
 *     `[Media: <caption>]` (when `caption` attr is set), or
 *     `[Media: <filename>]` (basename of `src`, query string stripped),
 *     or `[Media]` when neither is available.
 *   - `<deliver-assets>...</deliver-assets>` → `[N delivered assets]` where N
 *     counts inner `<media>`/`<asset>` children, falling back to
 *     `[Delivered assets]` when the count is zero or indeterminate.
 *
 * The replacement is single-pass and does NOT try to fully parse the XML
 * — agents may emit malformed or streaming-truncated tags, and the goal
 * is "do not leak literal `<media`" rather than "render media correctly".
 * The full media path is P2.
 *
 * NOTE: This helper deliberately leaves `<think>` and `<genui-*>` blocks
 * alone. The IM gateway has its own strip step for those (see
 * `IMGatewayChannelClient.sanitizeForIM`); the Telegram path keeps the
 * tags by design today (P0 scope is media only). Callers that need both
 * should compose: strip first, then call `placeholderMediaTags`.
 */

/**
 * Pull an attribute value out of a tag-open string.
 *
 * Handles double-quoted (`attr="value"`), single-quoted (`attr='value'`)
 * and unquoted (`attr=value`) forms. Returns `undefined` when the
 * attribute is absent or malformed. Attribute names are case-insensitive.
 */
function readAttr(tagOpen: string, attr: string): string | undefined {
  const re = new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu');
  const m = tagOpen.match(re);
  if (!m) return undefined;
  return m[1] ?? m[2] ?? m[3];
}

/**
 * Reduce a `src` value to a user-friendly filename. Strips query string
 * and fragment, splits on `/` or `\`, takes the last segment. Returns
 * `undefined` for an empty or whitespace-only result.
 */
function srcToFilename(src: string | undefined): string | undefined {
  if (!src) return undefined;
  const stripped = src.split('?')[0]?.split('#')[0] ?? '';
  const parts = stripped.split(/[\\/]/u);
  const last = parts[parts.length - 1]?.trim();
  if (!last) return undefined;
  return last;
}

/**
 * Format a single `<media …/>` (or `<media …>` opening tag) as a
 * placeholder string for IM display.
 *
 * Priority order:
 *   1. `caption` attribute value (trimmed, non-empty)
 *   2. basename of `src` (query stripped)
 *   3. `[Media]` fallback
 */
function mediaTagPlaceholder(tagOpen: string): string {
  const caption = readAttr(tagOpen, 'caption')?.trim();
  if (caption) return `[媒体: ${caption}]`;
  const filename = srcToFilename(readAttr(tagOpen, 'src'))?.trim();
  if (filename) return `[媒体: ${filename}]`;
  return '[媒体]';
}

/**
 * Count `<media>` and `<asset>` children inside a `<deliver-assets>` block
 * body. Self-closing or opening tags both count. Returns the integer
 * count; 0 when nothing matches.
 */
function countDeliverChildren(body: string): number {
  const re = /<(?:media|asset)\b[^>]*\/?>/giu;
  const matches = body.match(re);
  return matches ? matches.length : 0;
}

/**
 * Single-media tag: self-closing `<media ... />` OR opening `<media ...>`.
 *
 * The pattern intentionally accepts both because streaming-truncated
 * output can produce either, and either way we want the literal token
 * gone before it reaches an IM platform. The matcher requires either at
 * least one space after `media` (attributed form) or an immediate `/>`
 * (bare `<media/>`), so it does not collide with hypothetical
 * `<media-something>` neighbours.
 */
const MEDIA_TAG_RE = /<media(?:\s+[^>]*?)?\s*\/?>/giu;

/**
 * `<deliver-assets>` block, with or without attributes, non-greedy body.
 */
const DELIVER_ASSETS_RE = /<deliver-assets(?:\s+[^>]*)?>[\s\S]*?<\/deliver-assets>/giu;

/**
 * Replace `<media>` and `<deliver-assets>` XML tags in `text` with short
 * IM-friendly placeholder strings. See the module docstring for the full
 * rule set.
 *
 * Idempotent: a second call on the same input is a no-op (the placeholder
 * strings contain no XML).
 *
 * Order: `<deliver-assets>` is processed FIRST so its `<media>` children
 * are counted (not individually replaced) when they live inside a wrapper
 * block. Stray `<media>` tags outside any wrapper get the per-tag
 * placeholder pass after that.
 */
export function placeholderMediaTags(text: string): string {
  if (!text) return text;
  let out = text;

  // 1. Deliver-assets wrapper → `[N delivered assets]` (N counted from inner
  //    <media>/<asset> children, falling back to `[Delivered assets]` when 0).
  out = out.replace(DELIVER_ASSETS_RE, (match) => {
    const inner = match
      .replace(/^<deliver-assets(?:\s+[^>]*)?>/iu, '')
      .replace(/<\/deliver-assets>\s*$/iu, '');
    const n = countDeliverChildren(inner);
    return n > 0 ? `[${n} 个交付资产]` : '[交付资产]';
  });

  // 2. Standalone <media …/> tags → per-tag placeholder.
  out = out.replace(MEDIA_TAG_RE, (match) => mediaTagPlaceholder(match));

  return out;
}
