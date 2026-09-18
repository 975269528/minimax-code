import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../../../../../infra/db/client.js';
import { sessionAgentDefinitions } from '../../../../../infra/db/schema/sessions.js';
import {
  decodeSessionAgentDefinition,
  serializeSessionAgentDefinition,
  type FrozenAgentExecutionDefinition,
} from '../agent-binding.js';
import type { SessionModelSnapshot, SessionRecord, SessionUpdateFields } from '../contract.js';

const MODEL_FIELDS = {
  effectiveModelVariant: 'variant',
  effectiveModelThinking: 'thinking',
  effectiveModelContextWindow: 'contextWindow',
  effectiveModelMaxOutputTokens: 'maxOutputTokens',
} as const;

type MutableSessionModel = {
  -readonly [Key in keyof FrozenAgentExecutionDefinition['model']]: FrozenAgentExecutionDefinition['model'][Key];
};

/** Omitted fields survive only when the model identity is unchanged. */
export function normalizeSessionModelUpdate(
  current: SessionRecord,
  fields: SessionUpdateFields,
): SessionUpdateFields {
  if (typeof fields.effectiveModel !== 'string' || fields.effectiveModel === current.effectiveModel)
    return fields;
  return {
    effectiveModelVariant: null,
    effectiveModelThinking: null,
    effectiveModelContextWindow: null,
    effectiveModelMaxOutputTokens: null,
    ...fields,
  };
}

/** Runs inside the Session row transaction; never reopens the Agent definition. */
export function syncSessionAgentDefinitionModel(
  db: AppDb,
  sessionId: string,
  fields: SessionUpdateFields,
): void {
  if (
    !Object.hasOwn(fields, 'effectiveModel') &&
    !Object.keys(MODEL_FIELDS).some((key) => Object.hasOwn(fields, key))
  )
    return;
  const row = db
    .select()
    .from(sessionAgentDefinitions)
    .where(eq(sessionAgentDefinitions.sessionId, sessionId))
    .get();
  if (!row) return;
  const { definition } = decodeSessionAgentDefinition(row);
  if (definition.definitionVersion !== 2) return;
  const updated = updateSessionAgentDefinitionModel(definition, fields);
  const serialized = serializeSessionAgentDefinition({ definition: updated });
  db.update(sessionAgentDefinitions)
    .set({ definitionJson: serialized.definitionJson })
    .where(eq(sessionAgentDefinitions.sessionId, sessionId))
    .run();
  // The legacy Task mirror contains only prompt/capabilities, never model fields.
}

function updateSessionAgentDefinitionModel(
  definition: FrozenAgentExecutionDefinition,
  fields: SessionUpdateFields,
): FrozenAgentExecutionDefinition {
  const model: MutableSessionModel = { ...definition.model };
  applyModelIdentity(model, fields.effectiveModel);
  if (fields.modelParameterSnapshot) model.parameterSnapshot = { ...fields.modelParameterSnapshot };
  else if (model.parameterSnapshot) {
    model.parameterSnapshot = {
      ...model.parameterSnapshot,
      ...(Object.hasOwn(fields, 'effectiveModelContextWindow')
        ? { context: fields.effectiveModelContextWindow == null ? 'default' : 'selection' }
        : {}),
      ...(Object.hasOwn(fields, 'effectiveModelThinking')
        ? { effort: fields.effectiveModelThinking?.effort == null ? 'default' : 'selection' }
        : {}),
    };
  }
  applyModelFieldUpdates(model, fields);
  return { ...definition, model };
}

function applyModelIdentity(
  model: MutableSessionModel,
  key: SessionUpdateFields['effectiveModel'],
): void {
  if (typeof key !== 'string') return;
  const slash = key.indexOf('/');
  if (slash <= 0 || slash === key.length - 1)
    throw new Error('Session model must have a provider/model identity');
  const providerId = key.slice(0, slash);
  const modelId = key.slice(slash + 1);
  if (providerId !== model.providerId || modelId !== model.modelId) {
    delete model.parameterSnapshot;
    // Limits and effort belong to their model. Only explicit replacements
    // may follow a changed identity; the catalog resolves any absent limits.
    for (const field of Object.values(MODEL_FIELDS)) delete model[field];
  }
  model.providerId = providerId;
  model.modelId = modelId;
}

function applyModelFieldUpdates(model: MutableSessionModel, fields: SessionUpdateFields): void {
  for (const [field, target] of Object.entries(MODEL_FIELDS)) {
    if (!Object.hasOwn(fields, field)) continue;
    const value = fields[field as keyof typeof MODEL_FIELDS];
    if (value == null) delete model[target];
    else Object.assign(model, { [target]: value });
  }
}

/** Called inside the same immediate transaction as the Session and binding update. */
export function assertSessionModelSnapshot(
  current: SessionRecord,
  expected: SessionModelSnapshot | undefined,
): void {
  if (!expected) return;
  const fields = ['effectiveModel', ...Object.keys(MODEL_FIELDS)] as const;
  for (const field of fields) {
    const key = field as keyof SessionModelSnapshot;
    if (!isDeepStrictEqual(current[key] ?? null, expected[key] ?? null)) {
      throw new Error('Session model changed during repair. Retry with the current selection.');
    }
  }
}
