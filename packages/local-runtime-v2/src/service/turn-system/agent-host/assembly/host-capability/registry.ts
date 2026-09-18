import type { RuntimeTool } from '@mavis/agent-core/tools';

import type {
  HostCapabilityAdapter,
  HostCapabilityPrepareInput,
  HostCapabilityReferenceTarget,
  HostCapabilityResolver,
  PreparedHostCapabilities,
} from './contracts.js';

/** Host-owned registry. Plugin packages can request these ids but cannot register adapters. */
export class HostCapabilityRegistry implements HostCapabilityResolver {
  private readonly adapters: ReadonlyMap<string, HostCapabilityAdapter>;

  constructor(adapters: readonly HostCapabilityAdapter[]) {
    const byCapability = new Map<string, HostCapabilityAdapter>();
    for (const adapter of adapters) {
      const key = capabilityKey(adapter.capability.id, adapter.capability.version);
      if (byCapability.has(key)) {
        throw new Error(`Duplicate Host capability adapter: ${key}`);
      }
      byCapability.set(key, adapter);
    }
    this.adapters = byCapability;
  }

  prepare(input: HostCapabilityPrepareInput): PreparedHostCapabilities {
    const targets = new Map<string, RuntimeTool>();
    const claimedTools = new Set<RuntimeTool>();
    for (const [key, adapter] of this.adapters) {
      const target = adapter.selectTarget(input.tools);
      if (!target) continue;
      if (claimedTools.has(target)) {
        throw new Error(`Host tool is claimed by more than one capability adapter: ${key}`);
      }
      targets.set(key, target);
      claimedTools.add(target);
    }

    const referenceRegistry = new Map<string, HostCapabilityReferenceTarget>();
    const exposedTools = new Map<RuntimeTool, RuntimeTool>();
    const bindings = input.bindings.filter(
      (binding) =>
        binding.allowedSurfaces.some((surface) => surface === input.surface) &&
        binding.requiredSkillRuntimeNames.every((name) =>
          input.availableSkillRuntimeNames.has(name),
        ),
    );
    for (const binding of bindings) {
      const key = capabilityKey(binding.hostCapability.id, binding.hostCapability.version);
      const target = targets.get(key);
      if (!target || referenceRegistry.has(binding.toolRef) || exposedTools.has(target)) continue;
      const adapter = this.adapters.get(key);
      const reference = {
        tool: target,
        pluginName: binding.pluginName,
        requiredSkillRuntimeNames: binding.requiredSkillRuntimeNames,
        inputSchema: adapter?.describeInput?.(target) ?? target.def.schema,
      };
      if (adapter?.exposeTool) {
        exposedTools.set(target, adapter.exposeTool(reference));
      } else {
        referenceRegistry.set(binding.toolRef, reference);
      }
    }
    assertPublicToolNamesAvailable(exposedTools, input.tools);
    return {
      publicTools: input.tools.flatMap((tool) => {
        if (!claimedTools.has(tool)) return [tool];
        const exposed = exposedTools.get(tool);
        return exposed ? [exposed] : [];
      }),
      referenceRegistry,
    };
  }
}

function assertPublicToolNamesAvailable(
  exposedTools: ReadonlyMap<RuntimeTool, RuntimeTool>,
  tools: readonly RuntimeTool[],
): void {
  const publicNames = new Set<string>();
  for (const [target, exposed] of exposedTools) {
    const name = normalizedToolName(exposed.def.name);
    if (
      publicNames.has(name) ||
      tools.some((tool) => tool !== target && normalizedToolName(tool.def.name) === name)
    ) {
      throw new Error(`Host tool conflicts with an existing tool: ${exposed.def.name}`);
    }
    publicNames.add(name);
  }
}

function normalizedToolName(name: string): string {
  return name.trim().normalize('NFKC').toLowerCase();
}

function capabilityKey(id: string, version: number): string {
  return `${id}@${version}`;
}
