import type { RuntimeTool } from '@mavis/agent-core/tools';

import type { HostCapabilityAdapter, HostCapabilityReferenceTarget } from './contracts.js';

const BROWSER_HOST_BINDING = Symbol('mavis.browser.host-binding');

/** Preserve turn-local admission across the existing tool attribution wrappers. */
function withBrowserHostBinding(binding: HostCapabilityReferenceTarget): RuntimeTool {
  return {
    ...binding.tool,
    def: { ...binding.tool.def, name: 'mcp_browser' },
    impl: {
      async execute(ctx, input, signal, onUpdate) {
        const result = await binding.tool.impl.execute(ctx, input, signal, onUpdate);
        return { ...result, tool_name: 'mcp_browser' };
      },
    },
    [BROWSER_HOST_BINDING]: binding,
  } as RuntimeTool;
}

export function getBrowserHostBinding(
  tool: RuntimeTool,
): HostCapabilityReferenceTarget | undefined {
  return (
    tool as RuntimeTool & { readonly [BROWSER_HOST_BINDING]?: HostCapabilityReferenceTarget }
  )[BROWSER_HOST_BINDING];
}

/** Browser-specific registration kept outside the generic Plugin/Binding pipeline. */
export function createBrowserHostCapabilityAdapter(
  describeInput: NonNullable<HostCapabilityAdapter['describeInput']>,
): HostCapabilityAdapter {
  return {
    capability: { id: 'browser.use', version: 1 },
    selectTarget: (tools) => tools.find((tool) => tool.def.name === 'browser'),
    describeInput,
    exposeTool: withBrowserHostBinding,
  };
}
