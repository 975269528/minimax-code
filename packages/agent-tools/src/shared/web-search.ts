import { Type, type Static } from '@sinclair/typebox';
import type { ToolDefinition } from '@mavis/agent-core/tools';

export const WebSearchToolDef = {
  name: 'web_search',
  description: [
    'Search the web for external facts and current information such as news, prices, places, and recent posts.',
    'Use before answering or asking for clarification when external facts are unfamiliar or unsupported, including recent, changeable, niche, or user-provided claims. Skip verification when facts are clearly stable or already supported by the conversation, local files, or stable general knowledge.',
    'Prefer primary or authoritative sources. For important, surprising, disputed, or source-dependent claims, cross-check key facts across multiple reliable sources when practical. State when sources conflict or only one reliable source is available.',
    'Search misses do not prove non-existence. If results are inconclusive, inspect an authoritative source with an available page-reading tool, or state that the claim could not be verified.',
    'Report only searches actually performed and cite URLs returned by tools. A search result does not establish that its source page was opened or verified; claim that only after a tool actually read the page.',
  ].join('\n'),
  schema: Type.Object({
    query: Type.String({ description: 'Search query.' }),
    count: Type.Optional(Type.Integer({ description: 'Max results (default 10).' })),
    freshness: Type.Optional(
      Type.String({ description: 'noLimit (default) | day | week | month | year.' }),
    ),
    search_type: Type.Optional(
      Type.String({ description: 'search (default) | videos | places | news | shopping.' }),
    ),
  }),
} as const satisfies ToolDefinition;

export type WebSearchInput = Static<typeof WebSearchToolDef.schema>;
