import { buildModelDiscoveryHeaders, providerModelsUrls } from './provider-request.js';
import type {
  DiscoveredModel,
  ModelDiscoveryClientLike,
  ModelDiscoveryResult,
  ModelDiscoveryTarget,
} from '../contracts.js';

export type {
  DiscoveredModel,
  ModelDiscoveryClientLike,
  ModelDiscoveryResult,
  ModelDiscoveryTarget,
} from '../contracts.js';

// If all candidates are missing, report only that the provider has no model-list endpoint; status codes do not help users decide.
// Product copy therefore suggests adding models manually.
const MISSING_MODELS_ENDPOINT: ModelDiscoveryResult = {
  ok: false,
  errorCode: 'models_endpoint_missing',
  errorMessage: 'Model list endpoint not found',
};

export class ModelDiscoveryClient implements ModelDiscoveryClientLike {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  // A native endpoint's 404/405 means the gateway lacks that list endpoint; continue with OpenAI-style candidates.
  // Return authentication, rate-limit, and server errors immediately so real failures are not disguised as missing endpoints.
  async discover(target: ModelDiscoveryTarget): Promise<ModelDiscoveryResult> {
    const [primaryUrl, ...fallbackUrls] = providerModelsUrls(target.api, target.baseUrl);
    const primary = await this.discoverAt(primaryUrl, target);
    if (primary.ok || !isMissingModelsEndpoint(primary)) return primary;
    for (const url of fallbackUrls) {
      const result = await this.discoverAt(url, target);
      if (result.ok || !isMissingModelsEndpoint(result)) return result;
    }
    return MISSING_MODELS_ENDPOINT;
  }

  private async discoverAt(
    url: string,
    target: ModelDiscoveryTarget,
  ): Promise<ModelDiscoveryResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: buildModelDiscoveryHeaders(target),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          errorCode: 'unauthorized',
          errorMessage: `Authentication failed (HTTP ${response.status})`,
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          errorCode: `http_${response.status}`,
          errorMessage: `HTTP ${response.status}`,
        };
      }
      const payload = await readJson(response);
      const models = readModels(payload);
      if (!models) {
        return {
          ok: false,
          errorCode: 'invalid_response',
          errorMessage: 'Invalid model discovery response',
        };
      }
      return { ok: true, models };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          ok: false,
          errorCode: 'timeout',
          errorMessage: `Request timed out after ${this.timeoutMs}ms`,
        };
      }
      return { ok: false, errorCode: 'network', errorMessage: 'Network error' };
    } finally {
      clearTimeout(timer);
    }
  }
}

function isMissingModelsEndpoint(result: ModelDiscoveryResult): boolean {
  return !result.ok && (result.errorCode === 'http_404' || result.errorCode === 'http_405');
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

function readModels(payload: unknown): DiscoveredModel[] | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  const models = data.flatMap((item): DiscoveredModel[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as { id?: unknown; name?: unknown; display_name?: unknown };
    if (typeof record.id !== 'string' || !record.id.trim()) return [];
    const displayName = readDisplayName(record);
    return [
      {
        modelId: record.id,
        ...(displayName ? { displayName } : {}),
      },
    ];
  });
  return models;
}

function readDisplayName(record: { name?: unknown; display_name?: unknown }): string | undefined {
  if (typeof record.display_name === 'string') return record.display_name;
  return typeof record.name === 'string' ? record.name : undefined;
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError',
  );
}
