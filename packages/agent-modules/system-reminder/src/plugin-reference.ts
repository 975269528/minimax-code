export interface EffectivePluginToolGroup {
  readonly source: string;
  readonly tools: readonly string[];
  /** Deferred App tools must be discovered before they can be invoked. */
  readonly access?: 'direct' | 'tool_search';
}

export interface EffectivePluginCapabilityInventory {
  readonly name: string;
  readonly appTools: readonly EffectivePluginToolGroup[];
  readonly mcpTools: readonly EffectivePluginToolGroup[];
  readonly skills: readonly string[];
}

/**
 * Resolve canonical `@Plugin` references against the enabled capability
 * inventory for this turn. References must be whitespace-delimited so email
 * addresses, prefixes, and punctuation-attached plain text are not treated as
 * an explicit Plugin selection.
 */
export function detectPluginReferencesForMessages<T extends EffectivePluginCapabilityInventory>(
  messages: readonly { content?: string }[],
  fallbackText: string,
  plugins: readonly T[] | undefined,
): T[] {
  if (!plugins || plugins.length === 0) return [];
  const texts =
    messages.length === 0
      ? [fallbackText]
      : messages.flatMap((message) => (message.content?.trim() ? [message.content] : []));
  const selected: T[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    for (const match of detectReferencesInText(text, plugins)) {
      const key = normalizedName(match.name);
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(match);
    }
  }
  return selected;
}

/** Render one self-contained reminder for every Plugin selected in this turn. */
export function buildPluginReferenceReminder(
  plugins: readonly EffectivePluginCapabilityInventory[],
): string | undefined {
  if (plugins.length === 0) return undefined;
  const blocks = plugins.map((plugin) => {
    const name = inlineCode(plugin.name);
    return [
      `<selected-plugin name="${escapeXml(plugin.name)}">`,
      `Referenced as \`@${name}\`.`,
      '',
      '<connected-app-tools>',
      formatAppToolGroups(plugin.appTools),
      '</connected-app-tools>',
      '',
      '<plugin-mcp-tools>',
      formatToolGroups(plugin.mcpTools, 'server'),
      '</plugin-mcp-tools>',
      '',
      '<plugin-skills>',
      formatSkills(plugin.skills),
      '</plugin-skills>',
      '</selected-plugin>',
    ].join('\n');
  });

  return [
    '<system-reminder>',
    'The user explicitly selected the following Plugin capabilities for this request.',
    'Prefer them when relevant; other tools remain available if needed.',
    '',
    blocks.join('\n\n'),
    '',
    'Only the capabilities listed above are effective for this turn.',
    'Do not invent or claim unavailable Plugin capabilities.',
    ...(plugins.some((plugin) => plugin.appTools.some((group) => group.access === 'tool_search'))
      ? [
          'For App tools marked `via tool_search + mcp_invoke`, discover the exact tool with `tool_search` before calling it through `mcp_invoke`.',
        ]
      : []),
    'Before following a listed Skill, call the `skill` tool with its exact name.',
    'The existing tool schemas and loaded SKILL.md content are authoritative.',
    '</system-reminder>',
  ].join('\n');
}

function formatAppToolGroups(groups: readonly EffectivePluginToolGroup[]): string {
  if (groups.length === 0) return 'none';
  return [...groups]
    .sort((left, right) => {
      const sourceOrder = normalizedName(left.source).localeCompare(normalizedName(right.source));
      if (sourceOrder !== 0) return sourceOrder;
      return (left.access ?? 'direct').localeCompare(right.access ?? 'direct');
    })
    .map((group) => {
      const tools = formatToolNames(group.tools);
      const access = group.access === 'tool_search' ? ' via `tool_search` + `mcp_invoke`' : '';
      return `- app \`${inlineCode(group.source)}\`${access}: ${tools || 'none'}`;
    })
    .join('\n');
}

function detectReferencesInText<T extends EffectivePluginCapabilityInventory>(
  text: string,
  plugins: readonly T[],
): T[] {
  const normalizedText = text.normalize('NFKC');
  const matches: Array<{ index: number; plugin: T }> = [];
  for (const plugin of plugins) {
    const name = normalizedName(plugin.name);
    if (!name) continue;
    const pattern = new RegExp(`(^|\\s)@${escapeRegExp(name)}(?=\\s|$)`, 'giu');
    const match = pattern.exec(normalizedText);
    if (!match) continue;
    matches.push({ index: match.index + (match[1]?.length ?? 0), plugin });
  }
  matches.sort((left, right) => left.index - right.index);
  return matches.map((match) => match.plugin);
}

function formatToolGroups(
  groups: readonly EffectivePluginToolGroup[],
  label: 'app' | 'server',
): string {
  if (groups.length === 0) return 'none';
  return [...groups]
    .sort((left, right) => normalizedName(left.source).localeCompare(normalizedName(right.source)))
    .map((group) => {
      const tools = formatToolNames(group.tools);
      return `- ${label} \`${inlineCode(group.source)}\`: ${tools || 'none'}`;
    })
    .join('\n');
}

function formatToolNames(tools: readonly string[]): string {
  return [...new Set(tools)]
    .sort((left, right) => normalizedName(left).localeCompare(normalizedName(right)))
    .map((tool) => `\`${inlineCode(tool)}\``)
    .join(', ');
}

function formatSkills(skills: readonly string[]): string {
  if (skills.length === 0) return 'none';
  return [...new Set(skills)]
    .sort((left, right) => normalizedName(left).localeCompare(normalizedName(right)))
    .map((skill) => `- \`${inlineCode(skill)}\``)
    .join('\n');
}

function normalizedName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function inlineCode(value: string): string {
  return escapeXml(value).replace(/`/gu, '\\`');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}
