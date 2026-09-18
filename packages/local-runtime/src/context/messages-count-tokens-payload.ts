import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  Api,
  CacheRetention,
  Context,
  Model,
  SimpleStreamOptions,
  Tool,
} from '@earendil-works/pi-ai';
import {
  convertMessages,
  convertTools,
  toProviderMessages,
} from './messages-count-tokens-messages.js';
import {
  isMessagesOAuthToken,
  sanitizeSurrogates,
  type MessagesMessageParam,
  type MessagesTextBlock,
  type MessagesToolParam,
  type CacheControlEphemeral,
} from './messages-count-tokens-wire.js';

/**
 * count_tokens request body. The Messages-compatible schema accepts only model / messages / system
 * / tools / thinking (+ tool_choice). Request-only fields such as max_tokens / temperature /
 * output_config and tools' eager_input_streaming do not affect input token counts and cause 400
 * errors on strict endpoints, so strip them at the boundary. Retain `stream: false` to explicitly
 * mark a non-streaming call. messages / system / tools / thinking still match the real
 * Messages-compatible request shape.
 */
export interface MessagesCountTokensRequestBody {
  model: string;
  messages: MessagesMessageParam[];
  stream: false;
  system?: MessagesTextBlock[];
  tools?: MessagesToolParam[];
  thinking?: unknown;
  tool_choice?: unknown;
}

/** For internal construction: full params matching the actual Messages-compatible request shape. */
interface MessagesRequestParams {
  model: string;
  messages: MessagesMessageParam[];
  max_tokens: number;
  stream: true;
  system?: MessagesTextBlock[];
  temperature?: number;
  tools?: MessagesToolParam[];
  thinking?: unknown;
  output_config?: unknown;
}

export interface MessagesCountTokensBuildOptions {
  apiKey?: string;
  maxTokens?: number;
  cacheRetention?: CacheRetention;
  thinkingLevel?: SimpleStreamOptions['reasoning'] | 'off';
}

interface MessagesPayloadOptions {
  maxTokens?: number;
  cacheRetention?: CacheRetention;
  thinkingEnabled?: boolean;
  thinkingBudgetTokens?: number;
  effort?: string;
  thinkingDisplay?: 'summarized' | 'omitted';
}

export function buildMessagesCountTokensRequestBody(
  messages: AgentMessage[],
  systemPrompt: string | undefined,
  model: Model<Api>,
  tools?: Tool[],
  options: MessagesCountTokensBuildOptions = {},
): MessagesCountTokensRequestBody {
  const context: Context = {
    systemPrompt,
    messages: toProviderMessages(messages, model),
    tools,
  };
  const params = buildMessagesParams(
    model as Model<'anthropic-messages'>,
    context,
    isMessagesOAuthToken(options.apiKey ?? ''),
    buildMessagesOptionsFromSimple(model as Model<'anthropic-messages'>, options),
  );
  return {
    model: params.model,
    messages: params.messages,
    stream: false,
    ...(params.system ? { system: params.system } : {}),
    ...(params.tools
      ? {
          tools: params.tools.map(
            ({ eager_input_streaming: _eagerInputStreaming, ...tool }) => tool,
          ),
        }
      : {}),
    ...(params.thinking !== undefined ? { thinking: params.thinking } : {}),
  };
}

/**
 * Convert the exact generation payload captured by `onPayload` into the
 * strict count_tokens schema while preserving its input-bearing fields.
 */
export function buildMessagesCountTokensRequestBodyFromProviderPayload(
  payload: unknown,
): MessagesCountTokensRequestBody | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.model !== 'string' || !Array.isArray(record.messages)) return undefined;

  return {
    model: record.model,
    messages: record.messages as MessagesMessageParam[],
    stream: false,
    ...(Array.isArray(record.system) ? { system: record.system as MessagesTextBlock[] } : {}),
    ...(Array.isArray(record.tools)
      ? {
          tools: (record.tools as MessagesToolParam[]).map(
            ({ eager_input_streaming: _eagerInputStreaming, ...tool }) => tool,
          ),
        }
      : {}),
    ...(record.thinking === undefined ? {} : { thinking: record.thinking }),
    ...(record.tool_choice === undefined ? {} : { tool_choice: record.tool_choice }),
  };
}

function buildMessagesOptionsFromSimple(
  model: Model<'anthropic-messages'>,
  options: MessagesCountTokensBuildOptions,
): MessagesPayloadOptions {
  const base: MessagesPayloadOptions = {
    maxTokens: options.maxTokens,
    cacheRetention: options.cacheRetention,
  };
  const reasoning =
    options.thinkingLevel && options.thinkingLevel !== 'off' ? options.thinkingLevel : undefined;
  if (!reasoning) return { ...base, thinkingEnabled: false };
  if (model.compat?.forceAdaptiveThinking === true) {
    return {
      ...base,
      thinkingEnabled: true,
      effort: mapThinkingLevelToEffort(model, reasoning),
    };
  }
  const adjusted = adjustMaxTokensForThinking(base.maxTokens, model.maxTokens, reasoning);
  return {
    ...base,
    maxTokens: adjusted.maxTokens,
    thinkingEnabled: true,
    thinkingBudgetTokens: adjusted.thinkingBudget,
  };
}

function buildMessagesParams(
  model: Model<'anthropic-messages'>,
  context: Context,
  isOAuthToken: boolean,
  options: MessagesPayloadOptions,
): MessagesRequestParams {
  const { cacheControl } = getCacheControl(model, options.cacheRetention);
  const compat = getMessagesCompat(model);
  const params: MessagesRequestParams = {
    model: model.id,
    messages: convertMessages(
      context.messages,
      model,
      isOAuthToken,
      cacheControl,
      compat.allowEmptySignature,
    ),
    max_tokens: options.maxTokens ?? model.maxTokens,
    stream: true,
  };

  if (isOAuthToken) {
    params.system = [
      {
        type: 'text',
        text: 'hi',
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      },
    ];
    if (context.systemPrompt) {
      params.system.push({
        type: 'text',
        text: sanitizeSurrogates(context.systemPrompt),
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      });
    }
  } else if (context.systemPrompt) {
    params.system = [
      {
        type: 'text',
        text: sanitizeSurrogates(context.systemPrompt),
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      },
    ];
  }

  if (context.tools && context.tools.length > 0) {
    params.tools = convertTools(
      context.tools,
      isOAuthToken,
      compat.supportsEagerToolInputStreaming,
      compat.supportsCacheControlOnTools ? cacheControl : undefined,
    );
  }

  if (model.reasoning) {
    if (options.thinkingEnabled) {
      const display = options.thinkingDisplay ?? 'summarized';
      if (model.compat?.forceAdaptiveThinking === true) {
        params.thinking = { type: 'adaptive', display };
        if (options.effort) params.output_config = { effort: options.effort };
      } else {
        params.thinking = {
          type: 'enabled',
          budget_tokens: options.thinkingBudgetTokens || 1024,
          display,
        };
      }
    } else if (options.thinkingEnabled === false) {
      params.thinking = { type: 'disabled' };
    }
  }

  return params;
}

function getCacheControl(
  model: Model<'anthropic-messages'>,
  cacheRetention?: CacheRetention,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
  const retention =
    cacheRetention ?? (process.env.PI_CACHE_RETENTION === 'long' ? 'long' : 'short');
  if (retention === 'none') return { retention };
  const ttl =
    retention === 'long' && getMessagesCompat(model).supportsLongCacheRetention ? '1h' : undefined;
  return {
    retention,
    cacheControl: { type: 'ephemeral', ...(ttl ? { ttl } : {}) },
  };
}

function getMessagesCompat(model: Model<'anthropic-messages'>) {
  const isFireworks = model.provider === 'fireworks';
  const isCloudflareAiGatewayMessages =
    model.provider === 'cloudflare-ai-gateway' && model.baseUrl.includes('anthropic');
  return {
    supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? !isFireworks,
    supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? !isFireworks,
    sendSessionAffinityHeaders:
      model.compat?.sendSessionAffinityHeaders ?? !!(isFireworks || isCloudflareAiGatewayMessages),
    supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? !isFireworks,
    supportsTemperature: model.compat?.supportsTemperature ?? true,
    allowEmptySignature: model.compat?.allowEmptySignature ?? false,
  };
}

function adjustMaxTokensForThinking(
  baseMaxTokens: number | undefined,
  modelMaxTokens: number,
  reasoningLevel: NonNullable<SimpleStreamOptions['reasoning']>,
): { maxTokens: number; thinkingBudget: number } {
  const budgets = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
  };
  const minOutputTokens = 1024;
  const level = reasoningLevel === 'xhigh' || reasoningLevel === 'max' ? 'high' : reasoningLevel;
  let thinkingBudget = budgets[level]!;
  const maxTokens =
    baseMaxTokens === undefined
      ? modelMaxTokens
      : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);
  if (maxTokens <= thinkingBudget) thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
  return { maxTokens, thinkingBudget };
}

function mapThinkingLevelToEffort(
  model: Model<'anthropic-messages'>,
  level: SimpleStreamOptions['reasoning'],
): string {
  const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
  if (typeof mapped === 'string') return mapped;
  switch (level) {
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    default:
      return 'high';
  }
}
