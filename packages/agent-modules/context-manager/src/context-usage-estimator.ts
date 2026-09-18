import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  type ContextUsageComponent,
  type ContextUsagePromptRange,
} from '@mavis/agent-core/protocol';

import { createDefaultTokenEstimator } from './token-estimator.js';

export interface PreparedContextUsageEstimate {
  readonly valid: boolean;
  readonly usedTokens: number;
  readonly components: readonly ContextUsageComponent[];
}

const tokenEstimator = createDefaultTokenEstimator();

export function estimatePreparedContextUsage(input: {
  readonly systemPrompt: string;
  readonly tools: readonly unknown[];
  readonly messagesTokens: number;
  readonly promptRanges: readonly ContextUsagePromptRange[];
}): PreparedContextUsageEstimate {
  const systemPrompt = input.systemPrompt;
  const toolsTokens = estimateTextTokens(safeJsonStringify(input.tools));
  const messagesTokens = normalizeTokenCount(input.messagesTokens);
  if (!validPromptRanges(systemPrompt, input.promptRanges)) {
    return {
      valid: false,
      usedTokens: estimateTextTokens(systemPrompt) + toolsTokens + messagesTokens,
      components: [],
    };
  }

  let cursor = 0;
  let plainSystemTokens = 0;
  let memoryTokens = 0;
  let skillsTokens = 0;
  let otherTokens = 0;
  for (const range of input.promptRanges) {
    plainSystemTokens += estimateTextTokens(systemPrompt.slice(cursor, range.startOffset));
    const rangeTokens = estimateTextTokens(systemPrompt.slice(range.startOffset, range.endOffset));
    if (range.kind === 'MEMORY') memoryTokens += rangeTokens;
    else if (range.kind === 'SKILLS') skillsTokens += rangeTokens;
    else otherTokens += rangeTokens;
    cursor = range.endOffset;
  }
  plainSystemTokens += estimateTextTokens(systemPrompt.slice(cursor));

  const components: ContextUsageComponent[] = [
    { kind: 'SYSTEM_PROMPT', tokens: plainSystemTokens },
    { kind: 'MEMORY', tokens: memoryTokens },
    { kind: 'TOOLS', tokens: toolsTokens },
    { kind: 'SKILLS', tokens: skillsTokens },
    { kind: 'MESSAGES', tokens: messagesTokens },
    { kind: 'OTHER', tokens: otherTokens },
  ];
  return {
    valid: true,
    usedTokens: components.reduce((sum, component) => sum + component.tokens, 0),
    components,
  };
}

/** Reads the context-window aliases used by supported model configurations. */
export function readContextWindowTokens(model: unknown): number | undefined {
  if (!model || typeof model !== 'object') return undefined;
  for (const key of ['contextWindow', 'context_window', 'contextWindowTokens'] as const) {
    const value = Reflect.get(model, key);
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.max(1, Math.round(value));
    }
  }
  return undefined;
}

function validPromptRanges(
  systemPrompt: string,
  ranges: readonly ContextUsagePromptRange[],
): boolean {
  let cursor = 0;
  return ranges.every((range) => {
    if (
      !Number.isSafeInteger(range.startOffset) ||
      !Number.isSafeInteger(range.endOffset) ||
      range.startOffset < cursor ||
      range.endOffset <= range.startOffset ||
      range.endOffset > systemPrompt.length
    ) {
      return false;
    }
    cursor = range.endOffset;
    return true;
  });
}

function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return tokenEstimator.estimateMessage({
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: 0,
  } as AgentMessage);
}

function normalizeTokenCount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}
