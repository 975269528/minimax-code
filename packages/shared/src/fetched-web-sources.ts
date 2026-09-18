import type { ContextualWebCitation } from './markdown-source-citation.js';

const MAX_DOCUMENT_CHARS = 2_000_000;
const MAX_DOCUMENT_SOURCES = 100;

/**
 * Read source metadata from a fetched document, not arbitrary outbound links.
 * Search hits are supported only for the known DuckDuckGo HTML result markup.
 * Keeping this pure lets persisted messages and both runtime hosts use the same evidence.
 */
export function collectFetchedWebSources(
  source: ContextualWebCitation,
  content: unknown,
): ContextualWebCitation[] {
  const pageUrl = httpUrl(source.url);
  if (!pageUrl) return [];
  const html = documentText(content)
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, '');
  const head = html.split(/<body\b/iu, 1)[0]?.slice(0, 65_536) ?? '';
  const title = /<title\b[^>]*>([^<]*)<\/title\s*>/iu.exec(head)?.[1];
  const name = title ? decodeHtml(title).trim() : source.name;
  let canonical: string | undefined;
  let favicon = source.favicon;
  for (const match of head.matchAll(/<link\b[^>]*>/giu)) {
    const attrs = attributes(match[0]);
    const rel = attrs.rel?.toLowerCase().split(/\s+/u) ?? [];
    if (rel.includes('canonical')) canonical ??= httpUrl(attrs.href, pageUrl);
    if (rel.includes('icon') && !attrs.mask) favicon ??= httpUrl(attrs.href, pageUrl);
  }
  const primary = { ...source, ...(favicon ? { favicon } : {}) };
  const output: ContextualWebCitation[] = [primary];
  if (canonical && canonical !== pageUrl) output.push({ ...primary, name, url: canonical });

  // Baike's /item/<title> route is its named alias. Older externalized fetches
  // retain the official document title but not the HTML head. Do not infer
  // aliases from answer labels, domains alone, or an arbitrary numeric ID.
  const baikeAlias = baikeTitleUrl(pageUrl, name);
  if (baikeAlias) output.push({ ...primary, name, url: baikeAlias });
  collectDuckDuckGoResults(pageUrl, html, output);
  const unique = new Map<string, ContextualWebCitation>();
  for (const entry of output) {
    if (!unique.has(entry.url)) unique.set(entry.url, entry);
  }
  return Array.from(unique.values());
}

function documentText(content: unknown, depth = 0): string {
  if (depth > 8) return '';
  if (typeof content === 'string') return content.slice(0, MAX_DOCUMENT_CHARS);
  if (Array.isArray(content)) {
    let text = '';
    for (const entry of content) {
      text += documentText(entry, depth + 1).slice(0, MAX_DOCUMENT_CHARS - text.length);
      if (text.length >= MAX_DOCUMENT_CHARS) break;
    }
    return text;
  }
  if (!content || typeof content !== 'object') return '';
  const record = content as Record<string, unknown>;
  return documentText(record.content ?? record.text ?? record.output, depth + 1);
}

function httpUrl(value: string | undefined, base?: string): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value, base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch {
    return undefined;
  }
}

function decodeHtml(value: string): string {
  const entities: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/giu, (raw, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? raw;
    const hex = entity[1]?.toLowerCase() === 'x';
    const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : raw;
  });
}

function attributes(tag: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu)) {
    const key = match[1]?.toLowerCase();
    if (key) output[key] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return output;
}

function baikeTitleUrl(pageUrl: string, title: string): string | undefined {
  const url = new URL(pageUrl);
  if (url.hostname !== 'baike.baidu.com' || !/^\/item\/[^/]+\/?$/u.test(url.pathname)) {
    return undefined;
  }
  const name = /^(.{1,120})_百度百科$/u.exec(title)?.[1]?.trim();
  if (!name || /[/?#]/u.test(name)) return undefined;
  return `${url.origin}/item/${encodeURIComponent(name)}`;
}

function collectDuckDuckGoResults(
  pageUrl: string,
  html: string,
  output: ContextualWebCitation[],
): void {
  const page = new URL(pageUrl);
  if (
    !['duckduckgo.com', 'html.duckduckgo.com'].includes(page.hostname) ||
    !/^\/html\/?$/u.test(page.pathname)
  ) {
    return;
  }
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/giu)) {
    if (output.length >= MAX_DOCUMENT_SOURCES) break;
    const attrs = attributes(match[1] ?? '');
    if (!attrs.class?.split(/\s+/u).includes('result__a')) continue;
    let url = httpUrl(attrs.href, pageUrl);
    if (!url) continue;
    const link = new URL(url);
    if (['duckduckgo.com', 'html.duckduckgo.com'].includes(link.hostname)) {
      if (link.pathname !== '/l/') continue;
      url = httpUrl(link.searchParams.get('uddg') ?? undefined);
    }
    const name = decodeHtml((match[2] ?? '').replace(/<[^>]*>/gu, '')).trim();
    if (url && name) output.push({ url, name, evidence: name });
  }
}
