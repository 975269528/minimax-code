import { getRuntimePresetKey, resolveModelAvailability } from '@mavis/config';

import { imLogger as logger } from '../common/im-logger.js';
import type { LocalRuntimeConfig } from '../config/types.js';

/** Bounded repair event (plan §13): session / source / preset / from / to model. */
const MODEL_REPAIR_EVENT = 'session_model_repaired';

/** The Session facts the model check reads and writes; not a full record. */
export interface PrimaryFamilySessionModelView {
  readonly sessionId: string;
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
}

/**
 * The existing Session capabilities the check drives. `updateSession` is the
 * V2-owned lifecycle mutation — this module owns no repository and writes no
 * SQL, mirroring how the Turn-side repair is injected rather than imported.
 */
export interface PrimaryFamilySessionModelPort {
  getSession(sessionId: string): Promise<PrimaryFamilySessionModelView | undefined>;
  updateSession(
    sessionId: string,
    fields: { readonly effectiveModel: string; readonly effectiveModelVariant: null },
  ): Promise<unknown>;
}

export interface PrimaryFamilySessionModelRepairInput {
  readonly config: () => LocalRuntimeConfig;
  readonly sessions: PrimaryFamilySessionModelPort;
}

export interface PrimaryFamilySessionModelRepairResult {
  readonly checked: number;
  readonly repaired: number;
}

/**
 * Repair the historical Session models that the surviving channel path can
 * reach on THIS boot (plan §8.4, last paragraph).
 *
 * Scope is deliberately tiny: only the keeper Root. Every historical Session
 * is repaired lazily by the same rule at its first Turn, so a large install
 * does not pay a full-table scan at startup.
 *
 * The rule itself is the one MR A fixed and is NOT re-decided here: an invalid
 * Session override falls back to the currently valid `defaultModel`, the
 * variant is cleared (it belonged to the retired model), the change is
 * persisted through the existing lifecycle, and `session_model_repaired` is
 * logged. A VALID override that merely differs from the default is preserved —
 * boot must not force every Root onto the default model.
 */
export async function repairPrimaryFamilySessionModels(
  input: PrimaryFamilySessionModelRepairInput,
  sessionIds: readonly string[],
): Promise<PrimaryFamilySessionModelRepairResult> {
  if (sessionIds.length === 0) {
    logger.info({ outcome: 'skipped', reason: 'empty_scope' }, MODEL_REPAIR_EVENT);
    return { checked: 0, repaired: 0 };
  }
  const config = input.config();
  const preset = getRuntimePresetKey();
  let repaired = 0;
  for (const sessionId of sessionIds) {
    if (await repairOne({ input, config, preset, sessionId })) repaired += 1;
  }
  logger.info({ outcome: 'ok', checked: sessionIds.length, repaired, preset }, MODEL_REPAIR_EVENT);
  return { checked: sessionIds.length, repaired };
}

async function repairOne(scope: {
  readonly input: PrimaryFamilySessionModelRepairInput;
  readonly config: LocalRuntimeConfig;
  readonly preset: ReturnType<typeof getRuntimePresetKey>;
  readonly sessionId: string;
}): Promise<boolean> {
  const { input, config, preset, sessionId } = scope;
  const session = await input.sessions.getSession(sessionId);
  if (!session) {
    throw new Error(`PRIMARY_AGENT_SESSION_MODEL_MISSING: ${sessionId}`);
  }
  const override = parseModelKey(session.effectiveModel);
  if (!override) {
    // No Session-level pin: the Turn resolves `config.defaultModel`, which is
    // the Turn gate's business. Startup must not fail a boot over it.
    logger.info({ session_id: sessionId, reason: 'no_session_override' }, MODEL_REPAIR_EVENT);
    return false;
  }
  const availability = resolveModelAvailability({
    config,
    providerId: override.providerId,
    modelId: override.modelId,
    preset,
    source: 'session_override',
  });
  if (availability.available) {
    logger.info(
      { session_id: sessionId, reason: 'session_override_valid', route: availability.route },
      MODEL_REPAIR_EVENT,
    );
    return false;
  }
  const fallback = parseModelKey(config.defaultModel);
  const fallbackAvailability = fallback
    ? resolveModelAvailability({
        config,
        providerId: fallback.providerId,
        modelId: fallback.modelId,
        preset,
        source: 'config_default',
      })
    : undefined;
  if (!fallback || !fallbackAvailability?.available) {
    throw unavailableModelError(fallbackAvailability, 'DEFAULT_MODEL_NOT_AVAILABLE_FOR_ROUTE');
  }
  const repairedModel = `${fallback.providerId}/${fallback.modelId}`;
  await input.sessions.updateSession(sessionId, {
    effectiveModel: repairedModel,
    effectiveModelVariant: null,
  });
  logger.info(
    {
      session_id: sessionId,
      source: 'session_override',
      preset,
      from_model: `${override.providerId}/${override.modelId}`,
      to_model: repairedModel,
    },
    MODEL_REPAIR_EVENT,
  );
  return true;
}

function unavailableModelError(
  availability: ReturnType<typeof resolveModelAvailability> | undefined,
  fallbackCode: string,
): Error & { code: string } {
  const error = new Error(
    availability?.available ? fallbackCode : (availability?.message ?? fallbackCode),
  ) as Error & {
    code: string;
  };
  error.code = availability?.available ? fallbackCode : (availability?.code ?? fallbackCode);
  return error;
}

function parseModelKey(
  value: string | null | undefined,
): { readonly providerId: string; readonly modelId: string } | undefined {
  const raw = value?.trim();
  const slash = raw?.indexOf('/') ?? -1;
  if (!raw || slash <= 0 || slash === raw.length - 1) return undefined;
  return { providerId: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}
