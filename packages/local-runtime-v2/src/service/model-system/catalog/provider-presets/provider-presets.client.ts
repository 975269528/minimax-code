import { DEFAULT_MODEL_PRESETS, getRuntimePresetKey, getRuntimeRegion } from '@mavis/config';
import { MODELS_DEV_CATALOG_SOURCE_URL, type ModelsDevRegion } from '@mavis/shared/models-dev';

export const MODELS_DEV_URL = MODELS_DEV_CATALOG_SOURCE_URL;

const MODELS_DEV_TIMEOUT_MS = 8_000;
const COMMON_CONFIG_TIMEOUT_MS = 600;
const PINNED_PROVIDER_IDS_CONFIG_KEY = 'agent_byok_pinned_provider_ids';
const COMMON_CONFIG_PATH = '/v1/api/config/web/common_config';
const MODELS_DEV_DESCRIPTOR_PATH = '/mavis/api/v1/models-dev/catalog';
const MODELS_DEV_ICON_BASE_URL = 'https://models.dev/logos/';
const MODELS_DEV_MIRROR_HOST = 'filecdn.minimax.chat';
const MIRROR_CATALOG_PATH = /^\/public\/models-dev\/catalog\/([0-9a-f]{64})\/api\.json$/;
const MIRROR_ICON_PATH = /^\/public\/models-dev\/catalog\/([0-9a-f]{64})\/logos\/$/;

export type ModelsDevCatalogFetchResult =
  | { readonly kind: 'not_modified' }
  | {
      readonly kind: 'updated';
      readonly catalog: Record<string, unknown>;
      readonly etag?: string;
      readonly iconBaseUrl: string;
    };

export async function fetchModelsDevCatalog(options: {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly etag?: string;
  readonly region?: ModelsDevRegion;
  readonly descriptorOriginGetter?: () => string;
  readonly previewSecret?: string;
  readonly lane?: string;
}): Promise<ModelsDevCatalogFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? MODELS_DEV_TIMEOUT_MS);
  const region = options.region ?? getRuntimeRegion();
  const location =
    region === 'cn'
      ? await fetchModelsDevDescriptor({
          fetchImpl,
          originGetter: options.descriptorOriginGetter,
          signal,
          previewSecret: options.previewSecret,
          lane: options.lane,
        })
      : { catalogUrl: MODELS_DEV_URL, iconBaseUrl: MODELS_DEV_ICON_BASE_URL };
  const response = await fetchImpl(location.catalogUrl, {
    headers: modelsDevCatalogRequestHeaders(region, options.etag),
    ...(region === 'cn' ? { redirect: 'error' as const } : {}),
    signal,
  });
  if (response.status === 304) return { kind: 'not_modified' };
  if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
  const catalog = await response.json();
  if (!isRecord(catalog)) throw new Error('models.dev returned an invalid catalog');
  const etag = response.headers.get('etag')?.trim();
  return {
    kind: 'updated',
    catalog,
    ...(etag ? { etag } : {}),
    iconBaseUrl: location.iconBaseUrl,
  };
}

function modelsDevCatalogRequestHeaders(
  region: ModelsDevRegion,
  etag: string | undefined,
): Record<string, string> {
  return {
    accept: 'application/json',
    ...(region !== 'cn' && etag ? { 'if-none-match': etag } : {}),
  };
}

async function fetchModelsDevDescriptor(options: {
  readonly fetchImpl: typeof fetch;
  readonly originGetter?: () => string;
  readonly signal: AbortSignal;
  readonly previewSecret?: string;
  readonly lane?: string;
}): Promise<{ readonly catalogUrl: string; readonly iconBaseUrl: string }> {
  const response = await options.fetchImpl(
    new URL(MODELS_DEV_DESCRIPTOR_PATH, (options.originGetter ?? resolveCommonConfigOrigin)()),
    {
      headers: commonConfigRequestHeaders(options.previewSecret, options.lane),
      redirect: 'error',
      signal: options.signal,
    },
  );
  if (!response.ok) throw new Error(`models.dev descriptor returned HTTP ${response.status}`);
  const body = await response.json();
  const catalogUrl = isRecord(body) ? stringValue(body.catalog_url) : undefined;
  const iconBaseUrl = isRecord(body) ? stringValue(body.icon_base_url) : undefined;
  const catalogLocation = catalogUrl
    ? parseMirroredReleaseUrl(catalogUrl, MIRROR_CATALOG_PATH)
    : undefined;
  const iconLocation = iconBaseUrl
    ? parseMirroredReleaseUrl(iconBaseUrl, MIRROR_ICON_PATH)
    : undefined;
  if (!catalogLocation || !iconLocation || catalogLocation.sha !== iconLocation.sha) {
    throw new Error('models.dev descriptor returned invalid URLs');
  }
  return { catalogUrl: catalogLocation.url, iconBaseUrl: iconLocation.url };
}

export async function fetchPinnedProviderIdsConfig(options: {
  readonly fetchImpl?: typeof fetch;
  readonly originGetter?: () => string;
  readonly timeoutMs?: number;
  readonly previewSecret?: string;
  readonly lane?: string;
}): Promise<unknown> {
  const origin = (options.originGetter ?? resolveCommonConfigOrigin)();
  const url = new URL(COMMON_CONFIG_PATH, origin);
  url.searchParams.set('filter', PINNED_PROVIDER_IDS_CONFIG_KEY);
  url.searchParams.set('client', 'desktop');
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: commonConfigRequestHeaders(options.previewSecret, options.lane),
    signal: AbortSignal.timeout(options.timeoutMs ?? COMMON_CONFIG_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`common_config returned HTTP ${response.status}`);
  const body = await response.json();
  assertCommonConfigBusinessSuccess(body);
  const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
  return data?.[PINNED_PROVIDER_IDS_CONFIG_KEY];
}

function resolveCommonConfigOrigin(): string {
  const minimax = DEFAULT_MODEL_PRESETS[getRuntimePresetKey()].provider.minimax;
  const baseUrl = minimax?.options?.baseURL;
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new Error('Runtime MiniMax preset has no base URL');
  }
  return new URL(baseUrl).origin;
}

function commonConfigRequestHeaders(
  previewSecret: string | undefined,
  lane: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (previewSecret?.trim()) {
    headers['X-Minimax-Agent-Preview-Secret'] = previewSecret.trim();
  }
  if (lane?.trim()) {
    headers.lane = lane.trim();
    headers.bedrock_lane = lane.trim();
    headers['bedrock-lane'] = lane.trim();
  }
  return headers;
}

function assertCommonConfigBusinessSuccess(value: unknown): void {
  if (!isRecord(value)) return;
  const statusInfo = isRecord(value.statusInfo) ? value.statusInfo : undefined;
  const baseResponse = isRecord(value.base_resp) ? value.base_resp : undefined;
  if (
    (typeof statusInfo?.code === 'number' && statusInfo.code !== 0) ||
    (typeof baseResponse?.status_code === 'number' && baseResponse.status_code !== 0)
  ) {
    throw new Error('common_config returned a business error');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseMirroredReleaseUrl(
  value: string,
  pathPattern: RegExp,
): { readonly url: string; readonly sha: string } | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== MODELS_DEV_MIRROR_HOST ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    const match = pathPattern.exec(url.pathname);
    return match?.[1] ? { url: url.toString(), sha: match[1] } : undefined;
  } catch {
    return undefined;
  }
}
