/**
 * data: URL helpers. Moved verbatim from the UI's `utils/data-url.ts` so the
 * shared asset-markup parser can classify media sources without a UI
 * dependency. The UI module re-exports from here; do not fork another copy.
 */
export function isDataUrl(value: string): boolean {
  return value.trim().startsWith('data:');
}

function decodeBase64Utf8(value: string): string {
  if (typeof globalThis.atob !== 'function') {
    throw new Error('Base64 decoding is not available in this environment.');
  }

  const binary = globalThis.atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function parseDataUrlSource(value: string): { mimeType: string; content: string } | null {
  if (!isDataUrl(value)) {
    return null;
  }

  const commaIndex = value.indexOf(',');
  if (commaIndex < 0) {
    return null;
  }

  const metadata = value.slice(5, commaIndex);
  const payload = value.slice(commaIndex + 1);
  const isBase64 = metadata.endsWith(';base64');
  const mimeType = (isBase64 ? metadata.slice(0, -7) : metadata).split(';')[0] || 'text/plain';

  if (mimeType.startsWith('image/')) {
    return { mimeType, content: value };
  }

  try {
    return {
      mimeType,
      content: isBase64 ? decodeBase64Utf8(payload) : decodeURIComponent(payload),
    };
  } catch {
    return null;
  }
}
