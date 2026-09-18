import { extname } from 'node:path';

const SUPPORTED_NATIVE_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

interface NativeImageMimeAttachment {
  type?: string;
  filePath?: string;
  fileName?: string;
  mimeType?: string;
  dataUrl?: string;
}

/** Model-sendable native image mimes. Non-native `image/*` (svg/bmp/tiff/...) demote to text. */
export function isSupportedNativeImageMime(mime: string | undefined): boolean {
  return normalizeSupportedNativeImageMime(mime) !== undefined;
}

export function normalizeSupportedNativeImageMime(mime: string | undefined): string | undefined {
  const normalized = mime?.split(';', 1)[0]?.trim().toLowerCase();
  if (!normalized) return undefined;
  const canonical = normalized === 'image/jpg' ? 'image/jpeg' : normalized;
  return SUPPORTED_NATIVE_IMAGE_MIME_TYPES.has(canonical) ? canonical : undefined;
}

export function resolveNativeImageMime(attachment: NativeImageMimeAttachment): string | undefined {
  const explicitMime = normalizeSupportedNativeImageMime(attachment.mimeType);
  if (explicitMime) return explicitMime;

  const dataUrlMime = normalizeSupportedNativeImageMime(mimeFromDataUrl(attachment.dataUrl));
  if (dataUrlMime) return dataUrlMime;
  if (attachment.type !== 'image') return undefined;
  return nativeMimeFromPath(attachment.fileName) ?? nativeMimeFromPath(attachment.filePath);
}

function nativeMimeFromPath(filePath: string | undefined): string | undefined {
  const ext = extname(filePath ?? '').toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif' || ext === '.webp') return `image/${ext.slice(1)}`;
  return undefined;
}

function mimeFromDataUrl(dataUrl: string | undefined): string | undefined {
  return /^data:([^,;]*)[;,]/s.exec(dataUrl ?? '')?.[1];
}
