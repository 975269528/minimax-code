import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import type { Context } from '@earendil-works/pi-ai';
import { createDefaultTokenEstimator } from '@mavis/context-manager';
import {
  CONTEXT_USAGE_COMPONENT_KINDS,
  type ContextUsageComponent,
  type ContextUsageMeasurement,
  type ContextUsageProviderMessageUsage,
  type ContextUsageProviderUsage,
  type ContextUsageReconciliation,
  type ContextUsageSnapshot,
  type PreparedContextEstimate,
  type PromptRange,
} from './context-usage-types.js';
import { validComponentWeights, validPromptRanges } from './context-usage-validation.js';
import { estimateImageBlockTokens, type ImageTokenEstimateOptions } from './image-detection.js';

export { CONTEXT_USAGE_COMPONENT_KINDS } from './context-usage-types.js';
export {
  ContextUsageTurnTracker,
  withContextUsageEventWriter,
} from './context-usage-turn-tracker.js';
export type {
  ContextUsageComponent,
  ContextUsageComponentKind,
  ContextUsageDebugMeasurement,
  ContextUsageMeasurement,
  ContextUsageProviderMessageUsage,
  ContextUsageProviderDiagnosticComponent,
  ContextUsageProviderDiagnostics,
  ContextUsageProviderDiagnosticStatus,
  ContextUsageProviderUsage,
  ContextUsageReconciliation,
  ContextUsageSnapshot,
  ContextUsageToolCalibrationDebug,
  ContextUsageTotalCountSource,
  PreparedContextEstimate,
  PromptRange,
} from './context-usage-types.js';

const tokenEstimator = createDefaultTokenEstimator();

export function estimatePreparedContext(
  context: Context,
  promptRanges: readonly PromptRange[],
  model?: ImageTokenEstimateOptions['model'],
): PreparedContextEstimate {
  const systemPrompt = context.systemPrompt ?? '';
  const toolsTokens = estimateStructuredTokens(context.tools ?? []);
  const messagesTokens = estimateContextUsageMessages(context.messages ?? [], model);

  if (!validPromptRanges(systemPrompt, promptRanges)) {
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
  for (const range of promptRanges) {
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
  const usedTokens = components.reduce((sum, component) => sum + component.tokens, 0);
  return {
    valid: validComponentWeights(components),
    usedTokens,
    components,
  };
}

function estimateContextUsageMessages(
  messages: readonly PiAgentMessage[],
  model?: ImageTokenEstimateOptions['model'],
): number {
  const replayableMessages = messages.filter(isProviderReplayableMessage);
  const messagesWithoutVisualContent = replayableMessages.map((message) => {
    const content = (message as unknown as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    return {
      ...message,
      content: content.filter((value) => {
        if (!value || typeof value !== 'object') return true;
        const type = (value as Record<string, unknown>).type;
        return type !== 'image' && type !== 'video';
      }),
    } as PiAgentMessage;
  });
  const textAndStructureTokens = tokenEstimator.estimateMessages(messagesWithoutVisualContent);
  let visualTokens = 0;
  for (const message of replayableMessages) {
    const content = (message as unknown as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const value of content) {
      if (!value || typeof value !== 'object') continue;
      const block = value as Record<string, unknown>;
      if (block.type !== 'image' && block.type !== 'video') continue;
      visualTokens += estimateImageBlockTokens(block, model ? { model } : {});
    }
  }
  return Math.max(0, textAndStructureTokens + visualTokens);
}

/** Keep the local estimate aligned with Provider history replay semantics. */
function isProviderReplayableMessage(message: PiAgentMessage): boolean {
  if (message.role !== 'assistant') return true;
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  return stopReason !== 'aborted' && stopReason !== 'error';
}

export function applyToolCalibration(
  prepared: PreparedContextEstimate,
  calibratedToolsTokens: number | undefined,
): PreparedContextEstimate {
  if (
    calibratedToolsTokens === undefined ||
    !Number.isSafeInteger(calibratedToolsTokens) ||
    calibratedToolsTokens < 0 ||
    !prepared.valid ||
    !validComponentWeights(prepared.components)
  ) {
    return prepared;
  }
  const currentTools =
    prepared.components.find((component) => component.kind === 'TOOLS')?.tokens ?? 0;
  const components = prepared.components.map((component) =>
    component.kind === 'TOOLS' ? { ...component, tokens: calibratedToolsTokens } : { ...component },
  );
  return {
    valid: true,
    usedTokens: Math.max(0, prepared.usedTokens - currentTools + calibratedToolsTokens),
    components,
  };
}

interface ContextUsageMeasurementInput {
  contextWindowTokens: number;
  prepared: PreparedContextEstimate;
  providerUsage?: ContextUsageProviderUsage;
  retainedTail?: readonly PiAgentMessage[];
}

export function buildContextUsageSnapshot(
  input: ContextUsageMeasurementInput,
): ContextUsageSnapshot {
  return buildContextUsageMeasurement(input).snapshot;
}

export function buildLocalEstimatedContextUsageSnapshot(input: {
  contextWindowTokens: number;
  context: Context;
  promptRanges: readonly PromptRange[];
  model?: ImageTokenEstimateOptions['model'];
  calibratedToolsTokens?: number;
}): ContextUsageSnapshot {
  return buildContextUsageSnapshot({
    contextWindowTokens: input.contextWindowTokens,
    prepared: applyToolCalibration(
      estimatePreparedContext(input.context, input.promptRanges, input.model),
      input.calibratedToolsTokens,
    ),
  });
}

export function buildContextUsageMeasurement(
  input: ContextUsageMeasurementInput,
): ContextUsageMeasurement {
  const retainedTailTokens =
    input.retainedTail && input.retainedTail.length > 0
      ? tokenEstimator.estimateMessages([...input.retainedTail])
      : 0;
  const providerMessageInputTokens = sumProviderInputTokens(input.providerUsage);
  const providerInputTokens = providerMessageInputTokens;
  const usedTokens = Math.max(
    0,
    Math.round(
      (providerInputTokens ?? input.prepared.usedTokens) + Math.max(0, retainedTailTokens),
    ),
  );

  let snapshot: ContextUsageSnapshot;
  if (!input.prepared.valid || input.prepared.components.length === 0) {
    snapshot = {
      contextWindowTokens: normalizePositiveInteger(input.contextWindowTokens),
      usedTokens,
      totalCountSource:
        providerInputTokens === undefined ? 'LOCAL_ESTIMATE' : 'PROVIDER_USAGE_ANCHORED',
      components: [],
    };
  } else {
    const components =
      providerInputTokens === undefined
        ? addRetainedTail(
            input.prepared.components.map((component) => ({ ...component })),
            retainedTailTokens,
          )
        : buildProviderAnchoredComponents(
            input.prepared.components,
            providerInputTokens,
            retainedTailTokens,
          );
    snapshot = {
      contextWindowTokens: normalizePositiveInteger(input.contextWindowTokens),
      usedTokens,
      totalCountSource:
        providerInputTokens === undefined ? 'LOCAL_ESTIMATE' : 'PROVIDER_USAGE_ANCHORED',
      components,
    };
  }

  const rawPreparedComponents = validComponentWeights(input.prepared.components)
    ? input.prepared.components.map((component) => ({ ...component }))
    : [];
  const rawFinalComponents = addRetainedTail(rawPreparedComponents, retainedTailTokens);
  const signedDivergence =
    providerMessageInputTokens === undefined
      ? null
      : input.prepared.usedTokens - providerMessageInputTokens;
  const signedRate =
    signedDivergence === null || !providerMessageInputTokens
      ? null
      : signedDivergence / providerMessageInputTokens;

  return {
    snapshot,
    debug: {
      rawPreparedTokens: input.prepared.usedTokens,
      rawPreparedComponents,
      retainedTailTokens,
      rawFinalTokens: input.prepared.usedTokens + retainedTailTokens,
      rawFinalComponents,
      providerMessageUsage: toProviderMessageUsage(input.providerUsage),
      ...(providerMessageInputTokens === undefined
        ? {}
        : { providerInputAnchor: providerMessageInputTokens }),
      divergence: {
        signedTokens: signedDivergence,
        signedRate,
        absoluteRate: signedRate === null ? null : Math.abs(signedRate),
      },
      reconciliation: resolveReconciliation(input.prepared, providerInputTokens),
      finalSnapshot: snapshot,
    },
  };
}

function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return tokenEstimator.estimateMessage({
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: 0,
  } as PiAgentMessage);
}

function estimateStructuredTokens(value: unknown): number {
  const serialized = safeJsonStringify(value);
  return serialized ? estimateTextTokens(serialized) : 0;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}

function toProviderMessageUsage(
  usage: ContextUsageProviderUsage | undefined,
): ContextUsageProviderMessageUsage {
  if (!usage) return {};
  return {
    ...(usage.input === undefined ? {} : { inputTokens: usage.input }),
    ...(usage.output === undefined ? {} : { outputTokens: usage.output }),
    ...(usage.cacheRead === undefined ? {} : { cacheReadTokens: usage.cacheRead }),
    ...(usage.cacheWrite === undefined ? {} : { cacheWriteTokens: usage.cacheWrite }),
    ...(usage.total === undefined ? {} : { totalTokens: usage.total }),
    ...(usage.contextWindow === undefined ? {} : { contextWindowTokens: usage.contextWindow }),
  };
}

function sumProviderInputTokens(usage: ContextUsageProviderUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const input = finiteNonNegative(usage.input);
  const cacheRead = finiteNonNegative(usage.cacheRead);
  const cacheWrite = finiteNonNegative(usage.cacheWrite);
  if (input === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined;
  return (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizePositiveInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function resolveReconciliation(
  prepared: PreparedContextEstimate,
  providerInputTokens: number | undefined,
): ContextUsageReconciliation {
  if (!prepared.valid || !validComponentWeights(prepared.components)) {
    return 'INVALID_BREAKDOWN';
  }
  if (providerInputTokens === undefined) return 'LOCAL_ONLY';
  return 'NORMALIZED_TO_PROVIDER';
}

function buildProviderAnchoredComponents(
  prepared: readonly ContextUsageComponent[],
  providerInputTokens: number,
  retainedTailTokens: number,
): ContextUsageComponent[] {
  if (!validComponentWeights(prepared)) return [];
  const providerInputAnchor = Math.max(0, Math.round(providerInputTokens));
  const anchored = normalizeComponents(prepared, providerInputAnchor);
  return addRetainedTail(anchored, retainedTailTokens);
}

function addRetainedTail(
  components: readonly ContextUsageComponent[],
  retainedTailTokens: number,
): ContextUsageComponent[] {
  if (components.length !== CONTEXT_USAGE_COMPONENT_KINDS.length) return [];
  return components.map((component) =>
    component.kind === 'MESSAGES'
      ? { ...component, tokens: component.tokens + retainedTailTokens }
      : component,
  );
}

function normalizeComponents(
  weights: readonly ContextUsageComponent[],
  targetTokens: number,
): ContextUsageComponent[] {
  if (!validComponentWeights(weights)) return [];

  const target = Math.max(0, Math.round(targetTokens));
  if (target === 0) {
    return weights.map((component) => ({ kind: component.kind, tokens: 0 }));
  }
  const totalWeight = weights.reduce((sum, component) => sum + component.tokens, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) return [];

  const quotas = weights.map((component, index) => {
    const exact = (component.tokens / totalWeight) * target;
    const floor = Math.floor(exact);
    return { kind: component.kind, index, floor, remainder: exact - floor };
  });
  const remaining = target - quotas.reduce((sum, quota) => sum + quota.floor, 0);
  const byRemainder = [...quotas].sort(
    (left, right) => right.remainder - left.remainder || left.index - right.index,
  );
  for (let index = 0; index < remaining; index += 1) {
    const quota = byRemainder[index];
    if (quota) quota.floor += 1;
  }
  return quotas.map((quota) => ({
    kind: quota.kind,
    tokens: quota.floor,
  }));
}
