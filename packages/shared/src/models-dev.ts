export type ModelsDevRegion = 'cn' | 'en';

const MODELS_DEV_BASE_URLS: Readonly<Record<ModelsDevRegion, string>> = {
  cn: 'https://filecdn.minimax.chat/public/models-dev',
  en: 'https://models.dev',
};

/** Canonical snapshot provenance; regional mirrors serve the same catalog bytes. */
export const MODELS_DEV_CATALOG_SOURCE_URL = `${MODELS_DEV_BASE_URLS.en}/api.json`;

export function resolveModelsDevCatalogUrl(region: ModelsDevRegion): string {
  return `${MODELS_DEV_BASE_URLS[region]}/api.json`;
}

export function resolveModelsDevProviderLogoUrl(
  region: ModelsDevRegion,
  providerId: string,
): string {
  return `${MODELS_DEV_BASE_URLS[region]}/logos/${encodeURIComponent(providerId)}.svg`;
}
