import type {
  ConversationModelThinkingBudgets,
  ConversationModelThinkingSelection,
} from '@mavis/conversation-contract';

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
  const providerId = readOptionalString(value.provider_id ?? value.providerId);
  const modelId = readOptionalString(value.model_id ?? value.modelId);
  const variant = typeof value.variant === 'string' ? value.variant : undefined;
  const reasoning = typeof value.reasoning === 'boolean' ? value.reasoning : undefined;
  const hasThinking = Object.prototype.hasOwnProperty.call(value, 'thinking');
  const thinking = hasThinking ? readLocalModelThinkingSelection(value.thinking) : undefined;
  if (!providerId && !modelId && variant === undefined && reasoning === undefined && !hasThinking) {
    return undefined;
  }
  return {
    ...(providerId ? { provider_id: providerId } : {}),
    ...(modelId ? { model_id: modelId } : {}),
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
