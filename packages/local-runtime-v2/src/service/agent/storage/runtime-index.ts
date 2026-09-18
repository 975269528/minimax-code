import { agents } from '../../../infra/db/schema/agents.js';
import { encodeAgentRoleForStorage } from '../domain/roles.js';
import type { AgentStoreInsert, AgentStoreMeta, AgentStoreUpdate } from '../contracts.js';
import type { CanonicalCustomAgentFile } from './agent-files.js';

export type RuntimeIndexInput = AgentStoreInsert & { readonly greetingSent?: boolean };

export function runtimeUpdateValues(fields: AgentStoreUpdate): Partial<typeof agents.$inferInsert> {
  const values: Partial<typeof agents.$inferInsert> = {};
  if (fields.agentRole !== undefined) {
    values.agentRole = encodeAgentRoleForStorage(fields.agentRole);
  }
  if (fields.mainSessionId !== undefined) values.mainSessionId = fields.mainSessionId;
  if (fields.creationSource !== undefined) values.creationSource = fields.creationSource;
  if (fields.greetingSent !== undefined) values.greetingSent = fields.greetingSent ? 1 : 0;
  if (fields.createdAtMs !== undefined) values.createdAt = fields.createdAtMs;
  if (fields.updatedAtMs !== undefined) values.updatedAt = fields.updatedAtMs;
  return values;
}

export function runtimeIndexForUpdate(name: string, fields: AgentStoreUpdate): RuntimeIndexInput {
  const updatedAtMs = fields.updatedAtMs ?? Date.now();
  return {
    name,
    agentRole: fields.agentRole ?? 'worker',
    creationSource: 'manual',
    ...(fields.mainSessionId == null ? {} : { rootSessionId: fields.mainSessionId }),
    createdAtMs: fields.createdAtMs ?? updatedAtMs,
    updatedAtMs,
    ...(fields.greetingSent === undefined ? {} : { greetingSent: fields.greetingSent }),
  };
}

export function canonicalCustomRuntimeFields(runtimeMeta: AgentStoreMeta | undefined) {
  return {
    agentRole: runtimeMeta?.agentRole ?? 'worker',
    ...(runtimeMeta?.rootSessionId ? { rootSessionId: runtimeMeta.rootSessionId } : {}),
    creationSource:
      runtimeMeta?.creationSource === 'auto' ? ('auto' as const) : ('manual' as const),
    greetingSent: runtimeMeta?.greetingSent ?? false,
    ...(runtimeMeta?.pinned === undefined ? {} : { pinned: runtimeMeta.pinned }),
    ...(runtimeMeta?.pinnedAtMs === undefined ? {} : { pinnedAtMs: runtimeMeta.pinnedAtMs }),
  };
}

export function canonicalCustomTimestamps(
  runtimeMeta: AgentStoreMeta | undefined,
  file: CanonicalCustomAgentFile | undefined,
) {
  const createdAtMs = runtimeMeta?.createdAtMs ?? file?.createdAtMs ?? 0;
  return {
    createdAtMs,
    updatedAtMs: runtimeMeta?.updatedAtMs ?? file?.updatedAtMs ?? createdAtMs,
  };
}
