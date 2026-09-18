import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import { LocalAskUserToolDef, type LocalAskUserToolInput } from './builtin-defs.js';
import type { LocalAskUserAdapter, LocalRuntimeToolContext } from './types.js';

@bindTool(LocalAskUserToolDef)
export class LocalAskUserTool implements ToolImpl<
  typeof LocalAskUserToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly adapter: LocalAskUserAdapter) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalAskUserToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const result = await this.adapter.begin(ctx, input, signal);
    if ('suppressed' in result) {
      // Decision v3: a question raised while the user already has an
      // instruction in flight is superseded, not asked. No questionnaire
      // exists, nothing renders, and the turn keeps running (no terminate).
      const text =
        'Question not asked: the user already sent a new instruction while this question was being raised. Follow the incoming user message instead.';
      return {
        tool_name: LocalAskUserToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: {
          suppressed: true,
          reason: result.reason,
          waiting_for_user: false,
        },
      };
    }
    const text = `Questionnaire ${result.requestId} is waiting for the local user. Stop this turn until the user replies.`;
    return {
      tool_name: LocalAskUserToolDef.name,
      text,
      content: [{ type: 'text', text }],
      details: {
        request_id: result.requestId,
        schema_version: result.schemaVersion,
        step_count: result.stepCount,
        waiting_for_user: true,
      },
      terminate: true,
    };
  }
}
