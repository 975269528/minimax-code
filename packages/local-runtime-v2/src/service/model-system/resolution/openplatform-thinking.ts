import type { IModelRef } from '@mavis/protocol';

export const OPENPLATFORM_THINKING_VARIANTS_CAPABILITY = 'openplatform_thinking_variants';

export interface OpenPlatformThinkingVariants {
  readonly thinking?: Record<string, unknown>;
  readonly 'none-thinking'?: Record<string, unknown>;
}

function getOpenPlatformThinkingVariants(
  modelRef: IModelRef | undefined,
): OpenPlatformThinkingVariants | undefined {
  const capabilities = asRecord(modelRef?.capabilities);
  const raw = asRecord(capabilities?.[OPENPLATFORM_THINKING_VARIANTS_CAPABILITY]);
  if (!raw) return undefined;
  const thinking = cloneRecord(raw.thinking);
  const noneThinking = cloneRecord(raw['none-thinking']);
  if (!thinking && !noneThinking) return undefined;
  return {
    ...(thinking ? { thinking } : {}),
    ...(noneThinking ? { 'none-thinking': noneThinking } : {}),
  };
}

export function hasOpenPlatformThinkingVariants(modelRef: IModelRef | undefined): boolean {
  return getOpenPlatformThinkingVariants(modelRef) !== undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cloneRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return record ? { ...record } : undefined;
}
