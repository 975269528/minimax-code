import type { AppDb } from '../../../infra/db/client.js';
import { readPreferenceValue, upsertPreferenceValue } from '../../../infra/db/preference-values.js';
import type { LocalAgentService } from './agent.service.js';

const STARRED_AGENTS_PREFERENCE_KEY = 'starred-agents';

/** Agent-owned persistence and wire projection for the legacy starred route. */
export class AgentFavorites {
  constructor(
    private readonly db: AppDb,
    private readonly agents: Pick<
      LocalAgentService,
      'getPersistedOwner' | 'resolveAgentExecutionTarget' | 'resolveAgentWriteTarget'
    >,
  ) {}

  async get(): Promise<string[]> {
    const stored = readPreferenceValue(this.db, STARRED_AGENTS_PREFERENCE_KEY);
    if (!Array.isArray(stored)) return [];
    const projected: string[] = [];
    const seen = new Set<string>();
    for (const value of stored) {
      if (typeof value !== 'string') continue;
      const explicit = value.toLowerCase().startsWith('agent:');
      const exact = explicit ? value.slice('agent:'.length) : value;
      const owner = await this.agents.getPersistedOwner(exact);
      const executionTarget = await this.agents.resolveAgentExecutionTarget(exact);
      let wireRef = owner?.requestRef ?? exact;
      if (explicit) wireRef = `agent:${exact}`;
      if (executionTarget !== exact) wireRef = executionTarget;
      if (seen.has(wireRef)) continue;
      seen.add(wireRef);
      projected.push(wireRef);
    }
    return projected;
  }

  async put(requestRefs: readonly string[]): Promise<string[]> {
    const exactOwners: string[] = [];
    const seen = new Set<string>();
    for (const requestRef of requestRefs) {
      const exact = await this.agents.resolveAgentWriteTarget(requestRef);
      if (seen.has(exact)) continue;
      seen.add(exact);
      exactOwners.push(exact);
    }
    upsertPreferenceValue(this.db, STARRED_AGENTS_PREFERENCE_KEY, exactOwners);
    return exactOwners;
  }
}
