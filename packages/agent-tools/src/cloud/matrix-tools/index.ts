/**
 * matrix-tools package entry point: `buildCloudToolRegistry` (`../index.ts`) obtains all 18
 * RuntimeTools here.
 *
 * Responsibilities:
 * 1. Instantiate all matrix-tools classes, convert with toRuntimeTool, and return an array.
 * 2. Export `MATRIX_TOOL_NAMES` (RuntimeTool names), spread directly into
 *   `CAPABILITY_TO_TOOL_NAMES.Other`.
 * 3. Export `getSuppressedToolNamesForModelCapabilities`, the shared model capability gate consumed
 *   by cloud-runtime and local-runtime. During per-turn tool assembly, suppress fallback tools
 *   (`images_understand` / `videos_understand`) covered by native modalities.
 *
 * Capability maps / withToolResultTruncation belong to `../index.ts::buildCloudToolRegistry` and
 * are applied during Map assembly, not here.
 */

import type { IModelCapabilities } from '@mavis/protocol';
import { toRuntimeTool, type RuntimeTool } from '@mavis/agent-core/tools';
import type { TSchema } from '@sinclair/typebox';

import type {
  MatrixExecutor,
  MatrixMediaClient,
  MatrixPathScope,
  MatrixToolContext,
  MatrixToolLogger,
} from './types.js';
import type { MatrixAigcRegisterServiceGetter } from './aigc-helpers.js';
import {
  MATRIX_TOOL_PATHS,
  MatrixAudiosUnderstandToolDef,
  MatrixBatchImageToVideoToolDef,
  MatrixBatchSynthesizeSpeechToolDef,
  MatrixBatchTextToAudioToolDef,
  MatrixBatchTextToMusicToolDef,
  MatrixBatchTextToVideoToolDef,
  MatrixGenVideosToolDef,
  MatrixGetVoiceListToolDef,
  MatrixImageReverseSearchToolDef,
  MatrixImageSynthesizeToolDef,
  MatrixImagesSearchAndDownloadToolDef,
  MatrixImagesUnderstandToolDef,
  MatrixQueryVideoGenerationToolDef,
  MatrixSubmitVideoGenerationToolDef,
  MatrixTranscribeAudioToolDef,
  MatrixSynthesizeSpeechToolDef,
  MatrixVideosUnderstandToolDef,
} from './tool-defs.js';
import { MatrixAudiosUnderstandTool } from './tools/audios-understand.js';
import { MatrixBatchImageToVideoTool } from './tools/batch-image-to-video.js';
import { MatrixBatchSynthesizeSpeechTool } from './tools/batch-synthesize-speech.js';
import { MatrixBatchTextToAudioTool } from './tools/batch-text-to-audio.js';
import { MatrixBatchTextToMusicTool } from './tools/batch-text-to-music.js';
import { MatrixBatchTextToVideoTool } from './tools/batch-text-to-video.js';
import { MatrixGenVideosTool } from './tools/gen-videos.js';
import { MatrixGetVoiceListTool } from './tools/get-voice-list.js';
import { MatrixImageReverseSearchTool } from './tools/image-reverse-search.js';
import { MatrixImageSynthesizeTool } from './tools/image-synthesize.js';
import { MatrixImagesSearchAndDownloadTool } from './tools/images-search-and-download.js';
import { MatrixImagesUnderstandTool } from './tools/images-understand.js';
import { MatrixQueryVideoGenerationTool } from './tools/query-video-generation.js';
import { MatrixSubmitVideoGenerationTool } from './tools/submit-video-generation.js';
import { MatrixTranscribeAudioTool } from './tools/transcribe-audio.js';
import { MatrixSynthesizeSpeechTool } from './tools/synthesize-speech.js';
import { MatrixVideosUnderstandTool } from './tools/videos-understand.js';
import { MatrixWebSearchTool } from './tools/web-search.js';

export {
  callMatrixTool,
  callMatrixToolRaw,
  type CallMatrixToolOptions,
  type CallMatrixToolRawResult,
} from './client.js';
export * from './tool-defs.js';
export type {
  AigcOssKeys,
  MatrixAigcRegisterAssetInput,
  MatrixAigcRegistrar,
  MatrixAigcRegisterServiceGetter,
  RegisterAigcOpts,
} from './aigc-helpers.js';
export { inferAigcMimeType, registerAigcIfPresent } from './aigc-helpers.js';
export type {
  MatrixDownloadToFileOptions,
  MatrixExecutor,
  MatrixMediaClient,
  MatrixPathScope,
  MatrixToolContext,
  MatrixToolLogger,
  MatrixUploadOptions,
  MatrixUploadResult,
} from './types.js';
export { MatrixMediaError, readMatrixMediaErrorKind } from './types.js';
export { workspaceRootOf } from './path-guard.js';
export {
  FileTransferError,
  fileTransferFailureResult,
  uploadInputFile,
  uploadInputFiles,
  uploadedInputFileToMediaInfo,
  requireUploadedInputFileUrl,
  downloadOutputFile,
  writeOutputText,
  type MatrixMediaInfoPayload,
  type UploadedInputFile,
} from './file-transfer.js';

export { MatrixAudiosUnderstandTool } from './tools/audios-understand.js';
export { MatrixBatchImageToVideoTool } from './tools/batch-image-to-video.js';
export { MatrixBatchSynthesizeSpeechTool } from './tools/batch-synthesize-speech.js';
export { MatrixBatchTextToAudioTool } from './tools/batch-text-to-audio.js';
export { MatrixBatchTextToMusicTool } from './tools/batch-text-to-music.js';
export { MatrixBatchTextToVideoTool } from './tools/batch-text-to-video.js';
export { MatrixGenVideosTool } from './tools/gen-videos.js';
export { MatrixGetVoiceListTool } from './tools/get-voice-list.js';
export { MatrixImageReverseSearchTool } from './tools/image-reverse-search.js';
export { MatrixImageSynthesizeTool } from './tools/image-synthesize.js';
export { MatrixImagesSearchAndDownloadTool } from './tools/images-search-and-download.js';
export { MatrixImagesUnderstandTool } from './tools/images-understand.js';
export { MatrixQueryVideoGenerationTool } from './tools/query-video-generation.js';
export { MatrixSubmitVideoGenerationTool } from './tools/submit-video-generation.js';
export { MatrixTranscribeAudioTool } from './tools/transcribe-audio.js';
export { MatrixSynthesizeSpeechTool } from './tools/synthesize-speech.js';
export { MatrixVideosUnderstandTool } from './tools/videos-understand.js';
export { MatrixWebSearchTool } from './tools/web-search.js';

/**
 * Tool name constants, used as the spread source for `CAPABILITY_TO_TOOL_NAMES.Other`.
 *
 * Ordering follows `api.post` declarations in `mcp_service.thrift::McpService` so new tools can be
 * inserted in the corresponding position; do not sort alphabetically.
 *
 * **`web_search` is excluded**: like `web_fetch`, it belongs to `CAPABILITY_TO_TOOL_NAMES.WEB`, not
 * `Other` (`tools/index.ts` adds `MatrixWebSearchToolDef.name` directly to WEB). Pure MCP tools for
 * media / understanding / TTS remain in Other.
 */
export const MATRIX_TOOL_NAMES = [
  MatrixImagesUnderstandToolDef.name,
  MatrixImageSynthesizeToolDef.name,
  MatrixImagesSearchAndDownloadToolDef.name,
  MatrixImageReverseSearchToolDef.name,
  MatrixSubmitVideoGenerationToolDef.name,
  MatrixQueryVideoGenerationToolDef.name,
  MatrixGenVideosToolDef.name,
  MatrixBatchTextToVideoToolDef.name,
  MatrixBatchImageToVideoToolDef.name,
  MatrixGetVoiceListToolDef.name,
  MatrixBatchTextToAudioToolDef.name,
  MatrixBatchTextToMusicToolDef.name,
  MatrixSynthesizeSpeechToolDef.name,
  MatrixBatchSynthesizeSpeechToolDef.name,
  MatrixAudiosUnderstandToolDef.name,
  MatrixVideosUnderstandToolDef.name,
  MatrixTranscribeAudioToolDef.name,
] as const;

export interface BuildMatrixToolsOptions {
  readonly matrixLogger?: MatrixToolLogger;
  /** Dedicated public-upload client for every submit_video_generation media input. */
  readonly videoMediaClient?: MatrixMediaClient;
}

/**
 * Factory: Instantiate all matrix-tools classes and return their toRuntimeTool conversions.
 *
 * Three dependencies:
 * - `archonServer`: RemoteArchonServerAdapter; all tools share its `postJson` path, with
 *   identity/auditing/rate limits handled by archon-server.
 * - `ossMediaClient`: OSS media client for file-I/O tools to upload LLM-specified workspace files
 *   and download CDN URLs. Non-file tools (web_search / get_voice_list) accept but do not use it.
 * - `workspaceScope`: Input boundary for path-guard. A string means workspaceRoot (legacy
 *   behavior); an object may add `extraInputRoots` (the local runtime's dataDir assets subtree).
 *   Every file_path input passes this boundary check; output paths always use only workspaceRoot.
 *
 * Elements have type `RuntimeTool<TSchema, MatrixToolContext>`, so callers can push directly into
 * `tools[]` without casts.
 */
export function buildMatrixTools(
  archonServer: MatrixExecutor,
  ossMediaClient: MatrixMediaClient,
  workspaceScope: MatrixPathScope,
  aigcRegisterServiceGetter: MatrixAigcRegisterServiceGetter | null = null,
  options: BuildMatrixToolsOptions = {},
): Array<RuntimeTool<TSchema, MatrixToolContext>> {
  const tools: Array<RuntimeTool<TSchema, MatrixToolContext>> = [
    toRuntimeTool(new MatrixWebSearchTool(archonServer, ossMediaClient, workspaceScope)),
    toRuntimeTool(new MatrixImagesUnderstandTool(archonServer, ossMediaClient, workspaceScope)),
    toRuntimeTool(
      new MatrixImageSynthesizeTool(
        archonServer,
        ossMediaClient,
        workspaceScope,
        aigcRegisterServiceGetter,
      ),
    ),
    toRuntimeTool(
      new MatrixImagesSearchAndDownloadTool(archonServer, ossMediaClient, workspaceScope),
    ),
    toRuntimeTool(new MatrixImageReverseSearchTool(archonServer, ossMediaClient, workspaceScope)),
    toRuntimeTool(
      new MatrixSubmitVideoGenerationTool(
        archonServer,
        options.videoMediaClient ?? ossMediaClient,
        workspaceScope,
      ),
    ),
    toRuntimeTool(new MatrixQueryVideoGenerationTool(archonServer, ossMediaClient, workspaceScope)),
    toRuntimeTool(
      new MatrixGenVideosTool(
        archonServer,
        ossMediaClient,
        workspaceScope,
        aigcRegisterServiceGetter,
      ),
    ),
    toRuntimeTool(
      new MatrixBatchTextToVideoTool(
        archonServer,
        ossMediaClient,
        workspaceScope,
        aigcRegisterServiceGetter,
      ),
    ),
    toRuntimeTool(
      new MatrixBatchImageToVideoTool(
        archonServer,
        ossMediaClient,
        workspaceScope,
        aigcRegisterServiceGetter,
      ),
    ),
    toRuntimeTool(new MatrixGetVoiceListTool(archonServer, ossMediaClient, workspaceScope)),
    toRuntimeTool(
      new MatrixBatchTextToAudioTool(
        archonServer,
        ossMediaClient,
        workspaceScope,
        aigcRegisterServiceGetter,
      ),
    ),
    toRuntimeTool(
      new MatrixBatchTextToMusicTool(
        archonServer,
        ossMediaClient,
        workspaceScope,
        aigcRegisterServiceGetter,
      ),
    ),
    toRuntimeTool(
      new MatrixSynthesizeSpeechTool(
        archonServer,
        ossMediaClient,
        workspaceScope,
        aigcRegisterServiceGetter,
      ),
    ),
    toRuntimeTool(
      new MatrixBatchSynthesizeSpeechTool(
        archonServer,
        ossMediaClient,
        workspaceScope,
        aigcRegisterServiceGetter,
      ),
    ),
    toRuntimeTool(new MatrixAudiosUnderstandTool(archonServer, ossMediaClient, workspaceScope)),
    toRuntimeTool(new MatrixVideosUnderstandTool(archonServer, ossMediaClient, workspaceScope)),
    toRuntimeTool(new MatrixTranscribeAudioTool(archonServer, ossMediaClient, workspaceScope)),
  ];
  const { matrixLogger } = options;
  if (!matrixLogger) return tools;
  return tools.map((tool) => withMatrixLogger(tool, matrixLogger));
}

function withMatrixLogger(
  tool: RuntimeTool<TSchema, MatrixToolContext>,
  matrixLogger: MatrixToolLogger,
): RuntimeTool<TSchema, MatrixToolContext> {
  return {
    def: tool.def,
    impl: {
      execute(ctx, input, signal, onUpdate) {
        return tool.impl.execute(
          {
            ...ctx,
            matrixLogger: ctx.matrixLogger ?? matrixLogger,
          },
          input,
          signal,
          onUpdate,
        );
      },
    },
  };
}

export { MATRIX_TOOL_PATHS };

/**
 * Model capability → concrete tool suppression table.
 *
 * Tool authorization still starts from `agent_config.tools[]`; this table only
 * narrows redundant model-assist tools when the active model can natively
 * consume that modality. Model switches are explicit turn-level capability
 * changes, so the per-turn tool snapshot should reflect the current model's
 * real effective surface instead of keeping stale fallback tools around.
 *
 * Shared by both cloud-runtime (`packages/cloud-runtime/src/tools/index.ts`)
 * and local-runtime (`packages/local-runtime/src/api/local-native-tools.ts`)
 * so the two runtimes apply the same gate against the same `IModelCapabilities`
 * shape.
 */
const MODEL_CAPABILITY_SUPPRESSED_TOOL_NAMES = {
  supportImage: [MatrixImagesUnderstandToolDef.name],
  supportVideo: [MatrixVideosUnderstandToolDef.name],
} as const;

export function getSuppressedToolNamesForModelCapabilities(
  capabilities: IModelCapabilities | undefined,
): Set<string> {
  const suppressed = new Set<string>();
  if (capabilities?.support_image === true) {
    for (const name of MODEL_CAPABILITY_SUPPRESSED_TOOL_NAMES.supportImage) suppressed.add(name);
  }
  if (capabilities?.support_video === true) {
    for (const name of MODEL_CAPABILITY_SUPPRESSED_TOOL_NAMES.supportVideo) suppressed.add(name);
  }
  return suppressed;
}
