/**
 * Opencode-native part-level helpers used by
 * `convertNativeMessagesToPiHistory`. Split out to keep the converter
 * file under the local-runtime layout gate's 500-line budget.
 *
 * The helpers all speak the opencode `type: 'tool'` shape:
 *   - `isToolCallPart` — every opencode tool part yields both an
 *     assistant `toolCall` content block AND a paired `toolResult`
 *     message, because opencode collapses both into one row.
 *   - `nativeToolResultMessage` — emits the pi-agent `toolResult`
 *     message paired to a tool call; interrupted / pending states
 *     produce a stable placeholder text so the Messages-compatible endpoint does not reject
 *     the turn.
 *   - `isNonAssistantScaffoldingPart` — opencode's internal bookkeeping
 *     part types (`step-start`, `snapshot`, etc.) that don't map to
 *     any pi-agent content block.
 */
import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';

import type { LegacyOpenCodeNativePart } from './legacy-opencode-store.js';
import type { NativePiHistoryLosses } from './legacy-opencode-native-conversion-types.js';

export function nativeToolResultMessage(
  part: LegacyOpenCodeNativePart,
  timestamp: number,
  losses: NativePiHistoryLosses,
): PiAgentMessage | undefined {
  if (!isToolResultPart(part)) return undefined;
  const rawStatus = part.status?.trim().toLowerCase();
  const interrupted =
    rawStatus === 'pending' ||
    rawStatus === 'running' ||
    rawStatus === 'active' ||
    rawStatus === 'streaming';
  if (interrupted) losses.interruptedTools += 1;
  const errored = rawStatus === 'error' || rawStatus === 'failed';
  const text = interrupted
    ? 'Legacy opencode tool execution was interrupted during migration and was not resumed.'
    : (readNativeOutputText(part) ??
      part.text ??
      readNativeDataText(part.data, ['text', 'content', 'output', 'result', 'error']) ??
      safeJson(part.data ?? part.raw ?? {}));
  return {
    role: 'toolResult',
    toolCallId: part.toolCallId ?? part.id ?? `legacy-tool-${timestamp}`,
    toolName:
      part.toolName ??
      readNativeDataText(part.data, ['toolName', 'tool_name', 'name', 'tool']) ??
      'unknown',
    content: [{ type: 'text', text }],
    timestamp: part.timestamp ?? timestamp,
    isError: interrupted || errored,
    ...(interrupted ? { status: 'interrupted' } : {}),
  } as unknown as PiAgentMessage;
}

/**
 * Prefer opencode's `state.output` / `state.error` as the tool result body.
 * Opencode combines call + result inside `state`, whereas the legacy
 * pathway used to hunt `part.text` / arbitrary `data.output` — that missed
 * the actual output text and fell through to `safeJson(part.data)`
 * (raw dump). The store hoists `state` into `part.state` so this stays a
 * clean field lookup rather than nested JSON traversal.
 */
function readNativeOutputText(part: LegacyOpenCodeNativePart): string | undefined {
  if (part.state) {
    if (typeof part.state.output === 'string' && part.state.output.length > 0) {
      return part.state.output;
    }
    if (typeof part.state.error === 'string' && part.state.error.length > 0) {
      return part.state.error;
    }
  }
  const stateFromData = readNativeDataRecord(part.data, ['state']);
  if (stateFromData) {
    const outputValue = stateFromData['output'];
    if (typeof outputValue === 'string' && outputValue.length > 0) return outputValue;
    const errorValue = stateFromData['error'];
    if (typeof errorValue === 'string' && errorValue.length > 0) return errorValue;
  }
  return undefined;
}

/**
 * Opencode's `type === 'tool'` combines call + result. Pi-agent needs both,
 * so we emit a call block from the assistant + a follow-up toolResult
 * message. Callers detect the pair by testing the same part twice, which
 * means `isToolCallPart` and `isToolResultPart` both match here — that's
 * intentional.
 */
export function isToolCallPart(part: LegacyOpenCodeNativePart): boolean {
  const type = part.type.toLowerCase();
  if (type === 'tool') return true;
  return (
    type.includes('tool') && (type.includes('call') || Boolean(part.toolName || part.toolCallId))
  );
}

export function isToolResultPart(part: LegacyOpenCodeNativePart): boolean {
  const type = part.type.toLowerCase();
  if (type === 'tool') {
    // Opencode collapses call + result on one part. EVERY `type: 'tool'`
    // part MUST produce a toolResult companion so the assistant's
    // toolCall block (emitted unconditionally by `isToolCallPart` /
    // `buildAssistantContentBlocks`) stays paired — pi-agent + Messages-compatible
    // reject `tool_use` blocks without an immediately following
    // `tool_result` (`messages: tool_use ids were found without
    // tool_result blocks immediately after`). In-flight states
    // (`pending` / `running` / `active` / `streaming`) flow through
    // `nativeToolResultMessage`'s interrupted branch to emit a stable
    // "interrupted during migration" placeholder, so we return true
    // whenever the state block is present regardless of status. Missing
    // state block (older opencode row shapes) falls back to requiring
    // the outer `status` column as evidence there was ever a tool.
    if (part.state) return true;
    return Boolean(part.status);
  }
  return type.includes('tool') && (type.includes('result') || type.includes('output'));
}

/**
 * Opencode emits scaffolding parts around each turn that pi-agent does not
 * model as content blocks: turn boundary markers (`step-start`,
 * `step-finish`), workspace snapshots (`snapshot`), diff / patch views
 * (`patch`), summarisation markers (`compaction`) and file previews
 * (`file`). Filtering them here keeps `losses.unsupportedParts` bounded to
 * genuinely unrecognised part types instead of tripping every turn.
 */
export function isNonAssistantScaffoldingPart(type: string): boolean {
  return (
    type === 'step-start' ||
    type === 'step-finish' ||
    type === 'snapshot' ||
    type === 'patch' ||
    type === 'compaction' ||
    type === 'file'
  );
}

export function readNativeDataText(value: unknown, keys: string[]): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const child = record[key];
    if (typeof child === 'string' && child.length > 0) return child;
    if (typeof child === 'number' || typeof child === 'boolean') return String(child);
  }
  return undefined;
}

export function readNativeDataRecord(
  value: unknown,
  keys: string[],
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const child = record[key];
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      return child as Record<string, unknown>;
    }
  }
  return undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
