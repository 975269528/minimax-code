/**
 * transcribe_audio —— Pattern B: upload one local audio file and ask the
 * Matrix backend to transcribe it. The backend endpoint remains listen_audio.
 */

import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import type { MatrixMediaClient, MatrixPathScope, MatrixToolContext } from '../types.js';
import { callMatrixTool, type MatrixExecutor } from '../client.js';
import {
  FileTransferError,
  fileTransferFailureResult,
  uploadInputFile,
  uploadedInputFileToMediaInfo,
} from '../file-transfer.js';
import {
  MATRIX_TOOL_PATHS,
  MatrixTranscribeAudioToolDef,
  type MatrixTranscribeAudioInput,
} from '../tool-defs.js';

@bindTool(MatrixTranscribeAudioToolDef)
export class MatrixTranscribeAudioTool implements ToolImpl<
  typeof MatrixTranscribeAudioToolDef.schema,
  MatrixToolContext
> {
  constructor(
    private readonly archonServer: MatrixExecutor,
    private readonly ossMediaClient: MatrixMediaClient,
    private readonly workspaceScope: MatrixPathScope,
  ) {}

  async execute(
    ctx: MatrixToolContext,
    input: MatrixTranscribeAudioInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const path = MATRIX_TOOL_PATHS[MatrixTranscribeAudioToolDef.name];
    try {
      const uploaded = await uploadInputFile(
        input.audio_info.file_path,
        this.workspaceScope,
        this.ossMediaClient,
      );
      const body = {
        audio_info: uploadedInputFileToMediaInfo(uploaded, input.audio_info.prompt),
      };
      return await callMatrixTool({
        toolName: MatrixTranscribeAudioToolDef.name,
        path,
        input: body,
        ctx,
        archonServer: this.archonServer,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (err instanceof FileTransferError) {
        return fileTransferFailureResult(MatrixTranscribeAudioToolDef.name, path, err);
      }
      throw err;
    }
  }
}
