const REVIEW_XML_ROOTS = new Set([
  'annotation-result',
  'review-candidate-corrections',
  'review-candidates',
]);

interface XmlTagBoundary {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
}

export function extractReviewCandidateText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!hasReviewCandidateMarker(trimmed)) return undefined;
  return extractSingleReviewXmlDocument(trimmed) ?? trimmed;
}

export function hasReviewCandidateDocumentMarker(text: string): boolean {
  return /<\s*(?:review-candidates|annotation-result)\b/iu.test(text);
}

/**
 * Extracts one model-authored review XML document while tolerating explanatory
 * prose and Markdown fences around it. Only complete documents participate in
 * ambiguity detection; zero or multiple complete documents stay on the strict
 * parser path so the normal retry/fallback behavior still applies.
 */
function extractSingleReviewXmlDocument(text: string): string | undefined {
  const documents = collectReviewRootTags(text).flatMap((root) => {
    const end = root.selfClosing ? root.end : findMatchingRootEnd(text, root);
    return end === undefined ? [] : [{ start: root.start, end }];
  });
  if (documents.length !== 1) return undefined;
  const document = documents[0];
  return document === undefined ? undefined : text.slice(document.start, document.end).trim();
}

function collectReviewRootTags(text: string): XmlTagBoundary[] {
  const roots: XmlTagBoundary[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const skipped = skipXmlOpaqueSection(text, cursor);
    if (skipped !== undefined) {
      cursor = skipped;
      continue;
    }
    if (text[cursor] !== '<') {
      cursor += 1;
      continue;
    }
    const tag = readXmlTagBoundary(text, cursor);
    if (!tag) {
      cursor += 1;
      continue;
    }
    if (!tag.closing && REVIEW_XML_ROOTS.has(tag.name)) roots.push(tag);
    cursor = tag.end;
  }
  return roots;
}

function findMatchingRootEnd(text: string, root: XmlTagBoundary): number | undefined {
  let depth = 1;
  let cursor = root.end;
  while (cursor < text.length) {
    const skipped = skipXmlOpaqueSection(text, cursor);
    if (skipped !== undefined) {
      cursor = skipped;
      continue;
    }
    if (text[cursor] !== '<') {
      cursor += 1;
      continue;
    }
    const tag = readXmlTagBoundary(text, cursor);
    if (!tag) {
      cursor += 1;
      continue;
    }
    if (tag.name === root.name) {
      if (tag.closing) depth -= 1;
      else if (!tag.selfClosing) depth += 1;
      if (depth === 0) return tag.end;
    }
    cursor = tag.end;
  }
  return undefined;
}

function skipXmlOpaqueSection(text: string, cursor: number): number | undefined {
  for (const [prefix, suffix] of [
    ['<!--', '-->'],
    ['<![CDATA[', ']]>'],
    ['<?', '?>'],
  ] as const) {
    if (!text.startsWith(prefix, cursor)) continue;
    const end = text.indexOf(suffix, cursor + prefix.length);
    return end < 0 ? text.length : end + suffix.length;
  }
  return undefined;
}

function readXmlTagBoundary(text: string, start: number): XmlTagBoundary | undefined {
  if (text[start] !== '<') return undefined;
  let cursor = start + 1;
  while (/\s/u.test(text[cursor] ?? '')) cursor += 1;
  const closing = text[cursor] === '/';
  if (closing) {
    cursor += 1;
    while (/\s/u.test(text[cursor] ?? '')) cursor += 1;
  }
  const nameStart = cursor;
  while (/[A-Za-z0-9_.:-]/u.test(text[cursor] ?? '')) cursor += 1;
  if (cursor === nameStart) return undefined;
  const name = text.slice(nameStart, cursor).toLowerCase();
  let quote: '"' | "'" | undefined;
  for (; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character !== '>') continue;
    let previous = cursor - 1;
    while (/\s/u.test(text[previous] ?? '')) previous -= 1;
    return {
      start,
      end: cursor + 1,
      name,
      closing,
      selfClosing: !closing && text[previous] === '/',
    };
  }
  return undefined;
}

function hasReviewCandidateMarker(text: string): boolean {
  return (
    hasReviewCandidateDocumentMarker(text) || /<\s*review-candidate-corrections\b/iu.test(text)
  );
}
