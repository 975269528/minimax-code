import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import { LocalFeatureEnableToolDef, type LocalFeatureEnableToolInput } from './builtin-defs.js';
import type { LocalAskUserAdapter, LocalRuntimeToolContext } from './types.js';

@bindTool(LocalFeatureEnableToolDef)
export class LocalFeatureEnableTool implements ToolImpl<
  typeof LocalFeatureEnableToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly adapter: LocalAskUserAdapter) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalFeatureEnableToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const result = await this.adapter.begin(
      ctx,
      {
        mode: 'feature-enable',
        modePayload: { featureKey: input.featureKey },
      },
      signal,
    );
    if ('suppressed' in result) {
      // The adapter only suppresses plain questionnaires; a consent prompt
      // must never be silently skipped, so treat this as a hard wiring error.
      throw new Error('feature-enable prompt unexpectedly suppressed');
    }
    const text = `Feature enable request ${result.requestId} is waiting for the local user. Stop this turn until the user replies.`;
    return {
      tool_name: LocalFeatureEnableToolDef.name,
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
