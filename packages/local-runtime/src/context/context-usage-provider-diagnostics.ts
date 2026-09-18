import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Context, Model, SimpleStreamOptions, Tool } from '@earendil-works/pi-ai';

import type {
  ContextUsageComponentKind,
  ContextUsageProviderDiagnosticComponent,
  ContextUsageProviderDiagnostics,
  PreparedContextEstimate,
  PromptRange,
} from './context-usage-types.js';
import type {
  RemoteTokenCountContext,
  RemoteTokenCountResult,
  RemoteTokenCounter,
} from './remote-token-counter.js';

const DIAGNOSTIC_ORDER: readonly ContextUsageComponentKind[] = [
  'OTHER',
  'SYSTEM_PROMPT',
  'MEMORY',
  'SKILLS',
  'TOOLS',
  'MESSAGES',
];
const PRODUCT_ORDER: readonly ContextUsageComponentKind[] = [
  'SYSTEM_PROMPT',
  'MEMORY',
  'TOOLS',
  'SKILLS',
  'MESSAGES',
  'OTHER',
];
const BASELINE_MESSAGE: AgentMessage = {
  role: 'user',
  content: [{ type: 'text', text: '.' }],
  timestamp: 0,
};

export interface ContextUsageProviderDiagnosticsInput {
  context: Context;
  promptRanges: readonly PromptRange[];
  prepared: PreparedContextEstimate;
  model: Model<Api>;
  exactProviderPayload?: unknown;
  streamOptions?: SimpleStreamOptions;
  counter: RemoteTokenCounter;
  providerInputAnchor?: number;
  includeReconstructedFullComparison?: boolean;
}

interface DiagnosticStage {
  kind: ContextUsageComponentKind;
  systemPrompt?: string;
  tools?: Tool[];
  messages: AgentMessage[];
}

interface DiagnosticStageCount {
  result: RemoteTokenCountResult;
  retryRecovered?: string;
}

/**
 * Dev-only accounting experiment. Six cumulative Provider counts telescope to
 * the full payload. This is a deterministic diagnostic convention, not a
 * Provider-native semantic classification, and never feeds product state.
 */
export async function buildContextUsageProviderDiagnostics(
  input: ContextUsageProviderDiagnosticsInput,
): Promise<ContextUsageProviderDiagnostics> {
  const systemPrompt = input.context.systemPrompt ?? '';
  if (!input.prepared.valid || !validPromptRanges(systemPrompt, input.promptRanges)) {
    return emptyDiagnostics('INVALID_CONTEXT');
  }

  const stages = buildStages(input.context, input.promptRanges);
  try {
    const counts: DiagnosticStageCount[] = [];
    let reconstructedFullContext: RemoteTokenCountContext | undefined;
    const supportsExactProviderPayload =
      input.model.api === 'anthropic-messages' && input.exactProviderPayload !== undefined;
    for (const [index, stage] of stages.entries()) {
      const reconstructedContext = buildRemoteCountContext(input, stage);
      if (index === stages.length - 1) reconstructedFullContext = reconstructedContext;
      const countContext =
        index === stages.length - 1 && supportsExactProviderPayload
          ? { ...reconstructedContext, exactProviderPayload: input.exactProviderPayload }
          : reconstructedContext;
      counts.push(await countDiagnosticStage(input.counter, countContext));
    }
    const reconstructedFull =
      supportsExactProviderPayload &&
      input.includeReconstructedFullComparison !== false &&
      reconstructedFullContext
        ? await countDiagnosticStage(input.counter, reconstructedFullContext)
        : undefined;

    const rawByKind = new Map(
      input.prepared.components.map((component) => [component.kind, component.tokens]),
    );
    const orderedComponents = stages.map((stage, index) => {
      const currentStage = counts[index];
      if (!currentStage) throw new Error(`Missing Provider diagnostic stage ${stage.kind}`);
      const previousStage = index === 0 ? undefined : counts[index - 1];
      const providerTokens = currentStage.result.tokens - (previousStage?.result.tokens ?? 0);
      const rawPreparedTokens = rawByKind.get(stage.kind) ?? 0;
      const fallbackReasons = [
        ...(currentStage.result.source === 'estimate'
          ? [`current:${currentStage.result.fallbackReason ?? 'unknown'}`]
          : []),
        ...(previousStage?.result.source === 'estimate'
          ? [`previous:${previousStage.result.fallbackReason ?? 'unknown'}`]
          : []),
      ];
      const retryRecovered = [
        ...(currentStage.retryRecovered ? [`current:${currentStage.retryRecovered}`] : []),
        ...(previousStage?.retryRecovered ? [`previous:${previousStage.retryRecovered}`] : []),
      ];
      return {
        kind: stage.kind,
        providerTokens,
        rawPreparedTokens,
        estimatorMinusProviderTokens: rawPreparedTokens - providerTokens,
        source: fallbackReasons.length === 0 ? 'remote' : 'estimate',
        ...(fallbackReasons.length > 0 ? { fallbackReason: fallbackReasons.join(',') } : {}),
        ...(retryRecovered.length > 0 ? { retryRecovered: retryRecovered.join(',') } : {}),
      } satisfies ContextUsageProviderDiagnosticComponent;
    });
    const components = PRODUCT_ORDER.map((kind) => {
      const component = orderedComponents.find((candidate) => candidate.kind === kind);
      if (!component) throw new Error(`Missing Provider diagnostic component ${kind}`);
      return component;
    });
    const fullCount = counts.at(-1);
    if (!fullCount) throw new Error('Provider diagnostics produced no stages');
    const providerFullTokens = fullCount.result.tokens;
    return {
      status:
        counts.every((count) => count.result.source === 'remote') &&
        (!reconstructedFull || reconstructedFull.result.source === 'remote')
          ? 'REMOTE'
          : 'FALLBACK_ESTIMATE',
      method: 'ORDERED_INCREMENTAL',
      fullCountBasis: supportsExactProviderPayload
        ? 'EXACT_PROVIDER_PAYLOAD'
        : 'RECONSTRUCTED_CONTEXT',
      order: [...DIAGNOSTIC_ORDER],
      providerFullTokens,
      providerFullVsInputAnchorTokens:
        input.providerInputAnchor === undefined
          ? null
          : providerFullTokens - input.providerInputAnchor,
      reconstructedFullTokens: reconstructedFull?.result.tokens ?? null,
      reconstructedFullVsExactTokens:
        reconstructedFull === undefined
          ? null
          : reconstructedFull.result.tokens - providerFullTokens,
      rawPreparedMinusProviderTokens: input.prepared.usedTokens - providerFullTokens,
      closureTokens:
        components.reduce((total, component) => total + component.providerTokens, 0) -
        providerFullTokens,
      components,
    };
  } catch (error) {
    return {
      ...emptyDiagnostics('FAILED'),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildRemoteCountContext(
  input: ContextUsageProviderDiagnosticsInput,
  stage: DiagnosticStage,
): RemoteTokenCountContext {
  return {
    messages: stage.messages,
    model: input.model,
    ...(input.streamOptions?.apiKey ? { apiKey: input.streamOptions.apiKey } : {}),
    ...(input.streamOptions?.headers ? { headers: input.streamOptions.headers } : {}),
    ...(stage.systemPrompt ? { systemPrompt: stage.systemPrompt } : {}),
    ...(stage.tools ? { tools: stage.tools } : {}),
    ...(input.streamOptions?.maxTokens !== undefined
      ? { maxTokens: input.streamOptions.maxTokens }
      : {}),
    ...(input.streamOptions?.cacheRetention
      ? { cacheRetention: input.streamOptions.cacheRetention }
      : {}),
    ...(input.streamOptions?.reasoning ? { thinkingLevel: input.streamOptions.reasoning } : {}),
    // Intentionally omit the generation AbortSignal: diagnostics start after
    // terminal and must remain a detached, non-blocking sidecar.
  };
}

function emptyDiagnostics(status: 'INVALID_CONTEXT' | 'FAILED'): ContextUsageProviderDiagnostics {
  return {
    status,
    method: 'ORDERED_INCREMENTAL',
    fullCountBasis: 'RECONSTRUCTED_CONTEXT',
    order: [...DIAGNOSTIC_ORDER],
    providerFullTokens: null,
    providerFullVsInputAnchorTokens: null,
    reconstructedFullTokens: null,
    reconstructedFullVsExactTokens: null,
    rawPreparedMinusProviderTokens: null,
    closureTokens: null,
    components: [],
  };
}

async function countDiagnosticStage(
  counter: RemoteTokenCounter,
  context: RemoteTokenCountContext,
): Promise<DiagnosticStageCount> {
  const initial = await counter.countContextTokens(context);
  if (initial.source !== 'estimate' || initial.fallbackReason !== 'malformed_body') {
    return { result: initial };
  }
  const retry = await counter.countContextTokens(context);
  return {
    result: retry,
    ...(retry.source === 'remote' ? { retryRecovered: initial.fallbackReason } : {}),
  };
}

function buildStages(context: Context, ranges: readonly PromptRange[]): DiagnosticStage[] {
  const fullSystemPrompt = context.systemPrompt ?? '';
  const otherPrompt = buildPromptSubset(fullSystemPrompt, ranges, new Set(['OTHER']));
  const systemPrompt = buildPromptSubset(
    fullSystemPrompt,
    ranges,
    new Set(['OTHER', 'SYSTEM_PROMPT']),
  );
  const withMemory = buildPromptSubset(
    fullSystemPrompt,
    ranges,
    new Set(['OTHER', 'SYSTEM_PROMPT', 'MEMORY']),
  );
  const withSkills = buildPromptSubset(
    fullSystemPrompt,
    ranges,
    new Set(['OTHER', 'SYSTEM_PROMPT', 'MEMORY', 'SKILLS']),
  );
  return [
    {
      kind: 'OTHER',
      ...(otherPrompt ? { systemPrompt: otherPrompt } : {}),
      messages: [BASELINE_MESSAGE],
    },
    {
      kind: 'SYSTEM_PROMPT',
      ...(systemPrompt ? { systemPrompt } : {}),
      messages: [BASELINE_MESSAGE],
    },
    {
      kind: 'MEMORY',
      ...(withMemory ? { systemPrompt: withMemory } : {}),
      messages: [BASELINE_MESSAGE],
    },
    {
      kind: 'SKILLS',
      ...(withSkills ? { systemPrompt: withSkills } : {}),
      messages: [BASELINE_MESSAGE],
    },
    {
      kind: 'TOOLS',
      ...(fullSystemPrompt ? { systemPrompt: fullSystemPrompt } : {}),
      tools: [...(context.tools ?? [])],
      messages: [BASELINE_MESSAGE],
    },
    {
      kind: 'MESSAGES',
      ...(fullSystemPrompt ? { systemPrompt: fullSystemPrompt } : {}),
      tools: [...(context.tools ?? [])],
      messages: [...(context.messages ?? [])],
    },
  ];
}

function buildPromptSubset(
  systemPrompt: string,
  ranges: readonly PromptRange[],
  selected: ReadonlySet<'SYSTEM_PROMPT' | PromptRange['kind']>,
): string {
  let previousEnd = 0;
  const chunks: string[] = [];
  for (const range of ranges) {
    if (selected.has('SYSTEM_PROMPT'))
      chunks.push(systemPrompt.slice(previousEnd, range.startOffset));
    if (selected.has(range.kind))
      chunks.push(systemPrompt.slice(range.startOffset, range.endOffset));
    previousEnd = range.endOffset;
  }
  if (selected.has('SYSTEM_PROMPT')) chunks.push(systemPrompt.slice(previousEnd));
  return chunks.join('');
}

function validPromptRanges(systemPrompt: string, ranges: readonly PromptRange[]): boolean {
  let previousEnd = 0;
  for (const range of ranges) {
    if (
      (range.kind !== 'MEMORY' && range.kind !== 'SKILLS' && range.kind !== 'OTHER') ||
      !Number.isInteger(range.startOffset) ||
      !Number.isInteger(range.endOffset) ||
      range.startOffset < previousEnd ||
      range.endOffset <= range.startOffset ||
      range.startOffset < 0 ||
      range.endOffset > systemPrompt.length
    ) {
      return false;
    }
    previousEnd = range.endOffset;
  }
  return true;
}
