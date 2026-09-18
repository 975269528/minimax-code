import { LocalMavisToolDef, type LocalRuntimeTool } from '@mavis/agent-tools/desktop';

/**
 * Arg fields only ever consumed by a `cron <action>` command. Leaving these in
 * the model-visible schema advertises Cron even after the description section
 * is gone, so a host without a Cron adapter strips both together.
 *
 * `session_id` and `mode` serve Sessions; `enabled` also serves MCP settings.
 */
const CRON_ONLY_MAVIS_ARG_FIELDS = new Set([
  'cron_id',
  'cron_name',
  'schedule',
  'every',
  'after',
  'at',
  'active_hours',
  'quiet_on_skip',
  'timezone',
  'model',
  'prompt',
  'session',
]);

interface MutableSchemaNode {
  properties?: Record<string, MutableSchemaNode>;
  required?: string[];
  description?: string;
  [key: string]: unknown;
}

/** Drops Cron sentences while preserving command-list line boundaries. */
function withoutCronSentences(description: string): string | undefined {
  const kept = description
    .split('\n')
    .map((line) =>
      line
        .split(/(?<=\.)\s+/u)
        .filter((sentence) => !/cron/iu.test(sentence))
        .join(' '),
    )
    .filter((line) => line.trim())
    .join('\n')
    .trim();
  return kept || undefined;
}

function withoutCronSchemaDescriptions(schema: MutableSchemaNode): MutableSchemaNode {
  // Spread retains TypeBox's symbol keys (Kind / OptionalKind).
  const next = { ...schema };
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description' && typeof value === 'string') {
      const description = withoutCronSentences(value);
      if (description) next.description = description;
      else delete next.description;
    } else if (Array.isArray(value)) {
      next[key] = value.map((item) =>
        item && typeof item === 'object' ? withoutCronSchemaDescriptions(item) : item,
      );
    } else if (value && typeof value === 'object') {
      next[key] = withoutCronSchemaDescriptions(value as MutableSchemaNode);
    }
  }
  return next;
}

function withoutCronArgSchema(schema: MutableSchemaNode): MutableSchemaNode {
  const next = withoutCronSchemaDescriptions(schema);
  const args = next.properties?.args;
  if (!args?.properties) return next;
  const nextArgProperties: Record<string, MutableSchemaNode> = {};
  for (const [field, fieldSchema] of Object.entries(args.properties)) {
    if (CRON_ONLY_MAVIS_ARG_FIELDS.has(field)) continue;
    nextArgProperties[field] = fieldSchema;
  }
  return {
    ...next,
    properties: {
      ...next.properties,
      args: {
        ...args,
        properties: nextArgProperties,
        ...(args.required
          ? { required: args.required.filter((field) => !CRON_ONLY_MAVIS_ARG_FIELDS.has(field)) }
          : {}),
      },
    },
  };
}

function withoutCronDescriptionSection(description: string): string {
  const cronStart = description.indexOf('\ncron — local desktop scheduled tasks');
  const sessionStart = description.indexOf('\nsession — local desktop conversations', cronStart);
  const withoutCronSection =
    cronStart < 0 || sessionStart < 0
      ? description
      : description.slice(0, cronStart) + description.slice(sessionStart);
  return withoutCronSection
    .split('\n')
    .filter((line) => !line.includes('mavis({ command: "cron '))
    .join('\n');
}

/**
 * Removes every model-visible trace of Cron from the Mavis tool. Description
 * and schema are stripped together — description-only stripping still leaked
 * `cron_id` / `schedule` / `every` through the args schema, which was enough
 * for a model to infer the capability and call into an unsupported-host error.
 *
 * Non-mutating: the frozen `LocalMavisToolDef` source object is never touched.
 */
export function withoutLocalMavisCronGuidance(tool: LocalRuntimeTool): LocalRuntimeTool {
  if (tool.def.name !== LocalMavisToolDef.name) return tool;
  return {
    ...tool,
    def: {
      ...tool.def,
      description: withoutCronDescriptionSection(tool.def.description),
      schema: withoutCronArgSchema(tool.def.schema as unknown as MutableSchemaNode) as never,
    },
  };
}
