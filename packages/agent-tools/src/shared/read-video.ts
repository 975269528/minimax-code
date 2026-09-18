/**
 * Shared video inline-read helpers for the `read` tool.
 *
 * pi `createReadTool` natively inlines images (jpg/png/gif/webp) as
 * `{ type: 'image', data: <base64>, mimeType }` content. Video is not part
 * of pi's built-in detection because pi does not own the host's multimodal
 * capability declaration. Both `CloudReadTool` (sandbox executor) and
 * `LocalReadTool` (desktop executor) need to inline video bytes as pi-ai
 * `ImageContent` (`{ type: 'image', data: <base64>, mimeType: 'video/*' }`)
 * so videos ride pi-ai's existing multimodal image path. The runtime-level
 * provider video patchers then rewrite serialized provider image blocks
 * with `video/*` media into `type:'video'` at the provider payload boundary.
 *
 * Pulling that logic into a shared helper keeps cloud / local behaviour in
 * lock-step: caps semantics, error strings, and `details.media` shape are
 * the single source of truth here.
 */

import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import type { ToolResult } from '@mavis/agent-core/tools';
import { isSupportedNativeVideoMime } from './multimodal-attachments.js';

export interface ReadVideoCapabilities {
  readonly support_video?: unknown;
  readonly max_video_bytes_inline?: unknown;
  readonly max_request_body_bytes?: unknown;
}

// Extension -> MIME map for read-path inference. The supported-MIME allowlist
// lives in `multimodal-attachments.ts` and is shared with user attachments;
// keep this table as extension inference only.
const VIDEO_EXTENSIONS: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};

/** Empty string when the extension is not a recognised inline-video format. */
export function inferReadVideoMimeType(filePath: string): string {
  const mime = VIDEO_EXTENSIONS[extname(filePath).toLowerCase()] ?? '';
  return isSupportedNativeVideoMime(mime) ? mime : '';
}

export interface ReadVideoOptions {
  readonly toolName: string;
  readonly absolutePath: string;
  readonly mimeType: string;
  readonly capabilities: ReadVideoCapabilities | undefined;
  readonly signal?: AbortSignal;
}

/**
 * Read a video file and produce a `ToolResult` mirroring pi's image-read
 * shape. The caller must have already inferred the mime type via
 * `inferReadVideoMimeType` and resolved `absolutePath` to a host-validated
 * path. Throws on filesystem errors (matches the pre-extraction cloud
 * behaviour).
 */
export async function readVideoAsToolResult(opts: ReadVideoOptions): Promise<ToolResult> {
  if (opts.signal?.aborted) throw new Error('Operation aborted');
  const info = await stat(opts.absolutePath);
  if (opts.signal?.aborted) throw new Error('Operation aborted');

  const baseText = `Read video file [${opts.mimeType}]`;
  if (opts.capabilities?.support_video !== true) {
    return readVideoTextOnly(
      opts.toolName,
      `${baseText}\n[Current model does not support videos. The video will be omitted from this request.]`,
      opts.mimeType,
      info.size,
      'unsupported_model',
    );
  }

  const maxVideo = numberCap(opts.capabilities, 'max_video_bytes_inline');
  if (maxVideo > 0 && info.size > maxVideo) {
    return readVideoTextOnly(
      opts.toolName,
      `${baseText}\n[Video omitted: ${formatBytes(info.size)} exceeds max_video_bytes_inline=${formatBytes(maxVideo)}.]`,
      opts.mimeType,
      info.size,
      'max_video_bytes_inline',
    );
  }

  const maxBody = numberCap(opts.capabilities, 'max_request_body_bytes');
  const base64Size = Math.ceil(info.size / 3) * 4;
  if (maxBody > 0 && base64Size > maxBody) {
    return readVideoTextOnly(
      opts.toolName,
      `${baseText}\n[Video omitted: base64 payload ${formatBytes(base64Size)} exceeds max_request_body_bytes=${formatBytes(maxBody)}.]`,
      opts.mimeType,
      info.size,
      'max_request_body_bytes',
    );
  }

  const bytes = await readFile(opts.absolutePath);
  if (opts.signal?.aborted) throw new Error('Operation aborted');
  return {
    tool_name: opts.toolName,
    text: baseText,
    content: [
      { type: 'text', text: baseText },
      { type: 'image', data: bytes.toString('base64'), mimeType: opts.mimeType },
    ],
    details: {
      media: {
        kind: 'video',
        mime_type: opts.mimeType,
        size_bytes: info.size,
        inline: true,
      },
    },
  };
}

function readVideoTextOnly(
  toolName: string,
  text: string,
  mimeType: string,
  sizeBytes: number,
  reason: string,
): ToolResult {
  return {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
    details: {
      media: {
        kind: 'video',
        mime_type: mimeType,
        size_bytes: sizeBytes,
        inline: false,
        reason,
      },
    },
  };
}

function numberCap(
  capabilities: ReadVideoCapabilities | undefined,
  key: 'max_video_bytes_inline' | 'max_request_body_bytes',
): number {
  const value = capabilities?.[key];
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}
