import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import { LocalMemoryToolDef, type LocalMemoryToolInput } from './builtin-defs.js';
import type { LocalMemoryAdapter, LocalRuntimeToolContext } from './types.js';

@bindTool(LocalMemoryToolDef)
export class LocalMemoryTool implements ToolImpl<
  typeof LocalMemoryToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly adapter: LocalMemoryAdapter) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalMemoryToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const result = await this.adapter.execute(ctx, input, signal);
    return {
      tool_name: LocalMemoryToolDef.name,
      text: result.text,
      content: [{ type: 'text', text: result.text }],
      details: { kind: 'memory', ...(result.details ?? {}) },
    };
  }
}
