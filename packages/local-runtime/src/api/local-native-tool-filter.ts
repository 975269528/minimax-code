import { agentNameDescription, type LocalRuntimeTool } from '@mavis/agent-tools/desktop';
import {
  AGENT_BUILTIN_TOOL_IDS,
  isAgentBuiltinToolEnabled,
  type ResolvedAgentCapabilities,
} from '@mavis/config';

export function filterLocalBuiltinCapabilityTools(
  tools: LocalRuntimeTool[],
  capabilities: ResolvedAgentCapabilities,
): LocalRuntimeTool[] {
  const configurableToolNames = new Set<string>(AGENT_BUILTIN_TOOL_IDS);
  const capabilityFiltered = tools.filter(
    (tool) =>
      (tool.def.name !== 'mavis' || capabilities.features.mavis) &&
      (!configurableToolNames.has(tool.def.name) ||
        isAgentBuiltinToolEnabled(
          capabilities,
          tool.def.name as (typeof AGENT_BUILTIN_TOOL_IDS)[number],
        )),
  );
  return capabilities.features.mavis
    ? capabilityFiltered
    : capabilityFiltered.map(withoutMavisTaskAgentNameDescription);
}

export function normalizedSkillName(name: string): string {
  return name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

export function isDesktopExtensionSkillSelected(
  allowedSkillNames: readonly string[] | undefined,
  selected: readonly string[] | undefined,
  pluginName: string,
  skillName: string,
): boolean {
  const name = normalizedSkillName(skillName);
  const qualified = `${normalizedSkillName(pluginName)}:${name}`;
  const includes = (values: readonly string[] | undefined): boolean =>
    values?.some((candidate) => {
      const normalized = normalizedSkillName(candidate);
      return normalized === name || normalized === qualified;
    }) ?? true;
  return includes(allowedSkillNames) && includes(selected);
}

function withoutMavisTaskAgentNameDescription(tool: LocalRuntimeTool): LocalRuntimeTool {
  if (tool.def.name !== 'task') return tool;
  const schema = tool.def.schema as {
    properties?: Record<string, { description?: string }>;
  };
  const agentName = schema.properties?.agent_name;
  if (!agentName) return tool;
  return {
    ...tool,
    def: {
      ...tool.def,
      schema: {
        ...tool.def.schema,
        properties: {
          ...schema.properties,
          agent_name: {
            ...agentName,
            description: agentNameDescription({ includeMavis: false }),
          },
        },
      },
    },
  } as LocalRuntimeTool;
}
