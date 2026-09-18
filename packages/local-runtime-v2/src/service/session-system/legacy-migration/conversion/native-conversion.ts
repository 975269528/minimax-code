import type { Api } from '@earendil-works/pi-ai';

import type { LegacyOpenCodeNativeMessage, LegacyOpenCodeNativePart } from '../repo/contract.js';
import {
  isNonAssistantScaffoldingPart,
  isToolCallPart,
  isToolResultPart,
  nativeToolResultMessage,
  readNativeDataRecord,
  readNativeDataText,
} from './native-parts.js';
import type {
  NativePiHistoryCounts,
  NativePiHistoryLosses,
  LegacyPiHistoryMessage,
  PiHistoryGroup,
} from './native-conversion-types.js';
import { resolveApiForLegacyProvider } from './provider-api.js';

export type {
  LegacyPiHistoryMessage,
  NativePiHistoryCounts,
  NativePiHistoryLosses,
  PiHistoryGroup,
} from './native-conversion-types.js';
export {
  filterCompactedNativeMessages,
  type FilterCompactedResult,
} from './native-compaction-filter.js';

// `PiHistoryGroup` shape — see `legacy-opencode-native-conversion-types.ts`
// (re-exported above). Introduced in v3 (round-5) to fix the P1 where
// long-running tools completed AFTER a follow-up user message was
// appended, and a naive `sort by row-timestamp` in `buildPiHistory` slid
// that user row between the assistant `toolCall` block and its paired
// `toolResult` — the Messages-compatible endpoint then rejects the turn with
// `messages: tool_use ids were found without tool_result blocks
// immediately after`.
//
// v3 sorts by `leaderTimestamp` (= the atomic opencode
// `message.time_created` that opencode itself sorts on) instead of the
// per-row `.timestamp`. Tool calls and their results share the same
// opencode source-message, so they live in the same group and stay
// adjacent regardless of when the tool actually finished.

export interface NativePiHistoryConversionResult {
  /**
   * Group-shaped output introduced in v3. Callers get a flat list by
   * `result.groups.flatMap((g) => g.messages)`.
   *
   * v2 returned a flat `messages` array; migrating callers should switch
   * to `groups` so the group-aware merge in `buildPiHistory` keeps
   * `assistant → toolResult` adjacency across long-running tools.
   */
  groups: PiHistoryGroup[];
  warnings: string[];
  losses: NativePiHistoryLosses;
  counts: NativePiHistoryCounts;
  degraded: boolean;
}

/**
 * Bumped when the converter output shape changes in a way that older
 * migrated pi-history rows can no longer resume. Persisted on the migration
 * record alongside `piHistoryStrategy`; callers check
 * `isLegacyPiHistoryConverterCurrent` to decide whether an existing
 * `migrated` session must be re-migrated to pick up the fix.
 *
 * v1 (initial) emitted `{type: 'reasoning', text}`, `{type: 'tool-call',
 *   toolCallId, toolName, args}` and `role: 'tool'` — none of which the
 *   pi-agent runtime recognises, so tool calls silently disappeared from
 *   assistant messages and tool results never re-hydrated.
 * v2 aligns with `@earendil-works/pi-agent-core` types: `{type: 'thinking',
 *   thinking}`, `{type: 'toolCall', id, name, arguments}`, and
 *   `role: 'toolResult'` for the follow-up message. Opencode collapses
 *   tool call + result inside one `part` (`data.state.{input,output,error,
 *   status}`); v2 also splits it into the pair of records pi-agent expects.
 * v3 adds group-aware output (`PiHistoryGroup[]` instead of a flat
 *   `messages: PiAgentMessage[]`) so `buildPiHistory` can sort by
 *   opencode's atomic `message.time_created` (the leader timestamp)
 *   without ever slipping a follow-up user message between an assistant
 *   `toolCall` block and its paired `toolResult` when the tool took a
 *   long time to complete. v3 also emits opencode CompactionPart as a
 *   `kind='user'` group carrying "What did we do so far?" (mirrors
 *   opencode's `toModelMessages`) and, at the migrator level, truncates
 *   the source stream through `filterCompactedNativeMessages` so
 *   pre-compaction bulk is dropped instead of flooding pi-history.
 *   Records stamped with an older `piHistoryConverterVersion` are
 *   detected by `isLegacyPiHistoryConverterCurrent` and re-migrated.
 * v4 backfills the assistant `api` field. Opencode-native rows carry
 *   `providerID` + `modelID` but no `api` (opencode has no such concept),
 *   so v1-v3 emitted assistant messages with `api === undefined`. That
 *   undefined broke the outbound replay classifier
 *   (`normalizeAssistantMessage`): `sameProviderAndApi` compares
 *   `api === target.api`, so `undefined` forced every migrated thinking
 *   block down the cross-provider branch that wraps it in a
 *   `<|prior-thinking|>…</|prior-thinking|>` text marker — which the model
 *   then leaked into visible output after an upgrade. v4 derives `api`
 *   from the same source the live model resolver uses (pi-ai catalog +
 *   provider-family fallback, see `resolveApiForLegacyProvider`) so
 *   same-provider upgrades classify as same/sibling and keep native
 *   thinking replay. Records stamped `< 4` are re-migrated (or no-op
 *   stamped, if pi-agent already replaced the history) by the version
 *   upgrade path in the migrator.
 */
export const NATIVE_PI_HISTORY_CONVERTER_VERSION = 4;

/**
 * Resolve the pi-ai `api` for a migrated assistant message from its
 * opencode `providerID` (+ `modelID`). Defaults to the catalog-backed
 * `resolveApiForLegacyProvider` so the migrator gets the backfill for free;
 * unit tests inject a stub to stay independent of the pi-ai catalog.
 */
export type ResolveApiForProvider = (provider: string, model?: string) => Api | undefined;

/**
 * Convert native opencode `message` + `part` rows into pi-agent history
 * messages. The legacy schema interleaves user / assistant / tool entries
 * across the `role` column and JSON-encoded `part.data`; this routine
 * normalises them into pi-agent's role-based shape while accounting for
 * the lossy bits we can no longer resume (interrupted tool runs, dropped
 * empty messages, unknown roles).
 */
export function convertNativeMessagesToPiHistory(
  messages: readonly LegacyOpenCodeNativeMessage[],
  nowMs: () => number,
  resolveApi: ResolveApiForProvider = resolveApiForLegacyProvider,
): NativePiHistoryConversionResult {
  const state = createConversionState(nowMs, resolveApi);
  messages.forEach((message) => countNativeSource(message, state.counts));
  messages.forEach((message) => convertNativeMessage(message, state));
  appendLossWarnings(state);
  appendToolQualityWarning(state);
  return {
    groups: state.groups,
    warnings: state.warnings,
    losses: state.losses,
    counts: state.counts,
    degraded: state.warnings.length > 0,
  };
}

interface ConversionState {
  readonly groups: PiHistoryGroup[];
  readonly warnings: string[];
  readonly losses: NativePiHistoryLosses;
  readonly counts: NativePiHistoryCounts;
  readonly nowMs: () => number;
  readonly resolveApi: ResolveApiForProvider;
}

function createConversionState(
  nowMs: () => number,
  resolveApi: ResolveApiForProvider,
): ConversionState {
  return {
    groups: [],
    warnings: [],
    losses: {
      emptyMessages: 0,
      unknownRoles: 0,
      unsupportedParts: 0,
      interruptedTools: 0,
      parseLoss: 0,
    },
    counts: {
      source: { userMessages: 0, assistantMessages: 0, toolCall: 0, reasoning: 0, text: 0 },
      converted: {
        userMessages: 0,
        assistantMessages: 0,
        toolResultMessages: 0,
        toolCall: 0,
        thinking: 0,
        text: 0,
      },
    },
    nowMs,
    resolveApi,
  };
}

function countNativeSource(
  message: LegacyOpenCodeNativeMessage,
  counts: NativePiHistoryCounts,
): void {
  const role = normalizeNativeRole(message.role, message.parts);
  if (role === 'user') counts.source.userMessages += 1;
  if (role === 'assistant') counts.source.assistantMessages += 1;
  message.parts.forEach((part) => countNativePart(part, counts));
}

function countNativePart(part: LegacyOpenCodeNativePart, counts: NativePiHistoryCounts): void {
  const category = nativePartCategory(part);
  if (category === 'text') counts.source.text += 1;
  if (category === 'reasoning') counts.source.reasoning += 1;
  if (category === 'tool') counts.source.toolCall += 1;
}

function nativePartCategory(
  part: LegacyOpenCodeNativePart,
): 'text' | 'reasoning' | 'tool' | 'other' {
  const type = part.type.toLowerCase();
  if (TEXT_PART_TYPES.has(type)) return 'text';
  if (THINKING_PART_TYPES.has(type)) return 'reasoning';
  return isToolCallPart(part) ? 'tool' : 'other';
}

function convertNativeMessage(message: LegacyOpenCodeNativeMessage, state: ConversionState): void {
  const role = normalizeNativeRole(message.role, message.parts);
  const timestamp = message.timestamp ?? firstPartTimestamp(message.parts) ?? state.nowMs();
  if (role === 'user') return addUserMessage(message, timestamp, state);
  if (role === 'assistant') return addAssistantMessage(message, timestamp, state);
  if (role === 'tool') return addStandaloneToolMessages(message, timestamp, state);
  state.losses.unknownRoles += 1;
}

function addUserMessage(
  message: LegacyOpenCodeNativeMessage,
  timestamp: number,
  state: ConversionState,
): void {
  const text = hasCompactionPart(message.parts)
    ? 'What did we do so far?'
    : collectNativeText(message.parts);
  if (!text.trim()) {
    state.losses.emptyMessages += 1;
    return;
  }
  state.groups.push({
    leaderTimestamp: timestamp,
    kind: 'user',
    sourceMessageId: message.id,
    messages: [{ role: 'user', content: [{ type: 'text', text }], timestamp }],
  });
  state.counts.converted.userMessages += 1;
  state.counts.converted.text += 1;
}

function addAssistantMessage(
  message: LegacyOpenCodeNativeMessage,
  timestamp: number,
  state: ConversionState,
): void {
  const content = buildAssistantContentBlocks(message, state.losses);
  if (content.length === 0) {
    state.losses.emptyMessages += 1;
    return;
  }
  const assistantMessage = {
    role: 'assistant',
    content,
    timestamp,
    ...(message.model ? { model: message.model } : {}),
    ...(message.provider ? { provider: message.provider } : {}),
    ...assistantApi(message, state.resolveApi),
  };
  countAssistantContent(content, state.counts);
  const groupMessages = [assistantMessage, ...nativeToolResults(message, timestamp, state)];
  state.groups.push({
    leaderTimestamp: timestamp,
    kind: 'assistant',
    sourceMessageId: message.id,
    messages: groupMessages,
  });
}

function assistantApi(
  message: LegacyOpenCodeNativeMessage,
  resolveApi: ResolveApiForProvider,
): { api?: Api } {
  const api = message.api ?? resolvedProviderApi(message, resolveApi);
  return api ? { api } : {};
}

function resolvedProviderApi(
  message: LegacyOpenCodeNativeMessage,
  resolveApi: ResolveApiForProvider,
): Api | undefined {
  return message.provider ? resolveApi(message.provider, message.model) : undefined;
}

function countAssistantContent(
  content: readonly Record<string, unknown>[],
  counts: NativePiHistoryCounts,
): void {
  counts.converted.assistantMessages += 1;
  content.forEach((block) => {
    if (block['type'] === 'text') counts.converted.text += 1;
    if (block['type'] === 'thinking') counts.converted.thinking += 1;
    if (block['type'] === 'toolCall') counts.converted.toolCall += 1;
  });
}

function nativeToolResults(
  message: LegacyOpenCodeNativeMessage,
  timestamp: number,
  state: ConversionState,
): LegacyPiHistoryMessage[] {
  return message.parts.flatMap((part, partIndex) => {
    const result = nativeToolResultMessage(
      part,
      timestamp,
      state.losses,
      fallbackToolCallId(message.id, partIndex),
    );
    if (!result) return [];
    state.counts.converted.toolResultMessages += 1;
    return [result];
  });
}

function addStandaloneToolMessages(
  message: LegacyOpenCodeNativeMessage,
  timestamp: number,
  state: ConversionState,
): void {
  nativeToolResults(message, timestamp, state).forEach((toolResult) => {
    state.groups.push({
      leaderTimestamp: timestamp,
      kind: 'tool',
      sourceMessageId: message.id,
      messages: [toolResult],
    });
  });
}

function appendLossWarnings(state: ConversionState): void {
  Object.entries(state.losses).forEach(([key, count]) => {
    if (count > 0) state.warnings.push(`legacy_native_${kebabCase(key)}:${count}`);
  });
}

function appendToolQualityWarning(state: ConversionState): void {
  const source = state.counts.source.toolCall;
  const converted = state.counts.converted.toolCall;
  if (source === 0 || converted === source) return;
  if (converted === 0) {
    state.warnings.push(`legacy_native_tool_call_dropped:${source}`);
    return;
  }
  state.warnings.push(`legacy_native_tool_call_partial:${converted}/${source}`);
}

function normalizeNativeRole(
  role: string | undefined,
  parts: readonly LegacyOpenCodeNativePart[],
): 'user' | 'assistant' | 'tool' | undefined {
  const normalized = role?.trim().toLowerCase();
  if (normalized === 'user') return 'user';
  if (normalized === 'assistant') return 'assistant';
  if (normalized === 'tool') return 'tool';
  if (parts.some(isToolCallPart)) return 'assistant';
  if (parts.some(isToolResultPart)) return 'tool';
  return normalized ? undefined : 'assistant';
}

function collectNativeText(parts: readonly LegacyOpenCodeNativePart[]): string {
  return parts
    .flatMap((part) => {
      if (part.text) return [part.text];
      const dataText = readNativeDataText(part.data, ['text', 'content', 'summary']);
      return dataText ? [dataText] : [];
    })
    .join('\n');
}

function buildAssistantContentBlocks(
  message: LegacyOpenCodeNativeMessage,
  losses: NativePiHistoryLosses,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const [partIndex, part] of message.parts.entries()) {
    const block = assistantContentBlock(part, fallbackToolCallId(message.id, partIndex), losses);
    if (block) blocks.push(block);
  }
  return blocks;
}

function assistantContentBlock(
  part: LegacyOpenCodeNativePart,
  fallbackId: string,
  losses: NativePiHistoryLosses,
): Record<string, unknown> | undefined {
  const type = part.type.toLowerCase();
  if (TEXT_PART_TYPES.has(type)) return textContentBlock(part);
  if (THINKING_PART_TYPES.has(type)) return thinkingContentBlock(part);
  if (isToolCallPart(part)) return toolCallContentBlock(part, fallbackId);
  if (isToolResultPart(part) || isNonAssistantScaffoldingPart(type)) return undefined;
  losses.unsupportedParts += 1;
  return undefined;
}

function textContentBlock(part: LegacyOpenCodeNativePart): Record<string, unknown> | undefined {
  const text = part.text ?? readNativeDataText(part.data, ['text', 'content']);
  return text ? { type: 'text', text } : undefined;
}

function thinkingContentBlock(part: LegacyOpenCodeNativePart): Record<string, unknown> | undefined {
  const thinking = part.text ?? readNativeDataText(part.data, ['text', 'content', 'thinking']);
  return thinking ? { type: 'thinking', thinking } : undefined;
}

function toolCallContentBlock(
  part: LegacyOpenCodeNativePart,
  fallbackId: string,
): Record<string, unknown> {
  return {
    type: 'toolCall',
    id: part.toolCallId ?? part.id ?? fallbackId,
    name:
      part.toolName ??
      readNativeDataText(part.data, ['toolName', 'tool_name', 'name', 'tool']) ??
      'unknown',
    arguments: nativeToolArguments(part),
  };
}

function fallbackToolCallId(sourceMessageId: string, partIndex: number): string {
  return `legacy-tool-${sourceMessageId}-${partIndex + 1}`;
}

function nativeToolArguments(part: LegacyOpenCodeNativePart): Record<string, unknown> {
  return (
    readNativeDataRecord(part.state, ['input']) ??
    readNativeDataRecord(part.data, ['args', 'input', 'parameters']) ??
    nativeDataRecord(part.data) ??
    {}
  );
}

function nativeDataRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function firstPartTimestamp(parts: readonly LegacyOpenCodeNativePart[]): number | undefined {
  return parts.find((part) => typeof part.timestamp === 'number')?.timestamp;
}

/**
 * True when any part inside this opencode message is a `compaction` part
 * (opencode summarisation marker). Used by
 * `convertNativeMessagesToPiHistory` to translate the compaction marker
 * into a `{role:'user', text:'What did we do so far?'}` message —
 * mirrors opencode's own `toModelMessages` behaviour so pi-agent replays
 * the same conversational shape opencode does after a compaction.
 */
function hasCompactionPart(parts: readonly LegacyOpenCodeNativePart[]): boolean {
  return parts.some((part) => part.type.toLowerCase() === 'compaction');
}

function kebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

const TEXT_PART_TYPES = new Set(['text', 'message', 'assistant_text']);
const THINKING_PART_TYPES = new Set(['reasoning', 'thinking']);
