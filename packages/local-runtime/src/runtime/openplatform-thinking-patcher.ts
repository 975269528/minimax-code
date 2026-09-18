import type { Api, Model } from '@earendil-works/pi-ai';
import { ThinkingLevel, type IModelRef } from '@mavis/protocol';
import { parseProviderId } from '../config/model-key.js';
import {
  isMiniMaxM3ModelId,
  isMiniMaxM3ThinkingMode,
  resolveMiniMaxM3ThinkingProtocol,
} from '../model-provider/thinking.js';
import { readSelectedThinkingEffort } from '../model-provider/model-selection.js';

export const OPENPLATFORM_THINKING_VARIANTS_CAPABILITY = 'openplatform_thinking_variants';

export interface OpenPlatformThinkingVariants {
  thinking?: Record<string, unknown>;
  'none-thinking'?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneThinkingPayload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return { ...value };
}

function patchMiniMaxM3Effort(
  payload: Record<string, unknown>,
  model: Model<Api>,
  effort: 'on' | 'off',
): Record<string, unknown> | undefined {
  if (model.api === 'openai-responses') {
    const patch = resolveMiniMaxM3ThinkingProtocol('openai-responses', effort);
    const reasoningPatch = isRecord(patch.reasoning) ? patch.reasoning : {};
    payload.reasoning = {
      ...(isRecord(payload.reasoning) ? payload.reasoning : {}),
      ...reasoningPatch,
    };
    return payload;
  }
  if (model.api === 'openai-completions' || model.api === 'openai-chat') {
    if (!Array.isArray(payload.messages)) return undefined;
    const patch = resolveMiniMaxM3ThinkingProtocol('openai-completions', effort);
    payload.thinking = isRecord(patch.thinking) ? { ...patch.thinking } : {};
    delete payload.reasoning_effort;
    return payload;
  }
  if (model.api !== 'anthropic-messages' || !Array.isArray(payload.messages)) return undefined;
  const patch = resolveMiniMaxM3ThinkingProtocol('anthropic-messages', effort);
  payload.thinking = isRecord(patch.thinking) ? { ...patch.thinking } : {};
  const outputConfig = isRecord(payload.output_config) ? { ...payload.output_config } : {};
  delete outputConfig.effort;
  if (Object.keys(outputConfig).length > 0) payload.output_config = outputConfig;
  else delete payload.output_config;
  return payload;
}

export function getOpenPlatformThinkingVariants(
  modelRef: IModelRef | undefined,
): OpenPlatformThinkingVariants | undefined {
  const capabilities = modelRef?.capabilities as Record<string, unknown> | undefined;
  const raw = capabilities?.[OPENPLATFORM_THINKING_VARIANTS_CAPABILITY];
  if (!isRecord(raw)) return undefined;
  const thinking = cloneThinkingPayload(raw.thinking);
  const noneThinking = cloneThinkingPayload(raw['none-thinking']);
  if (!thinking && !noneThinking) return undefined;
  return {
    ...(thinking ? { thinking } : {}),
    ...(noneThinking ? { 'none-thinking': noneThinking } : {}),
  };
}

export function hasOpenPlatformThinkingVariants(modelRef: IModelRef | undefined): boolean {
  return getOpenPlatformThinkingVariants(modelRef) !== undefined;
}

export function buildOpenPlatformThinkingPatcher(modelRef: IModelRef | undefined) {
  const level = modelRef?.thinking_level;
  const thinkingOn = level !== undefined && level !== ThinkingLevel.OFF;
  const variants = getOpenPlatformThinkingVariants(modelRef);
  const selectedEffort = readSelectedThinkingEffort(
    modelRef?.capabilities as Record<string, unknown> | undefined,
  );
  const miniMaxM3Effort =
    isMiniMaxM3ModelId(modelRef?.model_id) && isMiniMaxM3ThinkingMode(selectedEffort)
      ? selectedEffort
      : undefined;

  return function patchOpenPlatformThinking(
    payload: unknown,
    model: Model<Api>,
  ): unknown | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const p = payload as Record<string, unknown>;

    if (miniMaxM3Effort) return patchMiniMaxM3Effort(p, model, miniMaxM3Effort);
    if (!variants) return undefined;

    const thinking = thinkingOn ? variants.thinking : variants['none-thinking'];
    if (!thinking) return undefined;
    if (isMiniMaxM3ModelId(modelRef?.model_id) && model.api !== 'anthropic-messages') {
      if (model.api === 'openai-responses') {
        const patch = resolveMiniMaxM3ThinkingProtocol(
          'openai-responses',
          thinkingOn ? 'on' : 'off',
        );
        const reasoningPatch = isRecord(patch.reasoning) ? patch.reasoning : {};
        p.reasoning = {
          ...(isRecord(p.reasoning) ? p.reasoning : {}),
          ...reasoningPatch,
        };
        return p;
      }
      if (model.api === 'openai-completions' || model.api === 'openai-chat') {
        if (!Array.isArray(p.messages)) return undefined;
        const patch = resolveMiniMaxM3ThinkingProtocol(
          'openai-completions',
          thinkingOn ? 'on' : 'off',
        );
        p.thinking = isRecord(patch.thinking) ? { ...patch.thinking } : {};
        delete p.reasoning_effort;
        return p;
      }
      return undefined;
    }
    if (model.api !== 'anthropic-messages' || !Array.isArray(p.messages)) return undefined;
    p.thinking = { ...thinking };
    const configuredEffort = thinkingOn ? selectedEffort : undefined;
    const outputConfig = isRecord(p.output_config) ? { ...p.output_config } : {};
    const currentEffort = outputConfig.effort;
    const preserveProviderEffort =
      !configuredEffort &&
      parseProviderId(model.provider)?.source === 'custom_provider' &&
      typeof currentEffort === 'string' &&
      Object.values(model.thinkingLevelMap ?? {}).includes(currentEffort);
    if (configuredEffort) outputConfig.effort = configuredEffort;
    else if (!preserveProviderEffort) delete outputConfig.effort;
    if (Object.keys(outputConfig).length > 0) p.output_config = outputConfig;
    else delete p.output_config;
    return p;
  };
}
