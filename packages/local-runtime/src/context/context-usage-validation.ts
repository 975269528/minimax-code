import {
  CONTEXT_USAGE_COMPONENT_KINDS,
  type ContextUsageComponent,
  type PromptRange,
} from './context-usage-types.js';

export function validPromptRanges(systemPrompt: string, ranges: readonly PromptRange[]): boolean {
  let previousEnd = 0;
  for (const range of ranges) {
    if (range.kind !== 'MEMORY' && range.kind !== 'SKILLS' && range.kind !== 'OTHER') return false;
    if (!Number.isInteger(range.startOffset) || !Number.isInteger(range.endOffset)) return false;
    if (range.startOffset < previousEnd || range.endOffset <= range.startOffset) return false;
    if (range.startOffset < 0 || range.endOffset > systemPrompt.length) return false;
    previousEnd = range.endOffset;
  }
  return true;
}

export function validComponentWeights(weights: readonly ContextUsageComponent[]): boolean {
  return (
    weights.length === CONTEXT_USAGE_COMPONENT_KINDS.length &&
    weights.every(
      (component, index) =>
        component.kind === CONTEXT_USAGE_COMPONENT_KINDS[index] &&
        Number.isFinite(component.tokens) &&
        component.tokens >= 0,
    )
  );
}
