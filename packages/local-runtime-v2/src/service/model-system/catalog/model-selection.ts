import { ThinkingLevel } from '@mavis/protocol';
import { modelRefForModel, type ManagedModelParameterSnapshot } from '../resolution/model-ref.js';
import type {
  ConversationModelThinkingBudgets,
  ConversationModelThinkingSelection,
  ConversationModelSelection,
} from '@mavis/conversation-contract';
import {
  DEFAULT_MODEL_PRESETS,
  getRuntimePresetKey,
  isLegacyManagedMinimaxProvider,
  resolveModelAvailability,
} from '@mavis/config';
import { LocalModelProviderError, type LocalRuntimeConfig } from '../contracts.js';
import { parseProviderId, parseSourceQualifiedModelKey } from '../resolution/model-key.js';

export const LEGACY_MINIMAX_PROVIDER_ID = 'custom_provider:minimax-legacy';

export function isLegacyMinimaxProvider(config: LocalRuntimeConfig, providerId: string): boolean {
  const key = parseProviderId(providerId)?.providerKey;
  const provider = key ? config.custom_provider?.[key] : undefined;
  return isLegacyManagedMinimaxProvider(providerId, provider?.options?.baseURL);
}

/** Resolves a retired managed alias without changing unrelated custom providers. */
export function resolveLegacyMinimaxModel(
  config: LocalRuntimeConfig,
  selection: { readonly providerId: string; readonly modelId: string },
): { readonly providerId: string; readonly modelId: string } | undefined {
  if (!isLegacyMinimaxProvider(config, selection.providerId)) return undefined;
  const preset = getRuntimePresetKey();
  const configured = parseSourceQualifiedModelKey(config.defaultModel);
  const officialDefault = parseSourceQualifiedModelKey(DEFAULT_MODEL_PRESETS[preset].defaultModel);
  const candidates = [
    { providerId: 'minimax', modelId: selection.modelId },
    ...(configured &&
    (configured.providerId === 'minimax' || isLegacyMinimaxProvider(config, configured.providerId))
      ? [{ providerId: 'minimax', modelId: configured.modelId }]
      : []),
    ...(officialDefault
      ? [{ providerId: officialDefault.providerId, modelId: officialDefault.modelId }]
      : []),
  ];
  const replacement = candidates.find(
    (candidate) =>
      resolveModelAvailability({
        config,
        ...candidate,
        preset,
        source: 'explicit_request',
      }).available,
  );
  if (replacement) return replacement;
  throw new LocalModelProviderError(
    400,
    'The legacy MiniMax model has no available official replacement. Select an available official model.',
    'MODEL_NOT_AVAILABLE_FOR_ROUTE',
  );
}

export type LocalModelThinkingBudgets = ConversationModelThinkingBudgets;
export type LocalModelThinkingSelection = ConversationModelThinkingSelection;

export interface LocalModelOverride {
  provider_id?: string;
  model_id?: string;
  variant?: string;
  reasoning?: boolean;
  thinking?: LocalModelThinkingSelection;
}

export const SELECTED_THINKING_EFFORT_CAPABILITY = 'selected_thinking_effort';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function readThinkingBudgets(value: unknown): LocalModelThinkingBudgets | undefined {
  if (!isRecord(value)) return undefined;
  const budgets: {
    minimal?: number | string;
    low?: number | string;
    medium?: number | string;
    high?: number | string;
  } = {};
  for (const key of ['minimal', 'low', 'medium', 'high'] as const) {
    const raw = value[key];
    if (typeof raw === 'number' || typeof raw === 'string') budgets[key] = raw;
  }
  return Object.keys(budgets).length > 0 ? budgets : undefined;
}

/**
 * Preserve an explicitly supplied empty object: callers use `{}` to clear a
 * previous session selection without changing the selected model.
 */
export function readLocalModelThinkingSelection(
  value: unknown,
): LocalModelThinkingSelection | undefined {
  if (!isRecord(value)) return undefined;
  const effort = readOptionalString(value.effort);
  const offBehavior = readOptionalString(value.off_behavior ?? value.offBehavior);
  const budgets = readThinkingBudgets(value.budgets);
  return {
    ...(effort ? { effort } : {}),
    ...(offBehavior ? { off_behavior: offBehavior } : {}),
    ...(budgets ? { budgets } : {}),
  };
}

/** Session storage uses null for an explicit clear instead of persisting an empty object. */
export function readPersistedLocalModelThinkingSelection(
  value: unknown,
): LocalModelThinkingSelection | null {
  const selection = readLocalModelThinkingSelection(value);
  return selection && Object.keys(selection).length > 0 ? selection : null;
}

export function readLocalModelOverride(value: unknown): LocalModelOverride | undefined {
  if (!isRecord(value)) return undefined;
  const override = readLocalModelOverrideFields(value);
  if (Object.prototype.hasOwnProperty.call(value, 'thinking')) return override;
  return Object.keys(override).length > 0 ? override : undefined;
}

function readLocalModelOverrideFields(value: Record<string, unknown>): LocalModelOverride {
  return {
    ...readLocalModelIdentityFields(value),
    ...readLocalModelBehaviorFields(value),
  };
}

function readLocalModelIdentityFields(value: Record<string, unknown>): LocalModelOverride {
  const providerId = readOptionalString(value.provider_id ?? value.providerId);
  const modelId = readOptionalString(value.model_id ?? value.modelId);
  return {
    ...(providerId ? { provider_id: providerId } : {}),
    ...(modelId ? { model_id: modelId } : {}),
  };
}

function readLocalModelBehaviorFields(value: Record<string, unknown>): LocalModelOverride {
  const variant = typeof value.variant === 'string' ? value.variant : undefined;
  const reasoning = typeof value.reasoning === 'boolean' ? value.reasoning : undefined;
  const hasThinking = Object.prototype.hasOwnProperty.call(value, 'thinking');
  const thinking = hasThinking ? readLocalModelThinkingSelection(value.thinking) : undefined;
  return {
    ...(variant !== undefined ? { variant } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
}

export function readSelectedThinkingEffort(
  capabilities: Record<string, unknown> | undefined,
): string | undefined {
  return readOptionalString(capabilities?.[SELECTED_THINKING_EFFORT_CAPABILITY]);
}

interface QueueSelection {
  readonly provider_id?: string;
  readonly model_id?: string;
  readonly variant?: string;
  readonly reasoning?: boolean;
  readonly context_limit?: number;
  readonly thinking?: { readonly effort?: string };
  readonly parameterSnapshot?: ManagedModelParameterSnapshot;
}

interface SessionSelection {
  readonly sessionKind?: string;
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
  readonly effectiveModelContextWindow?: number | null;
  readonly effectiveModelThinking?: ConversationModelThinkingSelection | null;
  readonly effectiveModelMaxOutputTokens?: number | null;
}

/** Freeze only managed execution choices; credentials and catalog metadata stay in Model System. */
type FrozenQueueSelection = {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly thinking?: ConversationModelThinkingSelection;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly parameterSnapshot?: ManagedModelParameterSnapshot;
};

function savedParameter<T>(value: T | null | undefined, historical: T | undefined): T | undefined {
  return value === undefined ? historical : (value ?? undefined);
}

/** Reads accepted Session columns; an existing historical model only fills missing values. */
export function savedSessionModel(
  session: SessionSelection,
  historical?: FrozenQueueSelection,
): FrozenQueueSelection | undefined {
  const identity = parseSourceQualifiedModelKey(session.effectiveModel ?? undefined);
  if (!identity) return undefined;
  const previous =
    historical?.providerId === identity.providerId && historical.modelId === identity.modelId
      ? historical
      : undefined;
  return {
    providerId: identity.providerId,
    modelId: identity.modelId,
    variant: savedParameter(session.effectiveModelVariant, previous?.variant),
    thinking: savedParameter(session.effectiveModelThinking, previous?.thinking),
    contextWindow: savedParameter(session.effectiveModelContextWindow, previous?.contextWindow),
    maxOutputTokens: savedParameter(
      session.effectiveModelMaxOutputTokens,
      previous?.maxOutputTokens,
    ),
    // No historical row means no legacy exemption. The whole stored selection is accepted.
    parameterSnapshot: previous
      ? previous.parameterSnapshot
      : { context: 'selection', effort: 'selection' },
  };
}

/** Preserve the selected global effort when ordinary create supplies only its model identity. */
function resolveCreateThinking(
  config: LocalRuntimeConfig,
  requested: ConversationModelSelection,
  providerId: string,
  modelId: string,
): ConversationModelSelection['thinking'] {
  const fallback = parseSourceQualifiedModelKey(config.defaultModel);
  const inheritsGlobalEffort =
    providerId === 'minimax' &&
    config.minimaxModelSource !== 'minimax_api_key' &&
    providerId === fallback?.providerId &&
    modelId === fallback?.modelId &&
    requested.thinking === undefined &&
    requested.reasoning !== false &&
    requested.variant !== '' &&
    requested.variant !== 'none-thinking';
  return inheritsGlobalEffort ? config.defaultModelThinking : requested.thinking;
}

/** Resolves explicit create input before any Session record is written. */
export function resolveRequestedSessionModel(
  config: LocalRuntimeConfig,
  requested: ConversationModelSelection,
): ConversationModelSelection {
  const fallback = parseSourceQualifiedModelKey(config.defaultModel);
  const providerId = requested.providerId?.trim() || fallback?.providerId;
  const modelId = requested.modelId?.trim() || fallback?.modelId;
  if (!providerId || !modelId)
    throw new LocalModelProviderError(400, 'Model selection is incomplete', 'VALIDATION_ERROR');
  const availability = resolveModelAvailability({
    config,
    providerId,
    modelId,
    preset: getRuntimePresetKey(),
    source: 'explicit_request',
  });
  if (!availability.available)
    throw new LocalModelProviderError(400, availability.message, availability.code);
  const thinking = resolveCreateThinking(config, requested, providerId, modelId);
  const resolved = freezeManagedQueueModel(
    config,
    {},
    {
      provider_id: providerId,
      model_id: modelId,
      variant: requested.variant,
      reasoning: requested.reasoning,
      context_limit: requested.contextLimit,
      thinking,
    },
  );
  let variant = requested.variant;
  if (resolved?.reasoning !== undefined) variant = resolved.reasoning ? 'thinking' : '';
  return {
    providerId,
    modelId,
    variant,
    contextLimit: resolved?.context_limit,
    thinking: resolved?.thinking,
  };
}

export function freezeManagedQueueModel(
  config: LocalRuntimeConfig,
  session: SessionSelection,
  requested?: QueueSelection,
  frozenModel?: FrozenQueueSelection,
): QueueSelection | undefined {
  const saved = queueSessionModel(session, frozenModel);
  const inherited = inheritedQueueSelection(config, session, saved);
  const selection = requested ?? inherited;
  const provider = selection.provider_id ?? inherited.provider_id;
  const modelId = selection.model_id ?? inherited.model_id ?? '';
  if (provider !== 'minimax' || config.minimaxModelSource === 'minimax_api_key') return requested;
  const model = availableManagedQueueModel(config, modelId);
  if (!requested && saved && !saved.parameterSnapshot) {
    return freezeLegacyQueueSelection(provider, modelId, model, selection);
  }
  const resolved = modelRefForModel(provider, modelId, model, {
    managed: true,
    variant: selection.variant,
    reasoning: selection.reasoning,
    contextLimit: selection.context_limit,
    thinking: selection.thinking,
    parameterSnapshot: selection.parameterSnapshot,
  });
  return frozenQueueSelection(provider, modelId, selection, resolved);
}

function queueSessionModel(session: SessionSelection, frozenModel?: FrozenQueueSelection) {
  if (session.sessionKind === 'task' && frozenModel) return frozenModel;
  return savedSessionModel(session, frozenModel);
}

function availableManagedQueueModel(config: LocalRuntimeConfig, modelId: string) {
  const model = config.provider?.minimax?.models?.[modelId];
  if (!modelId || !model || model.enabled === false) {
    throw new LocalModelProviderError(
      400,
      'Selected managed model is unavailable',
      'VALIDATION_ERROR',
    );
  }
  return model;
}

function freezeLegacyQueueSelection(
  provider: string,
  modelId: string,
  model: Parameters<typeof modelRefForModel>[2],
  selection: QueueSelection,
): QueueSelection {
  const resolved = modelRefForModel(provider, modelId, model, {
    variant: selection.variant,
    thinking: selection.thinking,
  });
  const effort =
    resolved.thinking_level === ThinkingLevel.OFF
      ? undefined
      : readSelectedThinkingEffort({ ...resolved.capabilities });
  const context =
    Number.isSafeInteger(selection.context_limit) && Number(selection.context_limit) > 0
      ? selection.context_limit
      : resolved.context_window;
  return {
    provider_id: provider,
    model_id: modelId,
    variant: resolved.thinking_level === ThinkingLevel.OFF ? '' : 'thinking',
    reasoning: resolved.thinking_level !== ThinkingLevel.OFF,
    ...(context === undefined ? {} : { context_limit: context }),
    ...(effort ? { thinking: { effort } } : {}),
    parameterSnapshot: { context: 'legacy', effort: 'legacy' },
  };
}

function frozenQueueSelection(
  provider: string,
  modelId: string,
  selection: QueueSelection,
  resolved: ReturnType<typeof modelRefForModel>,
): QueueSelection {
  return {
    provider_id: provider,
    model_id: modelId,
    reasoning: resolved.thinking_level !== ThinkingLevel.OFF,
    ...(resolved.context_window === undefined ? {} : { context_limit: resolved.context_window }),
    ...(resolved.thinking_effort ? { thinking: { effort: resolved.thinking_effort } } : {}),
    parameterSnapshot: selection.parameterSnapshot ?? {
      context: selection.context_limit === undefined ? 'default' : 'selection',
      effort: selection.thinking?.effort === undefined ? 'default' : 'selection',
    },
  };
}

function inheritedQueueSelection(
  config: LocalRuntimeConfig,
  session: SessionSelection,
  frozen?: FrozenQueueSelection,
): QueueSelection {
  if (frozen)
    return {
      provider_id: frozen.providerId,
      model_id: frozen.modelId,
      variant: frozen.variant,
      thinking: frozen.thinking,
      context_limit: frozen.contextWindow,
      parameterSnapshot: frozen.parameterSnapshot,
    };
  const key = session.effectiveModel ?? config.defaultModel ?? '';
  const separator = key.indexOf('/');
  const parameters = session.effectiveModel
    ? session
    : {
        effectiveModelVariant: config.defaultModelVariant,
        effectiveModelContextWindow: config.defaultModelContextWindow,
        effectiveModelThinking: config.defaultModelThinking,
      };
  return {
    provider_id: key.slice(0, separator),
    model_id: key.slice(separator + 1),
    variant: parameters.effectiveModelVariant ?? undefined,
    context_limit: parameters.effectiveModelContextWindow ?? undefined,
    thinking: parameters.effectiveModelThinking ?? undefined,
  };
}
