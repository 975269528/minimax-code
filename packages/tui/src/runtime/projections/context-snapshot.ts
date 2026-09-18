import type { TuiContextSnapshotResponse } from '../port.js';

interface ContextMessageView {
  readonly kind?: string;
  readonly timestamp?: number | bigint;
  readonly rawJson?: string;
}

interface ContextModelView {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly contextLimit?: number | bigint;
}

export function projectTuiContextSnapshot(input: {
  readonly messages: readonly ContextMessageView[];
  readonly active: boolean;
  readonly model?: ContextModelView;
}): TuiContextSnapshotResponse {
  let latestUsage: NonNullable<TuiContextSnapshotResponse['contextUsage']> | undefined;
  let compaction: TuiContextSnapshotResponse['compaction'];
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (!message) continue;
    if (!compaction) compaction = projectCompaction(message);
    if (!latestUsage) latestUsage = readContextUsage(message.rawJson);
    if (compaction && latestUsage) break;
  }
  const model = projectContextModel(input.model);
  if (!latestUsage) {
    return {
      status: input.active ? 'loading' : 'empty',
      ...(model ? { model } : {}),
      ...(compaction ? { compaction } : {}),
    };
  }
  return {
    status: input.active ? 'stale' : 'live',
    ...(model ? { model } : {}),
    contextUsage: latestUsage,
    compaction: compaction ?? { state: 'never' },
  };
}

function projectContextModel(
  model: ContextModelView | undefined,
): TuiContextSnapshotResponse['model'] | undefined {
  if (!model?.providerId || !model.modelId) return undefined;
  const contextWindow = model.contextLimit === undefined ? undefined : Number(model.contextLimit);
  return {
    provider: model.providerId,
    id: model.modelId,
    ...(contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
      ? { contextWindow }
      : {}),
  };
}

function readContextUsage(
  rawJson: string | undefined,
): NonNullable<TuiContextSnapshotResponse['contextUsage']> | undefined {
  if (!rawJson) return undefined;
  let message: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!isRecord(parsed)) return undefined;
    message = parsed;
  } catch {
    return undefined;
  }
  const rawUsage = message.contextUsage ?? message.context_usage;
  if (!isRecord(rawUsage)) return undefined;
  const contextWindowTokens = nonNegativeNumber(rawUsage.contextWindowTokens);
  const usedTokens = nonNegativeNumber(rawUsage.usedTokens);
  const totalCountSource = rawUsage.totalCountSource;
  if (
    contextWindowTokens === undefined ||
    usedTokens === undefined ||
    (totalCountSource !== 'LOCAL_ESTIMATE' && totalCountSource !== 'PROVIDER_USAGE_ANCHORED')
  ) {
    return undefined;
  }
  const components = Array.isArray(rawUsage.components)
    ? rawUsage.components.flatMap((component) => {
        if (!isRecord(component) || !isContextComponentKind(component.kind)) return [];
        const tokens = nonNegativeNumber(component.tokens);
        return tokens === undefined ? [] : [{ kind: component.kind, tokens }];
      })
    : [];
  return { contextWindowTokens, usedTokens, totalCountSource, components };
}

function projectCompaction(
  message: Pick<ContextMessageView, 'kind' | 'timestamp'>,
): TuiContextSnapshotResponse['compaction'] | undefined {
  const state =
    message.kind === 'compaction_start'
      ? 'running'
      : message.kind === 'compaction'
        ? 'completed'
        : message.kind === 'compaction_failed'
          ? 'failed'
          : undefined;
  if (!state) return undefined;
  return {
    state,
    ...(message.timestamp !== undefined && Number.isFinite(Number(message.timestamp))
      ? { lastCompactedAtMs: Number(message.timestamp) }
      : {}),
  };
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isContextComponentKind(
  value: unknown,
): value is NonNullable<TuiContextSnapshotResponse['contextUsage']>['components'][number]['kind'] {
  return (
    value === 'SYSTEM_PROMPT' ||
    value === 'MEMORY' ||
    value === 'TOOLS' ||
    value === 'SKILLS' ||
    value === 'MESSAGES' ||
    value === 'OTHER'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
