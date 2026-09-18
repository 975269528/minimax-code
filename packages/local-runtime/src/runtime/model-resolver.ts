import { ThinkingLevel, type IAgentConfig, type IModelRef } from '@mavis/protocol';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ThinkingLevel as PiThinkingLevel } from '@earendil-works/pi-agent-core';
import type { LLMModelConfig } from '@mavis/agent-core/pi-turn-runner';
import { withOpenCodeGoHeaders, withOpenRouterAttributionHeaders } from '@mavis/shared';
import { logger } from '../common/logger.js';
import {
  isManagedProviderBaseUrl,
  resolveProviderAuthMode,
  type ProviderAuthMode,
  type ProviderAuthModeSource,
} from '@mavis/config';
import type { LocalModelsConfig, LocalProviderOptions } from '../config/types.js';
import { parseProviderId } from '../config/model-key.js';
import {
  allowsManagedMinimaxProxy,
  buildLocalProviderHeaders,
  normalizeManagedMinimaxProxyBaseUrl,
  normalizeMessagesBaseUrlForPi,
  providerRouteForAuthMode,
  readAgentHeaderId,
  stripUrlCredentials,
} from './model-resolver-helpers.js';
import type { LocalRuntimeRoutingOptions } from './routing-headers.js';
import {
  planCustomProviderResolution,
  planMinimaxApiResolution,
  readStringRecord,
  resolveByokResolutionPlan,
  type LocalByokProviderConfig,
} from './model-resolver-byok.js';
import { hasOpenPlatformThinkingVariants } from './openplatform-thinking-patcher.js';
import { LocalDynamicMaxTokensState } from './dynamic-max-tokens.js';
import { composeLocalModelStream } from './model-stream-composition.js';
import { resolveModelThinkingProtocol } from '../model-provider/thinking.js';
import type { ModelProviderApi } from '../model-provider/provider-request.js';
import type {
  LocalModelResolveInput,
  LocalModelResolverLike,
  LocalResolvedModelConfig,
  LocalRuntimeAuthContext,
} from './model-resolver-contract.js';
import { lookupLocalCatalogModel, lookupLocalModelLimits } from './model-catalog.js';
import { readSelectedThinkingEffort } from '../model-provider/model-selection.js';
import { resolveLocalModelCompatibility } from './model-resolver-compat.js';

export type {
  LocalModelResolveInput,
  LocalModelResolverLike,
  LocalResolvedModelConfig,
  LocalRuntimeAuthContext,
} from './model-resolver-contract.js';

export type { LocalByokProviderConfig } from './model-resolver-byok.js';

export { lookupLocalModelLimits } from './model-catalog.js';

export const DEFAULT_LOCAL_PI_API: Api = 'anthropic-messages';
export const MANAGED_PROVIDER_API_KEY_PLACEHOLDER = 'sk-xxx';
export const MANAGED_PROVIDER_USER_AGENT = 'MiniMaxAgent';
const OPENAI_CODEX_PROVIDER = 'openai-codex';

const THINKING_LEVEL_TO_PI: Record<ThinkingLevel, PiThinkingLevel> = {
  [ThinkingLevel.OFF]: 'off',
  [ThinkingLevel.MINIMAL]: 'minimal',
  [ThinkingLevel.LOW]: 'low',
  [ThinkingLevel.MEDIUM]: 'medium',
  [ThinkingLevel.HIGH]: 'high',
  [ThinkingLevel.XHIGH]: 'xhigh',
};

export interface LocalModelResolverOptions extends LocalRuntimeRoutingOptions {
  providerConfig?: LocalModelsConfig;
  providerConfigGetter?: () => LocalModelsConfig;
  /** BYOK trees (`minimax_api`, `custom_provider`) for source-aware model keys. */
  byokConfigGetter?: () => LocalByokProviderConfig | undefined;
  authContextGetter?: () => LocalRuntimeAuthContext | undefined;
  providerAuthGetter?: (provider: string) => Promise<string | undefined> | string | undefined;
  defaultApi?: Api;
  dynamicMaxTokensState?: LocalDynamicMaxTokensState;
  streamFn?: LLMModelConfig['streamFn'];
  fetchImpl?: LLMModelConfig['fetch'];
  /** Enables metadata-free custom-provider thinking only for the new TUI product. */
  implicitCustomProviderThinking?: boolean;
}

export function resolveLocalProviderCredentials(
  provider: string,
  modelRef: IModelRef,
  providerConfig?: LocalModelsConfig,
  authContext?: LocalRuntimeAuthContext,
): {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  rawProviderOptions?: LocalProviderOptions;
  authMode: ProviderAuthMode;
  authModeSource: ProviderAuthModeSource;
  managedBaseURL: boolean;
  warnings: string[];
} {
  const refKey = modelRef.api_key?.trim();
  const refBaseUrl = modelRef.base_url?.trim();
  const cfg = providerConfig?.[provider];
  const opts = cfg?.options;
  const baseUrl = normalizeManagedMinimaxProxyBaseUrl(provider, refBaseUrl || opts?.baseURL);
  // Header config has two user-authored layers in config.yaml:
  // provider.options.headers are defaults for every model under the provider,
  // while provider.models.<model_id>.headers are per-model overrides.
  const optionHeaders = readStringRecord(opts?.headers);
  const modelHeaders = readStringRecord(cfg?.models?.[modelRef.model_id?.trim() ?? '']?.headers);
  const authModeResolution = resolveProviderAuthMode({
    authMode: opts?.authMode,
    baseURL: baseUrl,
    allowManagedBaseURLOverride: allowsManagedMinimaxProxy(provider),
  });
  const normalizedBaseUrl =
    baseUrl && authModeResolution.managedBaseURL ? stripUrlCredentials(baseUrl) : baseUrl;
  const accessToken = authContext?.accessToken?.trim();
  const managedHeaders =
    authModeResolution.authMode === 'managed-login' && accessToken
      ? { Authorization: `Bearer ${accessToken}` }
      : undefined;
  // Merge order is intentional:
  // 1. provider-level config defaults
  // 2. model-level config overrides
  // 3. managed runtime auth headers
  // Runtime identity headers are added later by buildLocalProviderHeaders().
  return {
    apiKey:
      refKey ||
      (typeof opts?.apiKey === 'string' && opts.apiKey.length > 0
        ? opts.apiKey
        : authModeResolution.authMode === 'managed-login'
          ? MANAGED_PROVIDER_API_KEY_PLACEHOLDER
          : undefined),
    baseUrl: normalizedBaseUrl,
    ...(optionHeaders || modelHeaders || managedHeaders
      ? { headers: { ...optionHeaders, ...modelHeaders, ...managedHeaders } }
      : {}),
    ...(opts ? { rawProviderOptions: opts } : {}),
    authMode: authModeResolution.authMode,
    authModeSource: authModeResolution.source,
    managedBaseURL: authModeResolution.managedBaseURL,
    warnings: authModeResolution.warnings,
  };
}

export class LocalModelResolver implements LocalModelResolverLike {
  private readonly providerConfig: LocalModelsConfig | undefined;
  private readonly providerConfigGetter: (() => LocalModelsConfig) | undefined;
  private readonly byokConfigGetter: (() => LocalByokProviderConfig | undefined) | undefined;
  private readonly authContextGetter: (() => LocalRuntimeAuthContext | undefined) | undefined;
  private readonly providerAuthGetter:
    | ((provider: string) => Promise<string | undefined> | string | undefined)
    | undefined;
  private readonly defaultApi: Api;
  private readonly dynamicMaxTokensState: LocalDynamicMaxTokensState | undefined;
  private readonly transport: Pick<LLMModelConfig, 'streamFn' | 'fetch'>;

  constructor(private readonly options: LocalModelResolverOptions = {}) {
    this.providerConfig = options.providerConfig;
    this.providerConfigGetter = options.providerConfigGetter;
    this.byokConfigGetter = options.byokConfigGetter;
    this.authContextGetter = options.authContextGetter;
    this.providerAuthGetter = options.providerAuthGetter;
    this.defaultApi = options.defaultApi ?? DEFAULT_LOCAL_PI_API;
    this.dynamicMaxTokensState = options.dynamicMaxTokensState;
    this.transport = { streamFn: options.streamFn, fetch: options.fetchImpl };
  }

  async resolveModel(input: LocalModelResolveInput): Promise<LocalResolvedModelConfig> {
    const modelRef = (input.agentConfig as IAgentConfig).model;
    if (!modelRef) {
      throw new Error('LocalModelResolver: agentConfig.model is required');
    }
    const provider = modelRef.provider?.trim() ?? '';
    const modelId = modelRef.model_id?.trim() ?? '';
    if (!provider) throw new Error('LocalModelResolver: ModelRef.provider is required');
    if (!modelId) throw new Error('LocalModelResolver: ModelRef.model_id is required');

    const providerConfig = this.providerConfigGetter?.() ?? this.providerConfig;
    const parsed = parseProviderId(provider);
    if (parsed && parsed.source !== 'provider') {
      const byok = this.byokConfigGetter?.();
      const plan =
        parsed.source === 'minimax_api'
          ? planMinimaxApiResolution({
              byok,
              providerConfig,
              modelId,
              catalog: lookupLocalModelLimits('minimax', modelId),
            })
          : planCustomProviderResolution({
              byok,
              provider,
              providerKey: parsed.providerKey,
              modelId,
            });
      if (plan) {
        const route = parsed.source === 'minimax_api' ? 'minimax_api' : 'custom_provider';
        const resolvedPlan = await resolveByokResolutionPlan(plan, this.providerAuthGetter);
        logger.info(
          { provider, modelId, route, source: parsed.source },
          `[model-resolve-route] ${route} — resolved via source-qualified key`,
        );
        return this.finishResolve({
          sessionId: input.sessionId,
          agentConfig: input.agentConfig,
          modelRef,
          modelId,
          managedProvider: false,
          byokProvider: true,
          customProvider: parsed.source === 'custom_provider' && !plan.authProvider,
          ...(plan.runtimeProvider
            ? { catalogModel: lookupLocalCatalogModel(plan.runtimeProvider, modelId) }
            : {}),
          ...resolvedPlan,
        });
      }
      throw new Error(
        `LocalModelResolver: BYOK model configuration "${provider}/${modelId}" is unavailable or disabled.`,
      );
    }

    // Source-aware routing: when minimaxModelSource is 'minimax_api_key',
    // route minimax models through the user's own API key instead of managed-login.
    if (provider === 'minimax') {
      const byok = this.byokConfigGetter?.();
      if (byok?.minimaxModelSource === 'minimax_api_key') {
        const plan = planMinimaxApiResolution({
          byok,
          providerConfig,
          modelId,
          catalog: lookupLocalModelLimits('minimax', modelId),
        });
        if (plan) {
          logger.info(
            {
              provider,
              modelId,
              route: 'minimax_api_key',
              minimaxModelSource: byok.minimaxModelSource,
            },
            '[model-resolve-route] minimax_api_key — minimax model routed through user API key',
          );
          const resolvedPlan = await resolveByokResolutionPlan(plan, this.providerAuthGetter);
          return this.finishResolve({
            sessionId: input.sessionId,
            agentConfig: input.agentConfig,
            modelRef,
            modelId,
            managedProvider: false,
            byokProvider: true,
            customProvider: false,
            ...resolvedPlan,
          });
        }
        throw new Error(
          `LocalModelResolver: BYOK model configuration "minimax_api/${modelId}" is unavailable or disabled.`,
        );
      } else if (byok && !byok.minimaxModelSource) {
        logger.info(
          { provider, modelId, minimaxModelSource: byok.minimaxModelSource },
          '[model-resolve-route] minimaxModelSource not set — using builtin provider',
        );
      }
    }

    const credentials = resolveLocalProviderCredentials(
      provider,
      modelRef,
      providerConfig,
      this.authContextGetter?.(),
    );
    const limits = lookupLocalModelLimits(provider, modelId);
    const isOpenAiCodex = provider === OPENAI_CODEX_PROVIDER;
    const providerAuthKey = isOpenAiCodex
      ? (await this.providerAuthGetter?.(provider))?.trim()
      : undefined;
    const apiKey = isOpenAiCodex ? providerAuthKey : credentials.apiKey;
    const baseUrl = credentials.baseUrl ?? (isOpenAiCodex ? limits.baseUrl : undefined);
    if (!apiKey) {
      if (provider === OPENAI_CODEX_PROVIDER) {
        throw new Error(
          `LocalModelResolver: openai-codex login required; no OAuth credentials found.`,
        );
      }
      throw new Error(`LocalModelResolver: api_key not configured for provider "${provider}".`);
    }
    if (!baseUrl) {
      throw new Error(`LocalModelResolver: base_url not configured for provider "${provider}".`);
    }
    if (
      credentials.authMode === 'managed-login' &&
      !credentials.managedBaseURL &&
      !allowsManagedMinimaxProxy(provider)
    ) {
      throw new Error(
        `LocalModelResolver: managed-login requires a known managed base_url for provider "${provider}".`,
      );
    }
    if (
      credentials.authMode === 'managed-login' &&
      apiKey === MANAGED_PROVIDER_API_KEY_PLACEHOLDER &&
      !credentials.headers?.Authorization
    ) {
      throw new Error(
        `LocalModelResolver: managed OAuth bearer is not synced for provider "${provider}".`,
      );
    }
    const route = providerRouteForAuthMode(credentials.authMode);
    logger.info(
      { provider, modelId, route, authMode: credentials.authMode },
      `[model-resolve-route] ${route} — resolved via builtin provider credentials`,
    );
    return this.finishResolve({
      sessionId: input.sessionId,
      agentConfig: input.agentConfig,
      modelRef,
      provider,
      modelId,
      api: limits.api ?? this.defaultApi,
      apiKey,
      baseUrl,
      contextWindow: limits.contextWindow,
      maxTokens: limits.maxTokens,
      managedProvider: credentials.authMode === 'managed-login',
      byokProvider: credentials.authMode === 'oauth',
      customProvider: false,
      configHeaders: credentials.headers,
      catalogModel: lookupLocalCatalogModel(provider, modelId),
    });
  }

  private finishResolve(input: {
    sessionId: string;
    agentConfig: IAgentConfig;
    modelRef: IModelRef;
    provider: string;
    modelId: string;
    api: Api;
    apiKey: string;
    baseUrl: string;
    contextWindow: number;
    maxTokens: number;
    managedProvider: boolean;
    byokProvider: boolean;
    customProvider: boolean;
    runtimeProvider?: string;
    configHeaders?: Record<string, string>;
    catalogModel?: Model<Api>;
  }): LocalResolvedModelConfig {
    const { modelRef } = input;
    const effectiveContextWindow =
      typeof modelRef.context_window === 'number' && modelRef.context_window > 0
        ? modelRef.context_window
        : input.contextWindow;
    const effectiveMaxTokens =
      typeof modelRef.max_tokens === 'number' && modelRef.max_tokens > 0
        ? modelRef.max_tokens
        : input.maxTokens;
    const supportImage = !!modelRef.capabilities?.support_image;
    const supportVideo = !!modelRef.capabilities?.support_video;
    const effectiveApi = input.api;
    const thinkingLevel = modelRef.thinking_level;
    const thinkingToggleOn = thinkingLevel !== undefined && thinkingLevel !== ThinkingLevel.OFF;
    const selectedEffort = readSelectedThinkingEffort(
      modelRef.capabilities as Record<string, unknown> | undefined,
    );
    const providerApi =
      effectiveApi === 'anthropic-messages' ||
      effectiveApi === 'openai-completions' ||
      effectiveApi === 'openai-responses'
        ? (effectiveApi as ModelProviderApi)
        : undefined;
    const protocolThinking =
      input.customProvider && providerApi && thinkingToggleOn
        ? resolveModelThinkingProtocol(providerApi, selectedEffort, input.modelId)
        : undefined;
    const hasOpenPlatformThinking = hasOpenPlatformThinkingVariants(modelRef);
    const isImplicitCustomProvider =
      this.options.implicitCustomProviderThinking === true &&
      parseProviderId(input.provider)?.source === 'custom_provider';
    const thinkingOn = input.customProvider
      ? hasOpenPlatformThinking
        ? thinkingToggleOn
        : protocolThinking
          ? protocolThinking.enabled !== false
          : isImplicitCustomProvider && thinkingToggleOn
      : thinkingToggleOn;
    const reasoningCapable = thinkingOn;
    const shouldPassThinkingLevel =
      thinkingOn &&
      (protocolThinking !== undefined ||
        effectiveApi !== 'anthropic-messages' ||
        hasOpenPlatformThinking ||
        isImplicitCustomProvider);
    const piThinkingLevel =
      protocolThinking?.piLevel ??
      (thinkingOn
        ? ((selectedEffort as PiThinkingLevel | undefined) ??
          (thinkingLevel !== undefined ? THINKING_LEVEL_TO_PI[thinkingLevel] : undefined))
        : undefined);
    const catalogMaxThinkingLevel =
      selectedEffort === 'max' && typeof input.catalogModel?.thinkingLevelMap?.max === 'string'
        ? input.catalogModel.thinkingLevelMap.max
        : undefined;
    const thinkingLevelMap = thinkingOn
      ? (protocolThinking?.thinkingLevelMap ??
        (catalogMaxThinkingLevel ? { max: catalogMaxThinkingLevel } : undefined))
      : undefined;
    const forceAdaptiveThinking =
      (thinkingOn && protocolThinking?.forceAdaptiveThinking === true) ||
      (effectiveApi === 'anthropic-messages' && hasOpenPlatformThinking && thinkingOn);
    const completionsThinkingCompat =
      thinkingOn && protocolThinking?.completionsThinkingFormat === 'openai'
        ? { thinkingFormat: 'openai' as const, supportsReasoningEffort: true }
        : undefined;
    const compat = resolveLocalModelCompatibility({
      api: effectiveApi,
      provider: input.provider,
      forceAdaptiveThinking,
      completionsThinkingCompat,
    });

    const resolvedBaseUrl =
      effectiveApi === 'anthropic-messages'
        ? normalizeMessagesBaseUrlForPi(input.baseUrl)
        : input.baseUrl.replace(/\/+$/u, '');
    const headers = buildLocalProviderHeaders({
      headers: withOpenCodeGoHeaders(
        resolvedBaseUrl,
        withOpenRouterAttributionHeaders(resolvedBaseUrl, input.configHeaders),
        input.sessionId,
      ),
      managedProvider: input.managedProvider,
      routingContext: this.options.routingContextGetter?.(),
      sessionId: input.sessionId,
      agentId: readAgentHeaderId(input.agentConfig),
    });

    const maskedKey =
      input.apiKey.length > 10
        ? `${input.apiKey.slice(0, 5)}****${input.apiKey.slice(-4)}`
        : input.apiKey.length > 4
          ? `${input.apiKey.slice(0, 3)}****`
          : '****';
    logger.info(
      {
        sessionId: input.sessionId,
        provider: input.runtimeProvider ?? input.provider,
        modelId: input.modelId,
        api: effectiveApi,
        baseUrl: resolvedBaseUrl,
        maskedApiKey: maskedKey,
        managed: input.managedProvider,
        contextWindow: effectiveContextWindow,
        maxTokens: effectiveMaxTokens,
        reasoning: thinkingOn,
      },
      `[model-resolve] provider=${input.provider} model=${input.modelId} api=${effectiveApi} baseUrl=${resolvedBaseUrl} key=${maskedKey} managed=${input.managedProvider}`,
    );

    const streamFn = composeLocalModelStream(
      this.transport.streamFn,
      this.dynamicMaxTokensState,
      input.sessionId,
      input.byokProvider ? input.provider : undefined,
      this.transport.fetch,
    );

    return {
      model: {
        id: input.modelId,
        name: input.modelId,
        api: effectiveApi,
        provider: input.runtimeProvider ?? input.provider,
        baseUrl: resolvedBaseUrl,
        reasoning: reasoningCapable,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        input: supportVideo || supportImage ? ['text', 'image'] : ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: effectiveContextWindow,
        maxTokens: effectiveMaxTokens,
        ...(compat ? { compat } : {}),
      } as Model<Api>,
      apiKey: input.apiKey,
      maxTokens: effectiveMaxTokens,
      streamFn,
      ...(this.transport.fetch ? { fetch: this.transport.fetch } : {}),
      managedProvider: input.managedProvider,
      ...(headers ? { headers } : {}),
      ...(shouldPassThinkingLevel ? { thinkingLevel: piThinkingLevel } : {}),
    };
  }
}

export { isManagedProviderBaseUrl };
