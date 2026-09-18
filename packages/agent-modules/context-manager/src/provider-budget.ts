import { DEFAULT_CONTEXT_MANAGER_SETTINGS } from './settings.js';

const PROVIDER_INPUT_RATIO = 0.95;

export function resolveDynamicMaxTokens(input: {
  readonly contextWindow: number;
  readonly configuredMaxTokens: number;
  readonly estimatedContextTokens: number;
}): number {
  const { contextWindow, configuredMaxTokens, estimatedContextTokens } = input;
  if (!(contextWindow > 0) || !(configuredMaxTokens > 0)) return configuredMaxTokens;
  const remaining =
    contextWindow - estimatedContextTokens - DEFAULT_CONTEXT_MANAGER_SETTINGS.safetyMarginTokens;
  return Math.min(configuredMaxTokens, Math.max(outputFloor(configuredMaxTokens), remaining));
}

export function resolveCompactionTokenBudget(input: {
  readonly contextWindow: number;
  readonly configuredMaxOutputTokens: number;
}): { readonly providerInputLimit: number; readonly automaticTriggerAt: number } {
  const configuredOutput = positive(input.configuredMaxOutputTokens);
  const { reserveTokens, safetyMarginTokens } = DEFAULT_CONTEXT_MANAGER_SETTINGS;
  const fullOutputInputBudget = input.contextWindow - configuredOutput - safetyMarginTokens;
  const effectiveOutput =
    fullOutputInputBudget >= reserveTokens ? configuredOutput : outputFloor(configuredOutput);
  const providerInputLimit = Math.max(
    1,
    Math.min(
      Math.floor(input.contextWindow * PROVIDER_INPUT_RATIO),
      input.contextWindow - reserveTokens,
      input.contextWindow - effectiveOutput - safetyMarginTokens,
    ),
  );
  const proactiveReserve = Math.min(reserveTokens * 2, Math.floor(input.contextWindow / 4));
  return {
    providerInputLimit,
    automaticTriggerAt: Math.min(
      providerInputLimit,
      Math.max(1, input.contextWindow - proactiveReserve),
    ),
  };
}

function outputFloor(configuredMaxTokens: number): number {
  return Math.min(configuredMaxTokens, DEFAULT_CONTEXT_MANAGER_SETTINGS.reserveTokens);
}

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
