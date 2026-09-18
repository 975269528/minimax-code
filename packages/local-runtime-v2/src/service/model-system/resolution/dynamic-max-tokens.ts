import { streamSimple, type Api, type Context, type Model } from '@earendil-works/pi-ai';
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import { LLM_RETRY_CALL_IDENTITY } from '@mavis/agent-core/pi-turn-runner';
import { createDefaultTokenEstimator, resolveDynamicMaxTokens } from '@mavis/context-manager';

const MIN_OUTPUT_TOKENS = 1_024;
const EMERGENCY_OUTPUT_TOKENS = 1;
const PI_DEFAULT_THINKING_BUDGETS: Readonly<Record<string, number>> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
};

interface DynamicBudget {
  readonly maxTokens: number;
  readonly disableReasoning: boolean;
}

interface BudgetedCall {
  readonly stream: StreamFn;
  readonly model: Model<Api>;
  readonly context: Context;
  readonly options: Parameters<StreamFn>[2];
  readonly budget: DynamicBudget;
}

function estimatePiContextTokens(context: Context): number {
  const estimator = createDefaultTokenEstimator();
  const messages = [...(context.messages ?? [])] as AgentMessage[];
  const systemTokens = context.systemPrompt
    ? estimator.estimateTextTokens(context.systemPrompt)
    : 0;
  const toolTokens = (context.tools ?? []).reduce(
    (tokens, tool) =>
      tokens +
      estimator.estimateTextTokens(
        [tool.name ?? '', tool.description ?? '', safeJson(tool.parameters)].join('\n'),
      ),
    0,
  );
  return estimator.estimateMessages(messages) + systemTokens + toolTokens;
}

/**
 * Keeps the v2 provider request consistent with the 16k reserve used by its
 * compaction trigger. The wrapper is synchronous, so it uses the current
 * complete Pi context and the bounded shared estimator.
 */
export function withLocalDynamicMaxTokens(inner?: StreamFn): StreamFn {
  const base: StreamFn = inner ?? streamSimple;
  const retryBudgets = new WeakMap<object, DynamicBudget>();
  return (model, context, options) => {
    const contextWindow = positive(model.contextWindow);
    const configured = positive(options?.maxTokens) || positive(model.maxTokens);
    if (!contextWindow || !configured) return base(model, context, options);
    const retryIdentity = (
      options as (typeof options & { [LLM_RETRY_CALL_IDENTITY]?: object }) | undefined
    )?.[LLM_RETRY_CALL_IDENTITY];
    const retryBudget = retryIdentity ? retryBudgets.get(retryIdentity) : undefined;
    if (retryBudget) {
      return callWithBudget({ stream: base, model, context, options, budget: retryBudget });
    }

    const budget = resolveCallBudget({ model, context, options, contextWindow, configured });
    if (retryIdentity) retryBudgets.set(retryIdentity, budget);
    return budget.maxTokens >= configured
      ? base(model, context, options)
      : callWithBudget({ stream: base, model, context, options, budget });
  };
}

function resolveCallBudget(input: {
  readonly model: Model<Api>;
  readonly context: Context;
  readonly options: Parameters<StreamFn>[2];
  readonly contextWindow: number;
  readonly configured: number;
}): DynamicBudget {
  try {
    const desired = resolveDynamicMaxTokens({
      contextWindow: input.contextWindow,
      configuredMaxTokens: input.configured,
      estimatedContextTokens: estimatePiContextTokens(input.context),
    });
    if (desired >= input.configured) {
      return { maxTokens: input.configured, disableReasoning: false };
    }
    return {
      maxTokens: Math.max(
        MIN_OUTPUT_TOKENS,
        desired - thinkingBudgetTokens(input.model, input.options),
      ),
      disableReasoning: false,
    };
  } catch {
    return { maxTokens: EMERGENCY_OUTPUT_TOKENS, disableReasoning: true };
  }
}

function callWithBudget(input: BudgetedCall) {
  return input.stream(input.model, input.context, {
    ...(input.options ?? {}),
    maxTokens: input.budget.maxTokens,
    ...(input.budget.disableReasoning ? { reasoning: undefined } : {}),
  });
}

function thinkingBudgetTokens(model: Model<Api>, options: Parameters<StreamFn>[2]): number {
  if (model.api !== 'anthropic-messages') return 0;
  const reasoning = options?.reasoning;
  if (!reasoning) return 0;
  if (model.compat && Reflect.get(model.compat, 'forceAdaptiveThinking') === true) return 0;
  const level = reasoning === 'xhigh' || reasoning === 'max' ? 'high' : reasoning;
  return options?.thinkingBudgets?.[level] ?? PI_DEFAULT_THINKING_BUDGETS[level] ?? 0;
}

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}
