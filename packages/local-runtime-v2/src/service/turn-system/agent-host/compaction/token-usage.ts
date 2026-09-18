import type { LLMRequestSettledEvent } from '@mavis/agent-core/pi-turn-runner';

import type { CompactionTokenUsage } from './contracts.js';

export function createCompactionTokenUsageAccumulator(): {
  readonly observe: (event: LLMRequestSettledEvent) => void;
  readonly snapshot: () => CompactionTokenUsage | undefined;
} {
  let observed = false;
  let incomplete = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  const observe = (event: LLMRequestSettledEvent): void => {
    observed = true;
    incomplete ||= !event.usageComplete;
    if (!event.usage) {
      incomplete = true;
      return;
    }
    const input = readProviderTokenBucket(event.usage.input);
    const output = readProviderTokenBucket(event.usage.output);
    const cacheRead = readProviderTokenBucket(event.usage.cacheRead);
    const cacheWrite = readProviderTokenBucket(event.usage.cacheWrite);
    incomplete ||=
      input === undefined ||
      output === undefined ||
      cacheRead === undefined ||
      cacheWrite === undefined;
    inputTokens = addProviderTokens(inputTokens, input);
    outputTokens = addProviderTokens(outputTokens, output);
    cacheReadTokens = addProviderTokens(cacheReadTokens, cacheRead);
    cacheWriteTokens = addProviderTokens(cacheWriteTokens, cacheWrite);
  };

  return {
    observe,
    snapshot: () => {
      if (!observed) return undefined;
      return {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        incomplete,
      };
    },
  };
}

export function compactionTokenUsageMetadata(tokenUsage: CompactionTokenUsage | undefined): {
  readonly tokenUsage?: CompactionTokenUsage;
} {
  if (tokenUsage === undefined) return {};
  return { tokenUsage };
}

export function readCompactionTokenUsage(value: unknown): CompactionTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = readNonNegativeNumber(Reflect.get(value, 'inputTokens'));
  const outputTokens = readNonNegativeNumber(Reflect.get(value, 'outputTokens'));
  const cacheReadTokens = readNonNegativeNumber(Reflect.get(value, 'cacheReadTokens'));
  const cacheWriteTokens = readNonNegativeNumber(Reflect.get(value, 'cacheWriteTokens'));
  const totalTokens = readNonNegativeNumber(Reflect.get(value, 'totalTokens'));
  const incomplete = Reflect.get(value, 'incomplete');
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined ||
    totalTokens === undefined ||
    typeof incomplete !== 'boolean' ||
    totalTokens !== inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  ) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    incomplete,
  };
}

function readProviderTokenBucket(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function addProviderTokens(current: number, value: number | undefined): number {
  if (value === undefined) return current;
  const total = current + value;
  return Number.isFinite(total) ? total : current;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
