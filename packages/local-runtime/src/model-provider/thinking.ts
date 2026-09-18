import type { ThinkingLevelMap } from '@earendil-works/pi-ai';
import type { ThinkingLevel as PiThinkingLevel } from '@earendil-works/pi-agent-core';

import type { ModelProviderApi } from './provider-request.js';

const PI_THINKING_LEVELS = new Set<string>(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export interface ModelThinkingProtocolConfig {
  effort: string;
  /** `false` keeps the selected effort for wire adaptation while disabling Pi thinking. */
  enabled?: boolean;
  piLevel: PiThinkingLevel;
  thinkingLevelMap: ThinkingLevelMap;
  requestPatch: Record<string, unknown>;
  /** Smallest max_tokens used by the connection-test request. */
  minimumMaxTokens: number;
  /** The Messages-compatible API uses adaptive thinking for an explicit effort. */
  forceAdaptiveThinking?: true;
  /** Chat Completions must stay on the top-level reasoning_effort field. */
  completionsThinkingFormat?: 'openai';
}

export const MINIMAX_M3_MODEL_ID = 'MiniMax-M3';
// Keep the adaptive-thinking probe at the same minimum usable output floor as
// normal Messages-compatible requests. Smaller caps can finish before MiniMax emits a
// Messages `content` block and make a valid key look like an invalid response.
export const MINIMAX_M3_THINKING_TEST_MAX_TOKENS = 1_024;
export type MiniMaxM3ThinkingMode = 'on' | 'off';

export function isMiniMaxM3ModelId(value: unknown): boolean {
  return (
    typeof value === 'string' && value.trim().toLowerCase() === MINIMAX_M3_MODEL_ID.toLowerCase()
  );
}

export function isMiniMaxM3ThinkingMode(value: unknown): value is MiniMaxM3ThinkingMode {
  return value === 'on' || value === 'off';
}

/** MiniMax M3 exposes an on/off control; Responses effort values do not change thinking depth. */
export function resolveMiniMaxM3ThinkingProtocol(
  api: ModelProviderApi,
  mode: MiniMaxM3ThinkingMode,
): Record<string, unknown> {
  if (api === 'openai-responses') {
    return { reasoning: { effort: mode === 'on' ? 'minimal' : 'none' } };
  }
  return { thinking: { type: mode === 'on' ? 'adaptive' : 'disabled' } };
}

export function normalizeModelThinkingEffort(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const effort = value.trim();
  return effort || undefined;
}

export function normalizeModelThinkingEffortOptions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const option = normalizeModelThinkingEffort(item);
    if (!option || seen.has(option)) continue;
    seen.add(option);
    options.push(option);
  }
  return options.length > 0 ? options : undefined;
}

/**
 * Use the higher midpoint for an even-sized ordered list. This keeps a
 * two-choice off/on model enabled until the user makes a session choice.
 */
export function resolveModelThinkingMiddleEffort(
  effortOptions: readonly string[] | undefined,
): string | undefined {
  if (!effortOptions?.length) return undefined;
  return effortOptions[Math.floor(effortOptions.length / 2)];
}

/**
 * Keep the user-defined effort value intact and use only the Provider form's
 * explicit API format to choose its wire location. The internal Pi level is a
 * transport key; thinkingLevelMap maps it back to the exact user value.
 */
export function resolveModelThinkingProtocol(
  api: ModelProviderApi,
  value: unknown,
  modelId?: unknown,
): ModelThinkingProtocolConfig | undefined {
  const effort = normalizeModelThinkingEffort(value);
  if (!effort) return undefined;

  if (isMiniMaxM3ModelId(modelId) && isMiniMaxM3ThinkingMode(effort)) {
    const piLevel: PiThinkingLevel = 'high';
    const base = {
      effort,
      enabled: effort === 'on',
      piLevel,
      thinkingLevelMap: { [piLevel]: effort },
      requestPatch: resolveMiniMaxM3ThinkingProtocol(api, effort),
      minimumMaxTokens: effort === 'on' ? MINIMAX_M3_THINKING_TEST_MAX_TOKENS : 1,
    } satisfies Omit<
      ModelThinkingProtocolConfig,
      'forceAdaptiveThinking' | 'completionsThinkingFormat'
    >;
    if (api === 'anthropic-messages') {
      return { ...base, forceAdaptiveThinking: true };
    }
    if (api === 'openai-completions') {
      return { ...base, completionsThinkingFormat: 'openai' };
    }
    return base;
  }

  const piLevel = PI_THINKING_LEVELS.has(effort) ? (effort as PiThinkingLevel) : 'high';
  const base = {
    effort,
    piLevel,
    thinkingLevelMap: { [piLevel]: effort },
    minimumMaxTokens: 1,
  } satisfies Omit<ModelThinkingProtocolConfig, 'requestPatch'>;

  if (api === 'anthropic-messages') {
    return {
      ...base,
      forceAdaptiveThinking: true,
      requestPatch: {
        thinking: { type: 'adaptive' },
        output_config: { effort },
      },
    };
  }

  if (api === 'openai-completions') {
    return {
      ...base,
      requestPatch: { reasoning_effort: effort },
      completionsThinkingFormat: 'openai',
    };
  }

  return {
    ...base,
    requestPatch: { reasoning: { effort } },
  };
}
