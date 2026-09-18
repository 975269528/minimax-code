import { streamSimple, type Api, type Context, type Model } from '@earendil-works/pi-ai';
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import { LLM_RETRY_CALL_IDENTITY } from '@mavis/agent-core/pi-turn-runner';
import {
  estimateMessagesTokens,
  estimateSystemPromptAndToolTokens,
} from '../context/token-estimator.js';

/**
 * Dynamic per-call maxTokens clamping (local-runtime only, Messages-compatible API only).
 *
 * Problem: Statically putting a large configured max_tokens (e.g. 128k) in every request has two
 * effects:
 * 1. Providers require `input_tokens + max_tokens ≤ contextWindow`; long context makes the request
 *   invalid (400 overflow).
 * 2. Reserving the full maxTokens for automatic compaction triggers compaction around 35% of a 200k
 *   window, wasting most of it.
 *
 * Solution: Allow the full configured budget early in a session, then shrink it per call as context
 * grows, down to {@link DYNAMIC_MAX_TOKENS_FLOOR} (16k). The trigger only reserves that floor (see
 * evaluateTrigger in lifecycle.ts); the next turn beyond the floor threshold naturally triggers
 * compaction.
 *
 *   effectiveMax = clamp(contextWindow − estimated context − margin, floor, configured value)
 *
 * Enable only for Messages-compatible APIs. Other providers bypass this clamp and retain the old
 * trigger formula reserving full maxTokens, keeping both sides consistent.
 */

/** Output budget floor: compact rather than shrinking output below this value. */
export const DYNAMIC_MAX_TOKENS_FLOOR = 16_384;

/** Safety margin for estimation error, identical in value and meaning to the compaction trigger's safetyMarginTokens. */
export const DYNAMIC_MAX_TOKENS_SAFETY_MARGIN = 2_048;

/** Minimum usable output retained on the normal clamping path. */
const MIN_OUTPUT_TOKENS = 1_024;

/** Use the provider's smallest allowed positive-integer budget when estimation fails. */
const EMERGENCY_OUTPUT_TOKENS = 1;

/**
 * pi-ai's default thinking budgets (`adjustMaxTokensForThinking` in provider/simple-options.js). It
 * adds the budget back to caller-supplied maxTokens, so clamping must deduct the same amount first.
 * Align with the pi-ai version before changing this table. Pi clamps xhigh/max to high.
 */
const PI_DEFAULT_THINKING_BUDGETS: Record<string, number> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
};

export interface ResolveDynamicMaxTokensInput {
  contextWindow: number;
  configuredMaxTokens: number;
  estimatedContextTokens: number;
}

export interface LocalDynamicMaxTokensRemoteSnapshot {
  tokens: number;
  source: 'remote_count_tokens';
}

/**
 * Bridge asynchronous context lifecycle checkpoints to the synchronous StreamFn wrapper.
 * count_tokens runs during beforeLlmCall; the later provider stream must return an event stream
 * synchronously, so the wrapper can only consume a precomputed snapshot and cannot await the remote
 * counter here.
 */
export class LocalDynamicMaxTokensState {
  private readonly snapshots = new Map<string, LocalDynamicMaxTokensRemoteSnapshot>();

  setRemoteContextTokens(sessionId: string, tokens: number): void {
    if (!sessionId || !Number.isFinite(tokens) || tokens <= 0) {
      this.clear(sessionId);
      return;
    }
    this.snapshots.set(sessionId, { tokens, source: 'remote_count_tokens' });
  }

  clear(sessionId: string): void {
    if (!sessionId) return;
    this.snapshots.delete(sessionId);
  }

  get(sessionId: string | undefined): LocalDynamicMaxTokensRemoteSnapshot | undefined {
    if (!sessionId) return undefined;
    return this.snapshots.get(sessionId);
  }

  /**
   * Consume a snapshot only once: it describes the exact provider payload counted at the latest
   * checkpoint. Reusing it for later provider calls would clamp against stale input tokens from a
   * different context.
   */
  consume(sessionId: string | undefined): LocalDynamicMaxTokensRemoteSnapshot | undefined {
    if (!sessionId) return undefined;
    const snapshot = this.snapshots.get(sessionId);
    this.snapshots.delete(sessionId);
    return snapshot;
  }
}

/**
 * Pure function computing this call's output budget from the window, configured budget, and current
 * context estimate. If the window or budget is unknown, return the configured value unchanged.
 * Never increase a configured budget below the floor: only shrink, never grow.
 */
export function resolveDynamicMaxTokens(input: ResolveDynamicMaxTokensInput): number {
  const { contextWindow, configuredMaxTokens, estimatedContextTokens } = input;
  if (!(contextWindow > 0) || !(configuredMaxTokens > 0)) return configuredMaxTokens;
  const remaining = contextWindow - estimatedContextTokens - DYNAMIC_MAX_TOKENS_SAFETY_MARGIN;
  const floor = Math.min(configuredMaxTokens, DYNAMIC_MAX_TOKENS_FLOOR);
  return Math.min(configuredMaxTokens, Math.max(floor, remaining));
}

/**
 * Estimate the token footprint of pi-ai Context (system prompt, messages, tools). Used only as a
 * synchronous fallback when no remote snapshot exists. Estimate the full current payload with a
 * local estimator protected against long unbroken text. Do not reuse historical usage that cannot
 * be tied to current system prompt/tools, avoiding undercounting changed payloads or
 * double-counting unchanged ones.
 */
export function estimatePiContextTokens(context: Context, _model?: Model<Api>): number {
  return (
    estimateMessagesTokens((context.messages ?? []) as AgentMessage[]) +
    estimateSystemPromptAndToolTokens(context.systemPrompt, context.tools)
  );
}

/**
 * In budget thinking mode, pi-ai adds the thinking budget to the caller cap
 * (`adjustMaxTokensForThinking`: `maxTokens = min(caller + budget, model limit)`). Deduct the same
 * amount before clamping so the final request fits remaining capacity. Adaptive thinking
 * (`forceAdaptiveThinking`) uses effort without changing maxTokens, so no deduction is needed.
 */
function thinkingBudgetTokens(
  model: Model<Api>,
  options: { reasoning?: string; thinkingBudgets?: Record<string, number | undefined> } | undefined,
): number {
  const reasoning = options?.reasoning;
  if (!reasoning) return 0;
  if ((model as { compat?: { forceAdaptiveThinking?: boolean } }).compat?.forceAdaptiveThinking) {
    return 0;
  }
  const level = reasoning === 'xhigh' || reasoning === 'max' ? 'high' : reasoning;
  return options?.thinkingBudgets?.[level] ?? PI_DEFAULT_THINKING_BUDGETS[level] ?? 0;
}

/**
 * StreamFn wrapper: The resolver's innermost streamFn clamps options.maxTokens to the remaining
 * window after receiving full context for each provider call. The outer composeStreamFn's
 * withMaxTokens has already populated the configured budget; only shrink it here. Forward requests
 * unchanged when the budget still fits.
 */
export function withLocalDynamicMaxTokens(
  inner?: StreamFn,
  state?: LocalDynamicMaxTokensState,
  sessionId?: string,
): StreamFn {
  const base = inner ?? (streamSimple as unknown as StreamFn);
  const retryBudgets = new WeakMap<object, { maxTokens: number; disableReasoning: boolean }>();
  return ((model, context, options) => {
    if (model.api !== 'anthropic-messages') return base(model, context, options);
    const contextWindow = typeof model.contextWindow === 'number' ? model.contextWindow : 0;
    const optionMaxTokens = (options as { maxTokens?: number } | undefined)?.maxTokens;
    const configured =
      typeof optionMaxTokens === 'number' && optionMaxTokens > 0
        ? optionMaxTokens
        : model.maxTokens;
    if (!(contextWindow > 0) || !(configured > 0)) return base(model, context, options);
    const retryCallIdentity = (
      options as (typeof options & { [LLM_RETRY_CALL_IDENTITY]?: object }) | undefined
    )?.[LLM_RETRY_CALL_IDENTITY];
    const retryBudget = retryCallIdentity ? retryBudgets.get(retryCallIdentity) : undefined;
    if (retryBudget !== undefined) {
      return base(model, context, {
        ...(options ?? {}),
        maxTokens: retryBudget.maxTokens,
        ...(retryBudget.disableReasoning ? { reasoning: undefined } : {}),
      });
    }
    const runtimeSessionId =
      sessionId ?? (options as { sessionId?: string } | undefined)?.sessionId;
    const remoteSnapshot = state?.consume(runtimeSessionId);
    // Prefer provider input tokens from the same checkpoint. Local estimation is only a synchronous fallback
    // when no snapshot exists. If fallback estimation itself fails, use the provider's minimum
    // allowed budget and disable reasoning so the thinking budget is not added back.
    let contextTokens: number;
    try {
      contextTokens = remoteSnapshot?.tokens ?? estimatePiContextTokens(context, model);
    } catch {
      if (retryCallIdentity) {
        retryBudgets.set(retryCallIdentity, {
          maxTokens: EMERGENCY_OUTPUT_TOKENS,
          disableReasoning: true,
        });
      }
      return base(model, context, {
        ...(options ?? {}),
        maxTokens: EMERGENCY_OUTPUT_TOKENS,
        reasoning: undefined,
      });
    }
    const desired = resolveDynamicMaxTokens({
      contextWindow,
      configuredMaxTokens: configured,
      estimatedContextTokens: contextTokens,
    });
    if (desired >= configured) {
      if (retryCallIdentity) {
        retryBudgets.set(retryCallIdentity, {
          maxTokens: configured,
          disableReasoning: false,
        });
      }
      return base(model, context, options);
    }
    const clamped = Math.max(
      MIN_OUTPUT_TOKENS,
      desired -
        thinkingBudgetTokens(
          model,
          options as Parameters<typeof thinkingBudgetTokens>[1] | undefined,
        ),
    );
    if (retryCallIdentity) {
      retryBudgets.set(retryCallIdentity, {
        maxTokens: clamped,
        disableReasoning: false,
      });
    }
    return base(model, context, { ...(options ?? {}), maxTokens: clamped });
  }) as StreamFn;
}
