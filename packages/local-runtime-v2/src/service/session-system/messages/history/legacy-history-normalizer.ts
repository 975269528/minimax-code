/**
 * Repairs only historical Messages-incompatible tool call/result shapes.
 *
 * Callers must pass a legacy-only segment. Active or mixed v2 history is outside this helper's
 * contract because removing current-runtime content would hide a writer bug.
 */
export interface LegacyHistoryNormalizationStats {
  readonly orphanToolCallDropped: number;
  readonly orphanToolResultDropped: number;
  readonly reorderedPairDropped: number;
  readonly emptyAssistantDropped: number;
  readonly inspected: number;
}

export interface LegacyHistoryNormalizationOptions {
  readonly tag?: string;
}

export interface LegacyHistoryItemAdapter<T> {
  message(item: T): Readonly<Record<string, unknown>>;
  replaceAssistantContent(item: T, content: readonly unknown[]): T;
}

export interface LegacyHistoryNormalizationResult<T> {
  readonly items: readonly T[];
  readonly warnings: readonly string[];
  readonly stats: LegacyHistoryNormalizationStats;
}

interface InFlight {
  readonly outIndex: number;
  readonly pendingIds: Set<string>;
  readonly dropReorderedForIds: Set<string>;
  seenAtLeastOneResult: boolean;
}

interface NormalizerState<T> {
  readonly out: T[];
  readonly warnings: string[];
  readonly stats: {
    orphanToolCallDropped: number;
    orphanToolResultDropped: number;
    reorderedPairDropped: number;
    emptyAssistantDropped: number;
    inspected: number;
  };
  readonly tagSuffix: string;
  readonly adapter: LegacyHistoryItemAdapter<T>;
  inFlight?: InFlight;
}

export function normalizeLegacyHistoryForMessages<T>(
  items: readonly T[],
  adapter: LegacyHistoryItemAdapter<T>,
  options: LegacyHistoryNormalizationOptions = {},
): LegacyHistoryNormalizationResult<T> {
  const state = createNormalizerState(items.length, adapter, options);
  items.forEach((item) => acceptHistoryItem(item, state));
  finaliseInFlight(state);
  return { items: state.out, warnings: state.warnings, stats: state.stats };
}

function createNormalizerState<T>(
  inspected: number,
  adapter: LegacyHistoryItemAdapter<T>,
  options: LegacyHistoryNormalizationOptions,
): NormalizerState<T> {
  return {
    out: [],
    warnings: [],
    stats: {
      orphanToolCallDropped: 0,
      orphanToolResultDropped: 0,
      reorderedPairDropped: 0,
      emptyAssistantDropped: 0,
      inspected,
    },
    tagSuffix: options.tag ? `:${options.tag}` : '',
    adapter,
  };
}

function acceptHistoryItem<T>(item: T, state: NormalizerState<T>): void {
  const role = readRole(item, state);
  if (role === 'toolResult') {
    acceptToolResult(item, state);
    return;
  }
  breakPendingPair(state);
  if (role === 'assistant') acceptAssistant(item, state);
  else state.out.push(item);
}

function acceptToolResult<T>(item: T, state: NormalizerState<T>): void {
  const toolCallId = readToolCallId(item, state);
  if (toolCallId && state.inFlight?.pendingIds.has(toolCallId)) {
    acceptMatchingToolResult(item, toolCallId, state);
    return;
  }
  if (toolCallId && state.inFlight?.dropReorderedForIds.has(toolCallId)) {
    dropReorderedToolResult(item, toolCallId, state);
    return;
  }
  state.warnings.push(
    `sanitizer_dropped_orphan_tool_result:${toolCallId ?? 'unknown'}:${readToolName(
      item,
      state,
    )}${state.tagSuffix}`,
  );
  state.stats.orphanToolResultDropped += 1;
}

function acceptMatchingToolResult<T>(item: T, toolCallId: string, state: NormalizerState<T>): void {
  const flight = state.inFlight;
  if (!flight) return;
  flight.pendingIds.delete(toolCallId);
  flight.seenAtLeastOneResult = true;
  state.out.push(item);
  if (flight.pendingIds.size === 0) state.inFlight = undefined;
}

function dropReorderedToolResult<T>(item: T, toolCallId: string, state: NormalizerState<T>): void {
  state.inFlight?.dropReorderedForIds.delete(toolCallId);
  state.warnings.push(
    `sanitizer_dropped_reordered_tool_pair:${toolCallId}:${readToolName(item, state)}${
      state.tagSuffix
    }`,
  );
  state.stats.reorderedPairDropped += 1;
}

function breakPendingPair<T>(state: NormalizerState<T>): void {
  const flight = state.inFlight;
  if (!flight || flight.pendingIds.size === 0) return;
  const assistant = state.out[flight.outIndex];
  if (!assistant || !assistantHasBlocks(assistant, state)) {
    state.inFlight = undefined;
    return;
  }
  recordDroppedCalls(assistant, flight, state);
  const filtered = filterToolCallBlocks(assistant, flight.pendingIds, state);
  const outIndex = replaceOrDropAssistant(filtered, flight.outIndex, state);
  state.inFlight = {
    outIndex,
    pendingIds: new Set<string>(),
    dropReorderedForIds: new Set([...flight.dropReorderedForIds, ...flight.pendingIds]),
    seenAtLeastOneResult: flight.seenAtLeastOneResult,
  };
}

function recordDroppedCalls<T>(assistant: T, flight: InFlight, state: NormalizerState<T>): void {
  flight.pendingIds.forEach((toolCallId) => {
    const toolName = readToolNameFromAssistant(assistant, toolCallId, state);
    if (flight.seenAtLeastOneResult) recordOrphanToolCall(toolCallId, toolName, state);
    else recordReorderedToolCall(toolCallId, toolName, state);
  });
}

function recordOrphanToolCall<T>(
  toolCallId: string,
  toolName: string,
  state: NormalizerState<T>,
): void {
  state.warnings.push(
    `sanitizer_dropped_orphan_tool_call:${toolCallId}:${toolName}${state.tagSuffix}`,
  );
  state.stats.orphanToolCallDropped += 1;
}

function recordReorderedToolCall<T>(
  toolCallId: string,
  toolName: string,
  state: NormalizerState<T>,
): void {
  state.warnings.push(
    `sanitizer_dropped_reordered_tool_pair:${toolCallId}:${toolName}${state.tagSuffix}`,
  );
  state.stats.reorderedPairDropped += 1;
}

function replaceOrDropAssistant<T>(
  filtered: T,
  outIndex: number,
  state: NormalizerState<T>,
): number {
  if (!isAssistantContentEmpty(filtered, state)) {
    state.out[outIndex] = filtered;
    return outIndex;
  }
  recordEmptyAssistant(state);
  state.out.splice(outIndex, 1);
  return -1;
}

function acceptAssistant<T>(assistant: T, state: NormalizerState<T>): void {
  if (!assistantHasBlocks(assistant, state) || isAssistantContentEmpty(assistant, state)) {
    recordEmptyAssistant(state);
    return;
  }
  const toolCallIds = readAssistantToolCallIds(assistant, state);
  state.out.push(assistant);
  if (toolCallIds.length === 0) return;
  state.inFlight = {
    outIndex: state.out.length - 1,
    pendingIds: new Set(toolCallIds),
    dropReorderedForIds: new Set<string>(),
    seenAtLeastOneResult: false,
  };
}

function recordEmptyAssistant<T>(state: NormalizerState<T>): void {
  state.warnings.push(`sanitizer_dropped_empty_assistant:1${state.tagSuffix}`);
  state.stats.emptyAssistantDropped += 1;
}

function finaliseInFlight<T>(state: NormalizerState<T>): void {
  const flight = state.inFlight;
  if (!flight || flight.pendingIds.size === 0) return;
  const assistant = state.out[flight.outIndex];
  if (!assistant || !assistantHasBlocks(assistant, state)) return;
  flight.pendingIds.forEach((toolCallId) => {
    recordOrphanToolCall(
      toolCallId,
      readToolNameFromAssistant(assistant, toolCallId, state),
      state,
    );
  });
  replaceOrDropAssistant(
    filterToolCallBlocks(assistant, flight.pendingIds, state),
    flight.outIndex,
    state,
  );
  state.inFlight = undefined;
}

function readRole<T>(item: T, state: NormalizerState<T>): string | undefined {
  const value = state.adapter.message(item)['role'];
  return typeof value === 'string' ? value : undefined;
}

function readToolCallId<T>(item: T, state: NormalizerState<T>): string | undefined {
  const value = state.adapter.message(item)['toolCallId'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readToolName<T>(item: T, state: NormalizerState<T>): string {
  const value = state.adapter.message(item)['toolName'];
  return typeof value === 'string' && value.length > 0 ? value : 'unknown';
}

function assistantHasBlocks<T>(item: T, state: NormalizerState<T>): boolean {
  return Array.isArray(state.adapter.message(item)['content']);
}

function isAssistantContentEmpty<T>(item: T, state: NormalizerState<T>): boolean {
  const content = state.adapter.message(item)['content'];
  return !Array.isArray(content) || content.length === 0;
}

function readAssistantToolCallIds<T>(item: T, state: NormalizerState<T>): string[] {
  const content = state.adapter.message(item)['content'];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!isToolCallBlock(block)) return [];
    return typeof block['id'] === 'string' && block['id'].length > 0 ? [block['id']] : [];
  });
}

function readToolNameFromAssistant<T>(
  item: T,
  toolCallId: string,
  state: NormalizerState<T>,
): string {
  const content = state.adapter.message(item)['content'];
  if (!Array.isArray(content)) return 'unknown';
  const block = content.find((entry) => isToolCallBlock(entry) && entry['id'] === toolCallId);
  if (!isToolCallBlock(block)) return 'unknown';
  const name = block['name'];
  return typeof name === 'string' && name.length > 0 ? name : 'unknown';
}

function filterToolCallBlocks<T>(
  item: T,
  toolCallIds: ReadonlySet<string>,
  state: NormalizerState<T>,
): T {
  const content = state.adapter.message(item)['content'];
  if (!Array.isArray(content)) return item;
  const filtered = content.filter(
    (block) =>
      !isToolCallBlock(block) || typeof block['id'] !== 'string' || !toolCallIds.has(block['id']),
  );
  return state.adapter.replaceAssistantContent(item, filtered);
}

function isToolCallBlock(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Reflect.get(value, 'type') === 'toolCall'
  );
}
