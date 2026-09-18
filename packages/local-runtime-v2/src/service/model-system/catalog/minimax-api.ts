import { MINIMAX_API_MODEL_CATALOG, getRuntimeRegion } from '@mavis/config';

import type { LocalModelConfig, LocalRuntimeConfig } from '../contracts.js';

export const MINIMAX_API_FORMAT = 'anthropic-messages';
const MESSAGES_PATH = MINIMAX_API_FORMAT.split('-')[0];
export const MINIMAX_API_DEFAULT_BASE_URL =
  getRuntimeRegion() === 'cn'
    ? `https://api.minimaxi.com/${MESSAGES_PATH}`
    : `https://api.minimax.io/${MESSAGES_PATH}`;
export const MINIMAX_API_PROVIDER_NAME = 'MiniMax API';

export function minimaxApiBaseUrl(config: LocalRuntimeConfig): string {
  return config.minimax_api?.baseURL?.trim() || MINIMAX_API_DEFAULT_BASE_URL;
}

/** The API-key catalog is builtin; only user-owned context selections are overlaid. */
export function minimaxApiModels(config: LocalRuntimeConfig): Record<string, LocalModelConfig> {
  const catalog = MINIMAX_API_MODEL_CATALOG as Record<string, LocalModelConfig>;
  const overrides = config.minimax_api?.modelContextLimits;
  if (!overrides) return catalog;
  return Object.fromEntries(
    Object.entries(catalog).map(([modelId, model]) => {
      const context = overrides[modelId];
      return [
        modelId,
        context !== undefined && model.contextWindowOptions?.includes(context)
          ? { ...model, limit: { ...model.limit, context } }
          : model,
      ];
    }),
  );
}
