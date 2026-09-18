import { createHash } from 'node:crypto';
import type { AgentPromptSnapshot } from '../contracts.js';

export function describeAgentPromptSnapshot(
  snapshot: AgentPromptSnapshot,
): Readonly<Record<string, unknown>> {
  return {
    schema_version: 2,
    mode: snapshot.mode,
    ...(snapshot.version ? { package_version: snapshot.version } : {}),
    template_sha256: hash(snapshot.template),
    system_prompt_sha256: hash(snapshot.systemPrompt),
  };
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
