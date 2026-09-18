import { isTrustedBuiltinCreationSource } from '@mavis/agent-tools/desktop/subagent-roles';

import { canonicalBuiltinName } from '../../builtin/catalog.js';
import type { AgentListOptions, AgentStoreMeta, BuiltinAgentDefinition } from '../../contracts.js';
import type { AgentListCandidate } from './view.js';

export function collectAgentListCandidates(
  definitions: readonly BuiltinAgentDefinition[],
  metas: readonly AgentStoreMeta[],
  options: AgentListOptions,
): AgentListCandidate[] {
  const byName = new Map(metas.map((meta) => [meta.name, meta]));
  const consumed = new Set<string>();
  const candidates = collectBuiltinCandidates(definitions, byName, consumed);
  candidates.push(...collectCustomCandidates(metas, consumed, options));
  return candidates;
}

function collectBuiltinCandidates(
  definitions: readonly BuiltinAgentDefinition[],
  byName: ReadonlyMap<string, AgentStoreMeta>,
  consumed: Set<string>,
): AgentListCandidate[] {
  const candidates: AgentListCandidate[] = [];
  for (const definition of definitions) {
    const direct = byName.get(definition.name);
    // A manual canonical collision is an exact custom owner. Do not project
    // the trusted primary alias row (`main`) over it; the canonical-name
    // collision migration owns that physical conflict.
    if (direct && !isTrustedBuiltinCreationSource(direct.creationSource)) {
      for (const legacyName of definition.legacyNames) consumed.add(legacyName);
      continue;
    }
    const legacy = definition.legacyNames
      .map((name) => byName.get(name))
      .find((meta) => isTrustedBuiltinCreationSource(meta?.creationSource));
    const source =
      direct && isTrustedBuiltinCreationSource(direct.creationSource) ? direct : legacy;
    if (!source) continue;
    if (direct) consumed.add(direct.name);
    if (legacy) consumed.add(legacy.name);
    candidates.push({
      meta: source,
      canonicalViewName: definition.name,
      exactOwnerName: source.name,
      definition,
    });
  }
  return candidates;
}

function collectCustomCandidates(
  metas: readonly AgentStoreMeta[],
  consumed: ReadonlySet<string>,
  options: AgentListOptions,
): AgentListCandidate[] {
  const search = options.search?.trim().toLowerCase();
  return metas.flatMap((meta) => {
    if (consumed.has(meta.name)) return [];
    if (search && !meta.name.toLowerCase().includes(search)) return [];
    return [
      { meta, canonicalViewName: canonicalBuiltinName(meta.name), exactOwnerName: meta.name },
    ];
  });
}
