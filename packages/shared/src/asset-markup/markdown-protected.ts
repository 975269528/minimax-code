/**
 * Markdown protected-range helpers (fenced/inline code spans).
 *
 * Moved verbatim from the UI's `utils/markdown-protected.ts` so the shared
 * asset-markup parser and local-runtime can mask code ranges without a UI
 * dependency. The UI module re-exports from here; do not fork another copy.
 */
export type MarkdownProtectedSegment =
  | { type: 'text'; content: string }
  | { type: 'protected'; content: string };

export interface MarkdownProtectedRange {
  start: number;
  end: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mayContainProtectedMarkdown(markdown: string): boolean {
  return markdown.includes('`') || markdown.includes('~~~');
}

function replaceNative(
  markdown: string,
  pattern: RegExp,
  replacement: string | ((match: string, ...args: unknown[]) => string),
): string {
  if (typeof replacement === 'function') {
    return markdown.replace(pattern, (match: string, ...args: unknown[]) =>
      replacement(match, ...args),
    );
  }
  return markdown.replace(pattern, replacement);
}

function mergeRanges(ranges: MarkdownProtectedRange[]): MarkdownProtectedRange[] {
  if (ranges.length <= 1) return ranges;
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MarkdownProtectedRange[] = [];

  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
  }

  return merged;
}

function findFencedCodeRanges(markdown: string): MarkdownProtectedRange[] {
  const ranges: MarkdownProtectedRange[] = [];
  let lineStart = 0;

  while (lineStart < markdown.length) {
    const newlineIndex = markdown.indexOf('\n', lineStart);
    const lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex;
    const lineEndWithNewline = newlineIndex === -1 ? markdown.length : newlineIndex + 1;
    const line = markdown.slice(lineStart, lineEnd);
    const opener = /^( {0,3})(`{3,}|~{3,})/.exec(line);

    if (!opener) {
      lineStart = lineEndWithNewline;
      continue;
    }

    const marker = opener[2] ?? '';
    const fenceChar = marker[0] ?? '';
    if (!marker || !fenceChar) {
      lineStart = lineEndWithNewline;
      continue;
    }
    const minFenceLength = marker.length;
    const closeRe = new RegExp(`^ {0,3}${escapeRegExp(fenceChar)}{${minFenceLength},}\\s*$`);
    let scanStart = lineEndWithNewline;
    let rangeEnd = markdown.length;

    while (scanStart < markdown.length) {
      const scanNewlineIndex = markdown.indexOf('\n', scanStart);
      const scanLineEnd = scanNewlineIndex === -1 ? markdown.length : scanNewlineIndex;
      const scanLineEndWithNewline =
        scanNewlineIndex === -1 ? markdown.length : scanNewlineIndex + 1;
      const scanLine = markdown.slice(scanStart, scanLineEnd);

      if (closeRe.test(scanLine)) {
        rangeEnd = scanLineEndWithNewline;
        break;
      }

      scanStart = scanLineEndWithNewline;
    }

    ranges.push({ start: lineStart, end: rangeEnd });
    lineStart = rangeEnd;
  }

  return ranges;
}

function findInlineCodeRanges(
  markdown: string,
  fencedRanges: MarkdownProtectedRange[],
): MarkdownProtectedRange[] {
  const ranges: MarkdownProtectedRange[] = [];
  let cursor = 0;

  const scanText = (start: number, end: number): void => {
    let index = start;
    while (index < end) {
      if (markdown[index] !== '`') {
        index += 1;
        continue;
      }

      const markerStart = index;
      let markerEnd = index + 1;
      while (markerEnd < end && markdown[markerEnd] === '`') {
        markerEnd += 1;
      }

      const marker = markdown.slice(markerStart, markerEnd);
      const closeIndex = markdown.indexOf(marker, markerEnd);
      if (closeIndex === -1 || closeIndex >= end) {
        index = markerEnd;
        continue;
      }

      ranges.push({ start: markerStart, end: closeIndex + marker.length });
      index = closeIndex + marker.length;
    }
  };

  for (const range of fencedRanges) {
    if (cursor < range.start) {
      scanText(cursor, range.start);
    }
    cursor = Math.max(cursor, range.end);
  }

  if (cursor < markdown.length) {
    scanText(cursor, markdown.length);
  }

  return ranges;
}

export function findMarkdownProtectedRanges(markdown: string): MarkdownProtectedRange[] {
  if (!mayContainProtectedMarkdown(markdown)) return [];

  const fencedRanges = findFencedCodeRanges(markdown);
  const inlineRanges = findInlineCodeRanges(markdown, fencedRanges);
  return mergeRanges([...fencedRanges, ...inlineRanges]);
}

export function isIndexInMarkdownProtectedRange(
  index: number,
  ranges: readonly MarkdownProtectedRange[],
): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function getReplaceOffset(args: unknown[]): number | null {
  const lastArg = args.at(-1);
  const offsetArg = lastArg !== null && typeof lastArg === 'object' ? args.at(-3) : args.at(-2);
  return typeof offsetArg === 'number' ? offsetArg : null;
}

export function replaceMarkdownOutsideProtected(
  markdown: string,
  pattern: RegExp,
  replacement: string | ((match: string, ...args: unknown[]) => string),
): string {
  pattern.lastIndex = 0;
  const hasMatch = pattern.test(markdown);
  pattern.lastIndex = 0;
  if (!hasMatch) return markdown;

  if (!mayContainProtectedMarkdown(markdown)) {
    return replaceNative(markdown, pattern, replacement);
  }

  const ranges = findMarkdownProtectedRanges(markdown);
  if (ranges.length === 0) {
    return replaceNative(markdown, pattern, replacement);
  }

  return markdown.replace(pattern, (match: string, ...args: unknown[]) => {
    const offset = getReplaceOffset(args);
    if (offset !== null && isIndexInMarkdownProtectedRange(offset, ranges)) {
      return match;
    }
    return typeof replacement === 'function' ? replacement(match, ...args) : replacement;
  });
}

export function splitMarkdownProtectedSegments(markdown: string): MarkdownProtectedSegment[] {
  if (!markdown) return [{ type: 'text', content: markdown }];
  if (!mayContainProtectedMarkdown(markdown)) return [{ type: 'text', content: markdown }];

  const ranges = findMarkdownProtectedRanges(markdown);
  if (ranges.length === 0) return [{ type: 'text', content: markdown }];

  const segments: MarkdownProtectedSegment[] = [];
  let cursor = 0;

  for (const range of ranges) {
    if (cursor < range.start) {
      segments.push({ type: 'text', content: markdown.slice(cursor, range.start) });
    }
    segments.push({ type: 'protected', content: markdown.slice(range.start, range.end) });
    cursor = range.end;
  }

  if (cursor < markdown.length) {
    segments.push({ type: 'text', content: markdown.slice(cursor) });
  }

  return segments.length > 0 ? segments : [{ type: 'text', content: markdown }];
}

export function mapMarkdownOutsideProtected(
  markdown: string,
  transform: (content: string) => string,
): string {
  if (!mayContainProtectedMarkdown(markdown)) return transform(markdown);

  return splitMarkdownProtectedSegments(markdown)
    .map((segment) => (segment.type === 'protected' ? segment.content : transform(segment.content)))
    .join('');
}
