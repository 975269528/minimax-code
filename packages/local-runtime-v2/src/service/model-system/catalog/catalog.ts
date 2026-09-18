import {
  builtinProviderKind,
  buildModelEntry,
  listByokRuntimeModels,
  routeModelEntries,
  type ModelProviderModelEntry,
} from './list-models.js';
import { modelCacheStatusFor, type ModelCacheData } from './model-cache.js';
import type { LocalRuntimeConfig } from '../contracts.js';
import { MANAGED_MINIMAX_PROVIDER_ID } from '../identity.js';

export interface LocalRuntimeModelSelection {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly variant?: string | null;
}

export type LocalRuntimeModelKeyResolution =
  | { readonly kind: 'resolved'; readonly modelKey: string }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] }
  | { readonly kind: 'not_found' };

/** Build the route-aware model catalog consumed by desktop and local CLI surfaces. */
export function listLocalRuntimeModels(
  config: LocalRuntimeConfig,
  selection?: LocalRuntimeModelSelection,
  options?: { readonly cache?: ModelCacheData; readonly implicitCustomProviderThinking?: boolean },
): ModelProviderModelEntry[] {
  const [defaultProviderId, defaultModelId] = splitModelId(config.defaultModel ?? '');
  const selectedProviderId = selection?.providerId ?? defaultProviderId;
  const selectedModelId = selection?.modelId ?? defaultModelId;
  const selectionVariant = selection ? selection.variant : config.defaultModelVariant;
  const hasSelectionVariant = selection
    ? selection.variant !== undefined
    : config.defaultModelVariant !== undefined;
  const builtin = Object.entries(config.provider ?? {}).flatMap(([providerId, provider]) =>
    routeModelEntries(config, providerId, provider).map(([modelId, model]) =>
      buildModelEntry({
        providerId,
        modelId,
        model,
        selected: providerId === selectedProviderId && modelId === selectedModelId,
        selectionVariant,
        hasSelectionVariant,
        providerSource: 'provider',
        providerKind: builtinProviderKind(config, providerId, provider),
        providerName: provider.name ?? providerId,
        ...resolveApiFormat(config, providerId, provider),
        status: options?.cache
          ? modelCacheStatusFor(options.cache, providerId, modelId)
          : undefined,
      }),
    ),
  );
  const byok = listByokRuntimeModels(
    config,
    {
      providerId: selectedProviderId,
      modelId: selectedModelId,
      variant: selectionVariant,
      hasVariant: hasSelectionVariant,
    },
    options?.cache,
    options?.implicitCustomProviderThinking === true
      ? { implicitCustomProviderThinking: true }
      : {},
  );
  return [...builtin, ...byok];
}

/**
 * Resolves user-authored model text against the same live catalog shown by the
 * Desktop selector. Exact keys and names win over shorthand matching; a
 * shorthand is accepted only when it identifies one model unambiguously.
 */
export function resolveLocalRuntimeModelKey(
  config: LocalRuntimeConfig,
  rawModel: string,
): LocalRuntimeModelKeyResolution {
  const input = rawModel.trim();
  if (!input) return { kind: 'not_found' };

  const catalog = listLocalRuntimeModels(config);
  const exactKey = uniqueModelMatches(
    catalog.filter((entry) => entry.modelConfigId.toLowerCase() === input.toLowerCase()),
  );
  if (exactKey) return exactKey;

  const exactName = uniqueModelMatches(
    catalog.filter(
      (entry) =>
        entry.modelId.toLowerCase() === input.toLowerCase() ||
        entry.displayName.toLowerCase() === input.toLowerCase(),
    ),
  );
  if (exactName) return exactName;

  const shorthand = normalizeModelSearchText(input);
  if (shorthand.length < 2) return { kind: 'not_found' };
  return (
    uniqueModelMatches(
      catalog.filter((entry) =>
        [entry.modelId, entry.displayName].some((value) =>
          normalizeModelSearchText(value).includes(shorthand),
        ),
      ),
    ) ?? { kind: 'not_found' }
  );
}

function uniqueModelMatches(
  entries: readonly ModelProviderModelEntry[],
): Exclude<LocalRuntimeModelKeyResolution, { readonly kind: 'not_found' }> | undefined {
  const candidates = [...new Set(entries.map((entry) => entry.modelConfigId))];
  const [candidate] = candidates;
  if (candidates.length === 1 && candidate !== undefined)
    return { kind: 'resolved', modelKey: candidate };
  if (candidates.length > 1) return { kind: 'ambiguous', candidates };
  return undefined;
}

function normalizeModelSearchText(value: string): string {
  return (
    value
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).join('');
}

function resolveApiFormat(
  config: LocalRuntimeConfig,
  providerId: string,
  provider: NonNullable<LocalRuntimeConfig['provider']>[string],
): { readonly apiFormat?: string } {
  if (
    providerId === MANAGED_MINIMAX_PROVIDER_ID &&
    config.minimaxModelSource === 'minimax_api_key'
  ) {
    return { apiFormat: 'anthropic-messages' };
  }
  if (typeof provider.api === 'string') return { apiFormat: provider.api };
  return {};
}

function splitModelId(modelKey: string): [string | undefined, string | undefined] {
  const slash = modelKey.indexOf('/');
  if (slash <= 0 || slash === modelKey.length - 1) return [undefined, undefined];
  return [modelKey.slice(0, slash), modelKey.slice(slash + 1)];
}
