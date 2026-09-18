/**
 * AIGC Helpers — shared post-download register logic for matrix-tools
 * generation tools (image / video / audio).
 *
 * The 8 generation tools share the same shape:
 *   1. POST request to mcp via archon-server
 *   2. parse `success_items` (or single response)
 *   3. download the output file to workspace
 *   4. NEW: if the response carries `clean_oss_key`, call
 *      `AigcRegisterService.register()` and stamp the resulting
 *      drive node id into the session-scoped registry so the later
 *      deliver-assets rewrite reuses the registered node instead of
 *      re-uploading bytes.
 *
 * This module owns step 4 so each tool stays a one-liner.
 */

/**
 * Producer-version tag forwarded to archon-server. Lets the server
 * gate / report by mcp pipeline rev. Static for now — bump together
 * with the AIGC pipeline contract.
 */
const PRODUCER_VERSION = 'cloud-runtime/v5-aigc';

/**
 * Subset of the mcp ResultItem / response payload that carries the
 * watermark OSS keys. Fields are optional — the helper no-ops when
 * `clean_oss_key` is absent so old-server / failed-watermark cases
 * fall back to the legacy deliver-assets upload path automatically.
 */
export interface AigcOssKeys {
  clean_oss_key?: string;
  visible_oss_key?: string;
}

export interface MatrixAigcRegisterAssetInput {
  oss: AigcOssKeys;
  /** Absolute workspace path of the downloaded file (post-download). */
  absolutePath: string;
  /** Filename (basename) used for the drive node display name. */
  fileName: string;
  /** File size in bytes from the download step. */
  sizeBytes: number;
  /** MIME hint (e.g. `image/png`, `video/mp4`, `audio/mp3`). */
  mime: string;
  /** Tool's session id from {@link MatrixToolContext}. */
  sessionId: string;
  /** Tool name (`image_synthesize`, etc.) — surfaced as agent_name. */
  toolName: string;
  /** Producer-version tag forwarded to the host's register endpoint. */
  producerVersion: string;
}

export interface MatrixAigcRegistrar {
  registerDownloadedAsset(input: MatrixAigcRegisterAssetInput): Promise<void>;
}

export type MatrixAigcRegisterServiceGetter = () => MatrixAigcRegistrar | null;

/** Required call-site context. */
export interface RegisterAigcOpts {
  oss: AigcOssKeys;
  /** Absolute workspace path of the downloaded file (post-download). */
  absolutePath: string;
  /** Filename (basename) used for the drive node display name. */
  fileName: string;
  /** File size in bytes from the download step. */
  sizeBytes: number;
  /** MIME hint (e.g. `image/png`, `video/mp4`, `audio/mp3`). */
  mime: string;
  /** Tool's session id from {@link MatrixToolContext}. */
  sessionId: string;
  /** Tool name (`image_synthesize`, etc.) — surfaced as agent_name. */
  toolName: string;
  /** Lazy getter; null = service unavailable, helper is a no-op. */
  registerService: MatrixAigcRegistrar | null;
}

/**
 * Call archon-server `/api/v1/drive/aigc/register` for this asset and
 * stamp the resulting node_id into the session-scoped registry.
 *
 * No-ops (without throwing) when:
 *   - `registerService` is null (cloud-runtime hasn't bound identity
 *     yet, or driveUploadConfig is missing in this deployment)
 *   - `clean_oss_key` is empty (mcp didn't perform the AIGC pipeline,
 *     e.g. failed-watermark fallback or pre-v5 mcp deployment)
 *
 * Soft-skips (warn-and-continue) when:
 *   - archon-server returns 404 / 405 — the endpoint hasn't been
 *     deployed yet; the legacy deliver-assets upload path will run
 *     instead and the user gets the un-watermarked variant
 *   - register throws any other error (5xx / network / parse) — same
 *     fallback rationale; we never block the tool's success path on
 *     a register failure
 */
export async function registerAigcIfPresent(opts: RegisterAigcOpts): Promise<void> {
  const cleanKey = opts.oss.clean_oss_key;
  if (!cleanKey) return;
  if (!opts.registerService) return;
  try {
    await opts.registerService.registerDownloadedAsset({
      oss: opts.oss,
      absolutePath: opts.absolutePath,
      fileName: opts.fileName,
      sizeBytes: opts.sizeBytes,
      mime: opts.mime,
      sessionId: opts.sessionId,
      toolName: opts.toolName,
      producerVersion: PRODUCER_VERSION,
    });
  } catch (err) {
    // AIGC register is an optimization for downstream asset delivery. Tool
    // success must not depend on this side-channel.
    void err;
  }
}

/**
 * MIME inference for matrix-tools tool outputs. Mirrors
 * {@link inferUploadMimeType} for the subset of formats the generation
 * tools produce. Returns `'application/octet-stream'` as a defensive
 * default — register accepts the field but archon-server only uses it
 * for display, so a generic fallback is harmless.
 */
export function inferAigcMimeType(filePathOrSlot: string): string {
  const lower = filePathOrSlot.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.m4a')) return 'audio/m4a';
  if (lower.endsWith('.pcm')) return 'audio/pcm';
  if (lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'audio/ogg';
  return 'application/octet-stream';
}
