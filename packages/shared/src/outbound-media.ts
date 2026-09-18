/**
 * Shared outbound-media contract + parser.
 *
 * The agent emits media as free-text tags inside its reply:
 *
 *   - self-closing  `<media src="/abs/path" type? name? caption? />`
 *   - wrapper       `<deliver-assets><item><path>..</path><name>..</name>
 *                     <type>..</type></item>...</deliver-assets>`
 *                   (also the underscore spelling `<deliver_assets>`, and
 *                   sometimes a misspelled closing child tag such as
 *                   `<path>report.html</name>`)
 *
 * It NEVER emits mime / mimeType / size, and `type` is frequently absent, so
 * `kind` and `mimeType` are INFERRED on our side (see `media-asset-meta.ts`).
 *
 * This parser deliberately MIRRORS the UI parser in
 * `packages/ui/src/components/message/DeliverAssetsCard.tsx` (same regexes,
 * same tolerant child reading) so the IM outbound surface and the UI card can
 * never drift on what counts as a media tag. The difference is the output
 * shape: the UI builds render segments, whereas this returns a flat list of
 * `OutboundMediaRef` plus the text with every matched tag removed — exactly
 * what an IM outbound sender needs (caption text + a list of files to upload).
 *
 * This is the strict, structured path. The existing `placeholderMediaTags`
 * (see `im-text-sanitize.ts`) stays as the failure fallback for surfaces that
 * cannot deliver media out-of-band; it is intentionally left untouched.
 *
 * MUST NOT import from `@mavis/ui` (package-cycle direction is ui → shared).
 */

import { normalizeNestedFilePathMediaSources } from './asset-markup/deliver-assets.js';
import { deriveMediaKind, inferAssetMimeType, type OutboundMediaKind } from './media-asset-meta.js';

export type OutboundMediaNameSource = 'explicit' | 'caption' | 'path';

/**
 * A single piece of media the agent asked to deliver. Mirrors what the UI
 * parser extracts, minus the UI-only fields (downloadUrl/previewUrl/etc.).
 */
export interface OutboundMediaRef {
  /** `src` from `<media>`, or `<path>` / `<artifact_id>` from an `<item>`. */
  path: string;
  /** Coarse transport kind, derived. */
  kind: OutboundMediaKind;
  /** Free-form `type`, exactly as the agent emitted it (may be absent). */
  type?: string;
  /** name attr / `<name>` child / caption fallback / basename(path). */
  name?: string;
  /** Which source produced `name`; additive metadata for transport-specific rules. */
  nameSource?: OutboundMediaNameSource;
  /** Inferred via `inferAssetMimeType` when the agent omitted it. */
  mimeType?: string;
  /** `caption` attribute (self-closing `<media>` only). */
  caption?: string;
  /** `<artifact_id>` child of an `<item>`, when present. */
  artifactId?: string;
}

// --- Regexes mirrored from DeliverAssetsCard.tsx (keep in lockstep) ---------
const DELIVER_ASSETS_RE = /<(deliver-assets|deliver_assets)\b[^>]*>([\s\S]*?)<\/\1>/g;
const ITEM_RE = /<item>([\s\S]*?)<\/item>/g;
const MEDIA_TAG_RE = /<media\s+([^>]*?)\/>/g;
const MEDIA_ATTR_RE = /(\w+)="([^"]*)"/g;

function decodeAssetMarkupText(value: string): string {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&apos;|&#39;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');
}

/**
 * Reduce a path/src to its basename: strip query/fragment, split on `/` or
 * `\`, take the last non-empty segment. Mirrors the intent of the UI's
 * `getPreviewFileName`, but kept local so `@mavis/shared` stays UI-free.
 */
function basename(path: string): string | undefined {
  const stripped = path.split('?')[0]?.split('#')[0] ?? '';
  const parts = stripped.split(/[\\/]/u);
  const last = parts[parts.length - 1]?.trim();
  return last || undefined;
}

/**
 * Read a child field out of an `<item>` body. Tolerant of a single mistyped
 * closing tag (e.g. `<path>report.html</name>`): recover the value up to the
 * next recognised card tag. Mirrors `readTagContent` in DeliverAssetsCard.tsx.
 */
function readTagContent(
  content: string,
  tagName: 'path' | 'artifact_id' | 'name' | 'type',
): string | null {
  const strictMatch = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'iu').exec(content);
  const strictValue = strictMatch?.[1]?.trim();
  if (strictValue) {
    return decodeAssetMarkupText(strictValue);
  }

  const tolerantMatch = new RegExp(
    `<${tagName}>([\\s\\S]*?)(?=<\\/?(?:path|artifact_id|name|type|item|deliver-assets|deliver_assets)\\b|$)`,
    'iu',
  ).exec(content);
  const value = tolerantMatch?.[1]?.trim();
  return value ? decodeAssetMarkupText(value) : null;
}

/** Finalize a partially-built ref: name fallback + mime/kind inference. */
function finalizeRef(ref: {
  path: string;
  type?: string;
  name?: string;
  caption?: string;
  artifactId?: string;
}): OutboundMediaRef {
  const explicitName = ref.name?.trim();
  const caption = ref.caption?.trim();
  const name = explicitName || caption || basename(ref.path);
  const nameSource: OutboundMediaNameSource | undefined = explicitName
    ? 'explicit'
    : caption
      ? 'caption'
      : name
        ? 'path'
        : undefined;
  const mimeType = inferAssetMimeType({ path: ref.path, name, type: ref.type });
  const kind = deriveMediaKind({
    type: ref.type,
    mimeType,
    name,
    path: ref.path,
  });

  return {
    path: ref.path,
    kind,
    ...(ref.type ? { type: ref.type } : {}),
    ...(name ? { name } : {}),
    ...(nameSource ? { nameSource } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(ref.caption ? { caption: ref.caption } : {}),
    ...(ref.artifactId ? { artifactId: ref.artifactId } : {}),
  };
}

/** Parse a self-closing `<media ... />` attribute string into a ref. */
function parseMediaAttrs(attrString: string): OutboundMediaRef | null {
  const attrs: Record<string, string> = {};
  MEDIA_ATTR_RE.lastIndex = 0;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = MEDIA_ATTR_RE.exec(attrString)) !== null) {
    const [, key, value] = attrMatch;
    if (key && value !== undefined) {
      attrs[key] = decodeAssetMarkupText(value);
    }
  }

  const src = attrs['src']?.trim();
  if (!src) {
    return null;
  }

  return finalizeRef({
    path: src,
    type: attrs['type']?.trim() || undefined,
    name: attrs['name']?.trim() || undefined,
    caption: attrs['caption']?.trim() || undefined,
  });
}

/** Parse the body of one `<item>...</item>` into a ref. */
function parseItemBody(itemBody: string): OutboundMediaRef | null {
  const artifactId = readTagContent(itemBody, 'artifact_id');
  const path = readTagContent(itemBody, 'path');
  if (!path && !artifactId) {
    return null;
  }

  return finalizeRef({
    path: path ?? artifactId ?? '',
    type: readTagContent(itemBody, 'type') ?? undefined,
    name: readTagContent(itemBody, 'name') ?? undefined,
    ...(artifactId ? { artifactId } : {}),
  });
}

/** Extract refs from one `<deliver-assets>` / `<deliver_assets>` body. */
function parseDeliverAssetsBody(body: string): OutboundMediaRef[] {
  const refs: OutboundMediaRef[] = [];
  const tokenRe = new RegExp(`${ITEM_RE.source}|${MEDIA_TAG_RE.source}`, 'g');
  tokenRe.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(body)) !== null) {
    const itemBody = match[1];
    const mediaAttrs = match[2];
    if (typeof mediaAttrs === 'string') {
      const ref = parseMediaAttrs(mediaAttrs);
      if (ref) {
        refs.push(ref);
      }
    } else if (typeof itemBody === 'string') {
      const ref = parseItemBody(itemBody);
      if (ref) {
        refs.push(ref);
      }
    }
  }

  return refs;
}

/** Collapse the whitespace left behind after removing tag spans. */
function cleanLeftoverText(text: string): string {
  return (
    text
      // Drop runs of 3+ newlines (with optional intervening spaces/tabs) down
      // to a single blank line so removed block tags don't leave big gaps.
      .replace(/[^\S\r\n]*\r?\n(?:[^\S\r\n]*\r?\n){2,}/gu, '\n\n')
      // Trim trailing spaces/tabs left on a line after a tag was cut out.
      .replace(/[^\S\r\n]+$/gmu, '')
      .trim()
  );
}

/**
 * Parse agent-emitted media tags out of `text`.
 *
 * Returns the cleaned `text` (every matched `<deliver-assets>` /
 * `<deliver_assets>` wrapper and standalone self-closing `<media />` removed,
 * leftover blank lines collapsed) plus the flat list of `OutboundMediaRef`.
 *
 * When the input contains no media tags, returns `{ text, media: [] }` with
 * `text` unchanged (not re-whitespaced).
 */
export function parseMediaTags(text: string): { text: string; media: OutboundMediaRef[] } {
  if (!text) {
    return { text, media: [] };
  }

  const normalizedText = normalizeNestedFilePathMediaSources(text);

  const media: OutboundMediaRef[] = [];
  // Combined token stream over wrappers and standalone self-closing media,
  // in document order, so we strip exactly the matched spans.
  const tokenRe = new RegExp(`${DELIVER_ASSETS_RE.source}|${MEDIA_TAG_RE.source}`, 'g');
  tokenRe.lastIndex = 0;

  let match: RegExpExecArray | null;
  let cursor = 0;
  let out = '';
  let matchedAny = false;

  while ((match = tokenRe.exec(normalizedText)) !== null) {
    matchedAny = true;
    out += normalizedText.slice(cursor, match.index);
    cursor = match.index + match[0].length;

    // Group layout: 1 = deliver wrapper tag name, 2 = wrapper body,
    // 3 = standalone media attrs.
    const wrapperBody = match[2];
    const mediaAttrs = match[3];
    if (typeof wrapperBody === 'string') {
      media.push(...parseDeliverAssetsBody(wrapperBody));
    } else if (typeof mediaAttrs === 'string') {
      const ref = parseMediaAttrs(mediaAttrs);
      if (ref) {
        media.push(ref);
      }
    }
  }

  if (!matchedAny) {
    return { text: normalizedText, media: [] };
  }

  out += normalizedText.slice(cursor);
  return { text: cleanLeftoverText(out), media };
}
