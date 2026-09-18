import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import { LocalSkillToolDef, type LocalSkillToolInput } from './builtin-defs.js';
import type { LocalRuntimeToolContext, LocalSkillReader } from './types.js';

@bindTool(LocalSkillToolDef)
export class LocalSkillTool implements ToolImpl<
  typeof LocalSkillToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly reader: LocalSkillReader) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalSkillToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const name = (typeof input.name === 'string' && input.name.trim()) || 'unknown-skill';
    const skill = await this.reader.readSkill(name, ctx.agentName, signal);
    if (signal?.aborted) throw new Error('Operation aborted');
    if (!skill) {
      const text = `Local skill not found: ${name}`;
      return {
        tool_name: LocalSkillToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: { kind: 'skill', skill: name, found: false, readable: false, owner: 'desktop' },
      };
    }
    ctx.loadedSkills?.add(name);
    const text = formatSkillContent(name, skill.content, skill.location);
    return {
      tool_name: LocalSkillToolDef.name,
      text,
      content: [{ type: 'text', text }],
      details: {
        kind: 'skill',
        skill: name,
        found: true,
        readable: true,
        owner: 'desktop',
        source: skill.sourceKind,
        location: skill.location,
      },
    };
  }
}

function formatSkillContent(name: string, content: string, location?: string): string {
  const header = [`# Skill: ${name}`];
  if (location) header.push(`Location: ${location}`);
  return `${header.join('\n')}\n\n${content}`;
}
