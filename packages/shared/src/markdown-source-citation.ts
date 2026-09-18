export interface ContextualWebCitation {
  readonly name: string;
  readonly url: string;
  readonly favicon?: string;
  readonly evidence?: string;
}

const MAX_EVIDENCE_CHARS = 200_000;
const MAX_SOURCE_PARSE_DEPTH = 8;
const MAX_COLLECTED_SOURCES = 100;
const SOURCE_SCALAR_KEYS = new Set([
  'url',
  'href',
  'link',
  'source_url',
  'sourceUrl',
  'favicon',
  'favicon_url',
  'faviconUrl',
  'site_icon',
  'siteIcon',
  'icon',
]);

/**
 * Extracts WebSearch-style source records from nested/JSON-string tool output.
 * It intentionally only recognizes explicit HTTP(S) fields, so page text that
 * merely mentions a URL does not become provenance by accident.
 */
export function collectWebSourceCitations(
  value: unknown,
  options: { includeText?: boolean; requireSourceMetadata?: boolean } = {},
): ContextualWebCitation[] {
  const output: ContextualWebCitation[] = [];
  collectWebSourceCitationsInto(value, output, new Set(), 0, options);
  const deduped = new Map<string, ContextualWebCitation>();
  output.forEach((citation) => {
    if (!deduped.has(citation.url)) deduped.set(citation.url, citation);
  });
  return Array.from(deduped.values());
}

function collectWebSourceCitationsInto(
  value: unknown,
  output: ContextualWebCitation[],
  visited: Set<object>,
  depth: number,
  options: { includeText?: boolean; requireSourceMetadata?: boolean },
): void {
  if (depth > MAX_SOURCE_PARSE_DEPTH || output.length >= MAX_COLLECTED_SOURCES) return;
  const parsed = parseJsonValue(value);
  if (typeof parsed === 'string') {
    if (options.includeText !== false) collectTextWebCitations(parsed, output);
    return;
  }
  if (Array.isArray(parsed)) {
    if (visited.has(parsed)) return;
    visited.add(parsed);
    parsed.forEach((entry) =>
      collectWebSourceCitationsInto(entry, output, visited, depth + 1, options),
    );
    return;
  }
  const record = readRecord(parsed);
  if (!record || visited.has(record)) return;
  visited.add(record);

  const url = safeHttpUrl(
    readString(record.url) ??
      readString(record.href) ??
      readString(record.link) ??
      readString(record.source_url) ??
      readString(record.sourceUrl),
  );
  const sourceMetadata =
    readString(record.title) ??
    readString(record.page_title) ??
    readString(record.pageTitle) ??
    readString(record.snippet) ??
    readString(record.description) ??
    readString(record.summary) ??
    readString(record.text);
  if (url && (!options.requireSourceMetadata || sourceMetadata)) {
    const name = preferredWebSourceName(
      url,
      [
        readString(record.title),
        readString(record.page_title),
        readString(record.pageTitle),
        readString(record.name),
        readString(record.label),
      ],
      [readWebDocumentTitle(record.content), readWebDocumentTitle(record.text)],
    );
    const evidence = [
      name,
      readString(record.snippet),
      readString(record.description),
      readString(record.summary),
      readString(record.text),
      readString(record.content)
        ?.split(/(?:^|\n)\[(?:附加字段|additional fields?)[^\]]*\]/iu, 1)[0]
        ?.trim(),
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join('\n')
      .slice(0, MAX_EVIDENCE_CHARS);
    const supplementalMetadata = parseSupplementalMetadata(record.content);
    const favicon = safeHttpUrl(
      readString(record.favicon) ??
        readString(record.favicon_url) ??
        readString(record.faviconUrl) ??
        readString(record.site_icon) ??
        readString(record.siteIcon) ??
        readString(record.icon) ??
        readString(supplementalMetadata?.favicon) ??
        readString(supplementalMetadata?.favicon_url) ??
        readString(supplementalMetadata?.faviconUrl) ??
        readString(supplementalMetadata?.site_icon) ??
        readString(supplementalMetadata?.siteIcon) ??
        readString(supplementalMetadata?.icon),
    );
    output.push({
      name,
      url,
      ...(favicon ? { favicon } : {}),
      ...(evidence ? { evidence } : {}),
    });
    // A structured WebSearch result is a provenance leaf. Its `content` may
    // contain the fetched page body, including navigation and recommendation
    // links that were never returned as search results. Recursing into that
    // body would incorrectly offer those outbound links as citation targets.
    return;
  }

  Object.entries(record).forEach(([key, entry]) => {
    if (!SOURCE_SCALAR_KEYS.has(key)) {
      collectWebSourceCitationsInto(entry, output, visited, depth + 1, options);
    }
  });
}

/**
 * Connector WebSearch implementations may serialize results as Markdown or
 * line-oriented text instead of a JSON object. This parser is intentionally
 * reached only after the caller has classified the ToolResult as WebSearch,
 * so explicit links in that result are source candidates rather than arbitrary
 * URLs found in a page body.
 */
function collectTextWebCitations(value: string, output: ContextualWebCitation[]): void {
  if (!value.trim() || value.length > MAX_EVIDENCE_CHARS) return;
  const occupied = new Set<string>();
  for (const match of value.matchAll(
    /(?<!!)\[([^\]\n]+)\]\(\s*(https?:\/\/[^\s<>"')\]，。；：！？]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/giu,
  )) {
    const url = safeHttpUrl(match[2]);
    if (!url) continue;
    occupied.add(url);
    const label = match[1]?.trim();
    output.push({
      name: label && !isFallbackWebSourceTitle(label, url) ? label : url,
      url,
      evidence: evidenceLine(value, match.index ?? 0),
    });
  }
  for (const match of value.matchAll(/https?:\/\/[^\s<>"')\]，。；：！？]+/giu)) {
    const url = safeHttpUrl(match[0]);
    const line = evidenceLine(value, match.index ?? 0);
    if (
      !url ||
      occupied.has(url) ||
      /["']?(?:favicon(?:_url|Url)?|site_(?:icon)|siteIcon|icon)["']?\s*:/iu.test(line)
    ) {
      continue;
    }
    output.push({
      name: url,
      url,
      evidence: line,
    });
  }
}

function readWebDocumentTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const htmlTitle = /<title[^>]*>\s*([^<]{2,120})\s*<\/title>/iu.exec(value)?.[1]?.trim();
  if (htmlTitle) return htmlTitle;
  return /^#{1,2}\s+(.{2,120})$/mu.exec(value)?.[1]?.trim();
}

function preferredWebSourceName(
  url: string,
  semanticTitles: readonly (string | undefined)[],
  documentTitles: readonly (string | undefined)[],
): string {
  return (
    [...semanticTitles, ...documentTitles].find(
      (title): title is string =>
        typeof title === 'string' && !isFallbackWebSourceTitle(title, url),
    ) ?? url
  );
}

function isFallbackWebSourceTitle(title: string, url: string): boolean {
  if (safeHttpUrl(title) === url) return true;
  const hostname = new URL(url).hostname.toLowerCase();
  const normalizedTitle = title
    .toLowerCase()
    .replace(/^https?:\/\//u, '')
    .replace(/\/$/u, '');
  return normalizedTitle === hostname || normalizedTitle === hostname.replace(/^www\./u, '');
}

function evidenceLine(value: string, index: number): string {
  const start = value.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const endIndex = value.indexOf('\n', index);
  const end = endIndex < 0 ? value.length : endIndex;
  return value.slice(start, end).trim().slice(0, 500);
}

function parseSupplementalMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.length > MAX_EVIDENCE_CHARS) return undefined;
  const matches = Array.from(
    value.matchAll(/(?:^|\n)\[(?:附加字段|additional fields?)[^\]]*\]\s*/giu),
  );
  const marker = matches.at(-1);
  if (marker?.index === undefined) return undefined;
  return readRecord(parseJsonValue(value.slice(marker.index + marker[0].length)));
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_EVIDENCE_CHARS ||
    (!trimmed.startsWith('{') && !trimmed.startsWith('['))
  ) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
