import { DEFAULT_BOT_NAME, makeHeader } from './feishu-card-header.js';

/**
 * Reply + transient thinking cards for Feishu / Lark, matching the historical
 * `feat/im-genui-full-mr` (`im-slice-all`) shape:
 *
 *   - {@link buildReplyCard} — the final green "Reply" card the outbound client
 *     sends (or PATCHes the grey thinking card into).
 *   - {@link buildThinkingCard} — the transient grey "🤔 Thinking…" card the
 *     Feishu WS dispatcher renders immediately on inbound so the user sees
 *     "message received" feedback before the agent finishes its turn.
 *   - {@link parseReplyTextToElements} — port of the historical
 *     `parseTextToElements`, which splits markdown `![](img_vN_xxx)` images
 *     into their own `img` element and strips outbound markdown image URLs
 *     (Feishu cards cannot render URL images inline).
 *
 * Kept in its own file so `feishu-card.ts` stays under the 500-line layout
 * budget. No SDK / `axios` import here — pure data builders.
 */

/** Match an `img_v2_xxx` / `img_v3_xxx` Feishu image key (allowed inside `![]()`). */
const FEISHU_IMAGE_KEY_RE = /^img_v\d+_[A-Za-z0-9_-]+$/u;

/**
 * Parse a reply text body into a Feishu Card 2.0 element list. `![alt](url)`
 * markdown images are turned into stand-alone `img` elements when the URL is
 * a Feishu `image_key` and dropped entirely when it is an outbound URL
 * (Feishu cards cannot render outbound URLs inline). Everything else
 * collapses into a single `markdown` element.
 *
 * Returns at least one element — an empty body would render as an awkward
 * blank card.
 */
export function parseReplyTextToElements(text: string): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [];
  const markdownImageRe = /!\[([^\]]*)\]\(([^)]+)\)/gu;
  let cursor = 0;
  let match: RegExpExecArray | null;
  const cleaned = text.replace(markdownImageRe, (raw, _alt, url) => {
    if (typeof url === 'string' && FEISHU_IMAGE_KEY_RE.test(url)) return raw;
    return '';
  });
  markdownImageRe.lastIndex = 0;
  while ((match = markdownImageRe.exec(cleaned)) !== null) {
    const url = match[2] ?? '';
    if (!FEISHU_IMAGE_KEY_RE.test(url)) continue;
    const before = cleaned.slice(cursor, match.index).trim();
    if (before) elements.push({ tag: 'markdown', content: before });
    elements.push({
      tag: 'img',
      img_key: url,
      alt: { tag: 'plain_text', content: match[1] ?? '' },
    });
    cursor = match.index + match[0].length;
  }
  const tail = cleaned.slice(cursor).trim();
  if (tail) elements.push({ tag: 'markdown', content: tail });
  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: text.trim() || ' ' });
  }
  return elements;
}

/**
 * Build the transient grey "🤔 Thinking…" card the WS layer renders on inbound.
 * `update_multi: true` is required so the outbound client can PATCH this
 * card into the final green reply — Feishu silently no-ops PATCH calls on
 * cards that don't declare update_multi.
 *
 * Deliberately omits `header.icon`: `thinking_outlined` is not part of the
 * `standard_icon` set on every tenant / custom-app scope, so when the SDK
 * cannot resolve the token it falls back to a broken-code glyph next to the
 * bot avatar. The other three cards (reply / questionnaire / submitted) use
 * well-known tokens (`chat_outlined`, `succeed_outlined`) and keep theirs.
 */
export function buildThinkingCard(botName: string = DEFAULT_BOT_NAME): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: makeHeader({
      title: botName,
      template: 'grey',
      tagText: '处理中',
      tagColor: 'grey',
    }),
    body: {
      direction: 'vertical',
      elements: [{ tag: 'markdown', content: '🤔 思考中…' }],
    },
  };
}

/**
 * Build the final green "Reply" reply card — header `template: 'green'`,
 * `icon: 'chat_outlined'`, `text_tag_list: [{ text: 'Reply', color: 'green' }]`,
 * `title: <botName>`, body from {@link parseReplyTextToElements}.
 *
 * `update_multi: true` is set so the card can be further patched if needed
 * (consistent with the thinking-card morph contract).
 */
export function buildReplyCard(
  text: string,
  options: {
    botName?: string;
    title?: string;
    template?: string;
    tagText?: string;
    tagColor?: string;
  } = {},
): Record<string, unknown> {
  const botName = options.botName ?? DEFAULT_BOT_NAME;
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: makeHeader({
      title: options.title ?? botName,
      template: options.template ?? 'green',
      icon: 'chat_outlined',
      tagText: options.tagText ?? '回复',
      tagColor: options.tagColor ?? 'green',
    }),
    body: {
      direction: 'vertical',
      elements: parseReplyTextToElements(text),
    },
  };
}
