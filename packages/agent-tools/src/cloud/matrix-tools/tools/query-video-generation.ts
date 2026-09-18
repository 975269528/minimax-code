import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import { callMatrixToolRaw, type MatrixExecutor } from '../client.js';
import {
  downloadOutputFile,
  FileTransferError,
  fileTransferFailureResult,
} from '../file-transfer.js';
import {
  HAILUO_23_MODEL,
  isH3VideoModel,
  MATRIX_TOOL_PATHS,
  MINIMAX_H3_MODEL,
  MatrixQueryVideoGenerationToolDef,
  type MatrixQueryVideoGenerationInput,
} from '../tool-defs.js';
import type { MatrixMediaClient, MatrixPathScope, MatrixToolContext } from '../types.js';

@bindTool(MatrixQueryVideoGenerationToolDef)
export class MatrixQueryVideoGenerationTool implements ToolImpl<
  typeof MatrixQueryVideoGenerationToolDef.schema,
  MatrixToolContext
> {
  constructor(
    private readonly archonServer: MatrixExecutor,
    private readonly mediaClient: MatrixMediaClient,
    private readonly workspaceScope: MatrixPathScope,
  ) {}

  async execute(
    ctx: MatrixToolContext,
    input: MatrixQueryVideoGenerationInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');

    const toolName = MatrixQueryVideoGenerationToolDef.name;
    const path = MATRIX_TOOL_PATHS[toolName];
    if (!isH3VideoModel(input.model) && input.model !== HAILUO_23_MODEL) {
      const text = `Invalid video query: model must be ${MINIMAX_H3_MODEL} or ${HAILUO_23_MODEL}.`;
      return {
        tool_name: toolName,
        text,
        content: [{ type: 'text', text }],
        isError: true,
        details: { ok: false, path, reason: 'invalid_video_request' },
      };
    }
    const raw = await callMatrixToolRaw({
      toolName,
      path,
      input: { task_id: input.task_id, model: input.model },
      ctx,
      archonServer: this.archonServer,
      ...(signal ? { signal } : {}),
    });
    if (!raw.ok) return raw.result;

    if (raw.response.status === 'succeeded') {
      const videoUrl = typeof raw.response.video_url === 'string' ? raw.response.video_url : '';
      if (!videoUrl) {
        const text =
          'Video task succeeded but the server response did not include video_url, so no local file was written.';
        return {
          tool_name: toolName,
          text,
          content: [{ type: 'text', text }],
          isError: true,
          details: { ok: false, path, reason: 'missing_video_url', response: raw.response },
        };
      }

      try {
        const downloaded = await downloadOutputFile(
          videoUrl,
          input.output_file_path,
          this.workspaceScope,
          this.mediaClient,
          { ...(signal ? { signal } : {}) },
        );
        const text = `Video generation succeeded. Wrote ${downloaded.bytes} bytes to ${downloaded.absolutePath}.`;
        return {
          tool_name: toolName,
          text,
          content: [{ type: 'text', text }],
          details: {
            ok: true,
            path,
            response: raw.response,
            output_file_path: downloaded.absolutePath,
            bytes: downloaded.bytes,
          },
        };
      } catch (err) {
        if (err instanceof FileTransferError) {
          return fileTransferFailureResult(toolName, path, err);
        }
        throw err;
      }
    }

    const text = JSON.stringify(raw.response, null, 2);
    return {
      tool_name: toolName,
      text,
      content: [{ type: 'text', text }],
      details: { ok: true, path, response: raw.response },
    };
  }
}
