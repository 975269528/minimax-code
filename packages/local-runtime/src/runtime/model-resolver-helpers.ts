import type { IAgentConfig } from '@mavis/protocol';
import type { Api, Model } from '@earendil-works/pi-ai';
import { allowsManagedMinimaxProviderOverride, type ProviderAuthMode } from '@mavis/config';

import { MANAGED_PROVIDER_USER_AGENT } from './model-resolver.js';
import {
  managedBackendRoutingHeaders,
  type LocalRuntimeRoutingContext,
} from './routing-headers.js';

export function allowsManagedMinimaxProxy(provider: string): boolean {
  return provider === 'minimax' && allowsManagedMinimaxProviderOverride();
}

export function providerRouteForAuthMode(authMode: ProviderAuthMode): string {
  if (authMode === 'managed-login') return 'token_plan';
  if (authMode === 'oauth') return 'oauth';
  return 'provider_api_key';
}

export function normalizeManagedMinimaxProxyBaseUrl(
  provider: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (!allowsManagedMinimaxProxy(provider)) return value;
  const trimmed = value.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed)) {
    return trimmed;
  }
  const candidate = `http://${trimmed}`;
  try {
    return new URL(candidate).hostname ? candidate : trimmed;
  } catch {
    return trimmed;
  }
}

export function buildLocalProviderHeaders(input: {
  headers?: Record<string, string>;
  managedProvider: boolean;
  routingContext?: LocalRuntimeRoutingContext;
  sessionId: string;
  agentId: string;
}): Record<string, string> | undefined {
  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    'X-Mavis-Session-Id': input.sessionId,
    'X-Mavis-Agent-Id': input.agentId,
    'X-Mavis-Timezone-Offset': String(new Date().getTimezoneOffset() * -60),
  };
  // Lane selection is trusted local-runtime state, never provider/user input.
  // Strip both historical spellings for every provider so BYOK/custom
  // endpoints cannot receive a managed routing header accidentally.
  for (const key of Object.keys(headers)) {
    const normalized = key.toLowerCase();
    if (normalized === 'bedrock-lane' || normalized === 'bedrock_lane') delete headers[key];
  }
  if (input.managedProvider) {
    headers['User-Agent'] = MANAGED_PROVIDER_USER_AGENT;
    Object.assign(headers, managedBackendRoutingHeaders(input.routingContext));
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function readAgentHeaderId(agentConfig: IAgentConfig): string {
  const id = agentConfig.agent_id;
  if (typeof id === 'string' && id.trim()) return id.trim();
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return 'main';
}

export function stripUrlCredentials(value: string): string {
  try {
    const parsed = new URL(value);
    if (!parsed.username && !parsed.password) return value;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return value;
  }
}

export function normalizeMessagesBaseUrlForPi(baseUrl: string): string {
  let normalized = baseUrl.replace(/\/+$/u, '');
  if (normalized.endsWith('/v1/messages')) {
    normalized = normalized.slice(0, -'/v1/messages'.length);
  } else if (normalized.endsWith('/messages')) {
    normalized = normalized.slice(0, -'/messages'.length);
  } else if (normalized.endsWith('/v1')) {
    normalized = normalized.slice(0, -'/v1'.length);
  }
  return normalized;
}

export function deriveModelInput(input: {
  supportImage: boolean;
  supportVideo: boolean;
}): Model<Api>['input'] {
  if (input.supportVideo || input.supportImage) return ['text', 'image'];
  return ['text'];
}
