export const CONTEXT_USAGE_COMPONENT_KINDS = [
  'SYSTEM_PROMPT',
  'MEMORY',
  'TOOLS',
  'SKILLS',
  'MESSAGES',
  'OTHER',
] as const;

export type ContextUsageComponentKind = (typeof CONTEXT_USAGE_COMPONENT_KINDS)[number];

export interface ContextUsageComponent {
  readonly kind: ContextUsageComponentKind;
  readonly tokens: number;
}

export interface ContextUsageSnapshot {
  readonly contextWindowTokens: number;
  readonly usedTokens: number;
  readonly totalCountSource: 'LOCAL_ESTIMATE' | 'PROVIDER_USAGE_ANCHORED';
  readonly components: readonly ContextUsageComponent[];
}

export interface ContextUsagePromptRange {
  readonly kind: 'MEMORY' | 'SKILLS' | 'OTHER';
  readonly startOffset: number;
  readonly endOffset: number;
}
