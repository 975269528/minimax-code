import type {
  McodeProviderModelInput,
  McodeProviderTemplate,
  McodeProviderView,
} from '../../../provider/contract.js';

/** Suggest a saved connection; only the user's choice authorizes updating it. */
export function matchesProviderTemplate(
  provider: McodeProviderView,
  template: McodeProviderTemplate,
): boolean {
  return (
    provider.kind === 'custom' &&
    provider.enabled &&
    !provider.readOnly &&
    (provider.apiFormat ?? 'anthropic-messages') === template.apiFormat &&
    provider.baseUrl?.trim().replace(/\/+$/u, '') === template.baseUrl.trim().replace(/\/+$/u, '')
  );
}

/** An edit retains existing model fields by sending only their IDs. */
export function additiveProviderModels(
  provider: McodeProviderView,
  models: readonly McodeProviderModelInput[],
): McodeProviderModelInput[] {
  const saved = new Set(provider.models.map((model) => model.modelId));
  return [
    ...provider.models.map(({ modelId }) => ({ modelId })),
    ...models.filter((model) => {
      if (saved.has(model.modelId)) return false;
      saved.add(model.modelId);
      return true;
    }),
  ];
}
