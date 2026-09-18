import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import { LocalCodeReviewToolDef, type LocalCodeReviewToolInput } from './builtin-defs.js';
import type { LocalCodeReviewAdapter, LocalRuntimeToolContext } from './types.js';

@bindTool(LocalCodeReviewToolDef)
export class LocalCodeReviewTool implements ToolImpl<
  typeof LocalCodeReviewToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly adapter: LocalCodeReviewAdapter) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalCodeReviewToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const result = await this.adapter.run(ctx, input, signal);
    if (result.status === 'failed') {
      const errorMessage = result.errorMessage ?? 'Code review failed';
      const text = `<code_review_error>${escapeTagText(errorMessage)}</code_review_error>`;
      return {
        tool_name: LocalCodeReviewToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: { status: 'failed', mode: result.mode },
        isError: true,
      };
    }
    if (result.status === 'prepared') {
      const instruction = result.instruction ?? '';
      const text = `<code_review_prepared mode="${result.mode}">\n${escapeClosingTag(instruction, 'code_review_prepared')}\n</code_review_prepared>`;
      return {
        tool_name: LocalCodeReviewToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: { status: 'prepared', mode: result.mode },
      };
    }
    const text =
      `<code_review_result_ready mode="${result.mode}">` +
      'The trusted review result is ready. Return a final response now; the runtime will project the stored result.' +
      '</code_review_result_ready>';
    return {
      tool_name: LocalCodeReviewToolDef.name,
      text,
      content: [{ type: 'text', text }],
      details: { status: 'succeeded', mode: result.mode },
    };
  }
}

function escapeClosingTag(value: string, tag: string): string {
  return value.replace(new RegExp(`</${tag}>`, 'giu'), `&lt;/${tag}&gt;`);
}

function escapeTagText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
