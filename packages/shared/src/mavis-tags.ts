/**
 * Single source of truth for the owner-facing `<mavis-thinking>` and
 * `<mavis-progress>` blocks.
 *
 * Two semantically distinct tags:
 *
 * 1. `<mavis-thinking>...</mavis-thinking>` — internal trace owner sessions
 *    write when handling Team Engine workflow privately. Stripped from
 *    outbound text (IM forwarders MUST not leak it) and folded out of UI
 *    (rendered as a collapsible thinking block, not as a chat message).
 *
 * 2. `<mavis-progress>...</mavis-progress>` — visible-but-quiet intermediate
 *    progress notes. Owner uses this to show meaningful intra-cycle progress
 *    that the user can SEE when they look but should NOT be alerted on.
 *    The tag NAME is stripped before render (UI shows the inner text); the
 *    inner content is kept (unlike `<mavis-thinking>`, which is removed
 *    entirely).
 *
 * Both regexes are case-insensitive, dotall, and attribute-tolerant so the
 * exact boundary semantics agree across daemon, IM forwarders, and UI.
 *
 * Helpers exported here are framework-agnostic (no daemon / UI dependencies)
 * so both packages can re-export and use them without duplicating regex.
 */

export const MAVIS_THINKING_BLOCK_RE = /<mavis-thinking\b[^>]*>([\s\S]*?)<\/mavis-thinking>/giu;

export const MAVIS_PROGRESS_BLOCK_RE = /<mavis-progress\b[^>]*>([\s\S]*?)<\/mavis-progress>/giu;

/**
 * Remove every `<mavis-thinking>...</mavis-thinking>` block (tag + content)
 * and trim. Use when you want the trace to disappear entirely.
 */
export function stripMavisThinkingTags(content: string): string {
  return content.replace(MAVIS_THINKING_BLOCK_RE, '').trim();
}

/**
 * Remove every `<mavis-progress>` and `</mavis-progress>` tag while KEEPING
 * the inner text. The progress note becomes plain visible text — what the
 * user reads when they open the conversation. Trims the result.
 *
 * The replacement is wrapped in single spaces so that a progress block
 * sitting flush against surrounding text doesn't visually fuse with it
 * (e.g. `<mavis-progress>tests running</mavis-progress>Done.` →
 * "tests running Done." instead of "tests runningDone."). Subsequent
 * collapse keeps the result clean: trailing/leading whitespace is trimmed
 * and any double spaces created by adjacent blocks collapse to one.
 */
export function stripMavisProgressTags(content: string): string {
  return content
    .replace(MAVIS_PROGRESS_BLOCK_RE, (_match, inner: string) => ` ${inner.trim()} `)
    .replace(/  +/gu, ' ')
    .trim();
}

/**
 * After stripping `<mavis-thinking>` blocks AND replacing `<mavis-progress>`
 * tags with their inner content, return the remaining visible text. This is
 * the canonical "what the user actually sees" projection of an owner reply.
 *
 * Returns the trimmed result. Empty string when nothing visible remains
 * (e.g. content was thinking-only, progress-only, or thinking+progress with
 * no plain text).
 */
export function extractVisibleContent(content: string): string {
  if (!content) return '';
  return stripMavisProgressTags(stripMavisThinkingTags(content));
}

/**
 * True iff the content is non-empty AND contains nothing the user should be
 * alerted on after stripping `<mavis-thinking>` blocks (removed entirely)
 * and `<mavis-progress>` tags+content (also removed for this check —
 * progress is "visible but quiet", same alert semantics as thinking).
 *
 * Empty / whitespace-only input returns false (a truly empty turn is just
 * empty, not thinking-only).
 *
 * Used by daemon to decide whether `session.finish` payloads should carry
 * `silent: true`.
 */
export function isThinkingOrProgressOnly(content: string): boolean {
  if (!content || !content.trim()) return false;
  // Strip thinking blocks first (tag + content removed entirely).
  const withoutThinking = stripMavisThinkingTags(content);
  // For the silence decision, BOTH tag families count as "not user-facing".
  // We strip progress block entirely (tag + content) here — the visibility
  // of progress is a separate concern handled by `extractVisibleContent`.
  const withoutBoth = withoutThinking.replace(MAVIS_PROGRESS_BLOCK_RE, '').trim();
  return withoutBoth === '';
}

/**
 * @deprecated Use `isThinkingOrProgressOnly`. Kept for backward compatibility
 * with callers that only know about the thinking tag. Equivalent to
 * "stripMavisThinkingTags(content) === '' && content !== ''".
 */
export function isThinkingOnlyContent(content: string): boolean {
  if (!content) return false;
  return stripMavisThinkingTags(content) === '';
}

/**
 * Side-effect-free check for whether `content` contains any
 * `<mavis-progress>...</mavis-progress>` block. Use this instead of
 * `MAVIS_PROGRESS_BLOCK_RE.test(content)` — the exported regex is global
 * (`g` flag) so `.test()` mutates `lastIndex`, which silently flips results
 * on subsequent calls and forces every caller to remember a manual
 * `MAVIS_PROGRESS_BLOCK_RE.lastIndex = 0` reset.
 *
 * Implementation note: `String.prototype.match` against a global regex does
 * NOT set `lastIndex` on the regex (unlike `RegExp.prototype.test` /
 * `.exec`), so it is safe to share the global regex across callers.
 */
export function containsMavisProgressBlock(content: string): boolean {
  if (!content) return false;
  return content.match(MAVIS_PROGRESS_BLOCK_RE) !== null;
}

/** Twin of `containsMavisProgressBlock` for `<mavis-thinking>` blocks. */
export function containsMavisThinkingBlock(content: string): boolean {
  if (!content) return false;
  return content.match(MAVIS_THINKING_BLOCK_RE) !== null;
}

/**
 * Innermost `<mavis-X>...</mavis-X>` pair: matches a *non-nested* block whose
 * inner content contains NO further `<mavis-*` opener. Use this in a
 * fixed-point loop (innermost first, peel outward) so the outer closing
 * tag is consumed as part of its own pair rather than left as a stray
 * XML fragment on IM. The back-reference enforces same-name opening and
 * closing; the negative lookahead enforces "no inner opener of the same
 * family" so the match is the innermost layer.
 *
 * Case-insensitive (`i`), global (`g`), unicode (`u`).
 */
export const MAVIS_INNERMOST_PAIRED_BLOCK_RE =
  /<mavis-([a-z][a-z0-9-]*)\b[^>]*>((?:(?!<mavis-[a-z][a-z0-9-]*\b)[\s\S])*?)<\/mavis-\1\s*>/giu;

/**
 * Strip **every** paired `<mavis-*>...</mavis-*>` block (tag + inner content)
 * and trim. Use this as the IM-outbound sanitizer: every system tag family
 * goes away, the same way on every platform.
 *
 * Replaces the previous hand-rolled "strip thinking entirely, then replace
 * progress with a single space" two-step with a single all-tags-in-one
 * operation. Progress inner text is dropped on IM (the in-app chat panel
 * still unwraps it for the visible-but-quiet surface — see
 * `stripMavisProgressTags`), because IM pushes have no equivalent quiet
 * surface and a heartbeat should never fire a notification. See
 * `channel-forwarder.ts::stripOwnerStatusTagsForIm` for the original
 * proactive-IM policy this consolidates.
 *
 * Nested blocks (e.g. `<mavis-thinking>…<mavis-progress>…</mavis-progress></mavis-thinking>`)
 * are peeled innermost-first via a fixed-point loop. Single-pass non-greedy
 * stops at the first `</mavis-*>` and leaves the outer closing tag
 * stranded on IM — the iteration guarantees every layer is consumed
 * (Codex P2 on MR !3251).
 */
export function stripMavisTagsForIm(content: string): string {
  if (!content) return '';
  let previous = content;
  let next = content.replace(MAVIS_INNERMOST_PAIRED_BLOCK_RE, '');
  while (next !== previous) {
    previous = next;
    next = next.replace(MAVIS_INNERMOST_PAIRED_BLOCK_RE, '');
  }
  return next.trim();
}

/**
 * Side-effect-free detection for *any* paired `<mavis-*>...</mavis-*>` block.
 * Use this instead of `MAVIS_INNERMOST_PAIRED_BLOCK_RE.test(content)` — the
 * global regex would otherwise mutate `lastIndex` and silently flip
 * subsequent calls. `.match()` against a global regex does not touch
 * `lastIndex`.
 */
export function containsMavisPairedBlock(content: string): boolean {
  if (!content) return false;
  return content.match(MAVIS_INNERMOST_PAIRED_BLOCK_RE) !== null;
}
