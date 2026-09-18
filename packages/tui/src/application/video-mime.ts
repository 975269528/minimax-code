import { extname } from 'node:path';

const NATIVE_VIDEO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};

export function inferTuiNativeVideoMimeType(fileName: string): string | undefined {
  return NATIVE_VIDEO_MIME_BY_EXTENSION[extname(fileName).toLowerCase()];
}
