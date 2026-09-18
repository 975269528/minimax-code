import { Buffer } from 'node:buffer';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { projectAgentMessagesForModel } from '@mavis/agent-core/pi-turn-runner';
import { createDefaultTokenEstimator } from '@mavis/context-manager';

import type { ContextFootprint, PairedContextFootprint } from '../algorithm/tool-trim-admission.js';
import type { ContextUsageAnchorKey, ContextUsageAnchorState } from './usage-anchor.js';

interface LocalContextFootprintOptions {
  readonly model: Model<Api>;
  readonly systemPrompt?: string;
  readonly tools?: readonly unknown[];
  readonly usageAnchor?: {
    readonly state: ContextUsageAnchorState;
    readonly key: ContextUsageAnchorKey;
    readonly historyEpoch: number;
  };
}

export interface LocalContextFootprintMeasurer {
  measure(messages: readonly AgentMessage[]): ContextFootprint;
  measurePair(input: {
    readonly beforeMessages: readonly AgentMessage[];
    readonly afterMessages: readonly AgentMessage[];
  }): PairedContextFootprint;
}

export function createLocalContextFootprintMeasurer(
  options: LocalContextFootprintOptions,
): LocalContextFootprintMeasurer {
  const tools = options.tools ?? [];
  const estimator = createDefaultTokenEstimator();
  const fixedMessages = [
    ...(options.systemPrompt ? [textMessage(options.systemPrompt)] : []),
    ...(tools.length > 0 ? [textMessage(strictStringify(tools))] : []),
  ];
  const fixedTokens = estimator.estimateMessages(fixedMessages);
  strictStringify({ systemPrompt: options.systemPrompt ?? '', tools, messages: [] });

  const measureFresh = (messages: readonly AgentMessage[]): ContextFootprint => {
    const projected = projectAgentMessagesForModel(messages, options.model).messages;
    const inputTokens = fixedTokens + estimator.estimateMessages(projected);
    const serializedBytes = Buffer.byteLength(
      strictStringify({ systemPrompt: options.systemPrompt ?? '', tools, messages: projected }),
      'utf8',
    );
    validateFootprint(inputTokens, serializedBytes);
    return { inputTokens, serializedBytes };
  };

  const measure = (messages: readonly AgentMessage[]): ContextFootprint => {
    const fresh = measureFresh(messages);
    const match = options.usageAnchor?.state.resolve({
      key: options.usageAnchor.key,
      historyEpoch: options.usageAnchor.historyEpoch,
      messages,
    });
    if (!match) return fresh;
    const trailing = projectAgentMessagesForModel(match.trailingMessages, options.model).messages;
    const hintTokens = match.absoluteTokens + estimator.estimateMessages(trailing);
    validateFootprint(hintTokens, fresh.serializedBytes);
    return { ...fresh, inputTokens: Math.max(fresh.inputTokens, hintTokens) };
  };

  return {
    measure,
    measurePair: ({ beforeMessages, afterMessages }) => ({
      before: measureFresh(beforeMessages),
      after: measureFresh(afterMessages),
    }),
  };
}

function textMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 0 };
}

function strictStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('value is undefined');
    return serialized;
  } catch (cause) {
    throw new TypeError('Context footprint input must be JSON serializable.', { cause });
  }
}

function validateFootprint(inputTokens: number, serializedBytes: number): void {
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(serializedBytes) ||
    serializedBytes < 0
  ) {
    throw new TypeError('Context footprint must contain non-negative safe integers.');
  }
}
