/**
 * Opencode-native part-level helpers used by
 * `convertNativeMessagesToPiHistory`. Split out to keep part mapping separate
 * from converter orchestration.
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
import type { LegacyOpenCodeNativePart } from '../repo/contract.js';
import type { LegacyPiHistoryMessage, NativePiHistoryLosses } from './native-conversion-types.js';

export function nativeToolResultMessage(
  part: LegacyOpenCodeNativePart,
  timestamp: number,
  losses: NativePiHistoryLosses,
  fallbackToolCallId = `legacy-tool-${timestamp}`,
): LegacyPiHistoryMessage | undefined {
  if (!isToolResultPart(part)) return undefined;
  const status = classifyToolStatus(part.status);
  const interrupted = status === 'interrupted';
  if (interrupted) losses.interruptedTools += 1;
  const text = nativeToolResultText(part, interrupted);
  return {
    role: 'toolResult' as const,
    toolCallId: nativeToolCallId(part, fallbackToolCallId),
    toolName: nativeToolName(part),
    content: [{ type: 'text', text }],
    timestamp: part.timestamp ?? timestamp,
    isError: status !== 'settled',
    ...(interrupted ? { status: 'interrupted' } : {}),
  };
}

function classifyToolStatus(status: string | undefined): 'interrupted' | 'error' | 'settled' {
  const normalized = status?.trim().toLowerCase() ?? '';
  if (INTERRUPTED_TOOL_STATUSES.has(normalized)) return 'interrupted';
  if (ERROR_TOOL_STATUSES.has(normalized)) return 'error';
  return 'settled';
}

function nativeToolResultText(part: LegacyOpenCodeNativePart, interrupted: boolean): string {
  if (interrupted) {
    return 'Legacy opencode tool execution was interrupted during migration and was not resumed.';
  }
  return (
    readNativeOutputText(part) ??
    part.text ??
    readNativeDataText(part.data, ['text', 'content', 'output', 'result', 'error']) ??
    safeJson(part.data ?? part.raw ?? {})
  );
}

function nativeToolCallId(part: LegacyOpenCodeNativePart, fallbackToolCallId: string): string {
  return part.toolCallId ?? part.id ?? fallbackToolCallId;
}

function nativeToolName(part: LegacyOpenCodeNativePart): string {
  return (
    part.toolName ??
    readNativeDataText(part.data, ['toolName', 'tool_name', 'name', 'tool']) ??
    'unknown'
  );
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
  const direct = outputFromState(part.state);
  if (direct) return direct;
  const stateFromData = readNativeDataRecord(part.data, ['state']);
  return outputFromState(stateFromData);
}

function outputFromState(state: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (!state) return undefined;
  const output = state['output'];
  if (typeof output === 'string' && output.length > 0) return output;
  const error = state['error'];
  return typeof error === 'string' && error.length > 0 ? error : undefined;
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
    // `buildAssistantContentBlocks`) stays paired — pi-agent + the Messages-compatible endpoint
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
  return NON_ASSISTANT_SCAFFOLDING_PARTS.has(type);
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

const INTERRUPTED_TOOL_STATUSES = new Set(['pending', 'running', 'active', 'streaming']);
const ERROR_TOOL_STATUSES = new Set(['error', 'failed']);
const NON_ASSISTANT_SCAFFOLDING_PARTS = new Set([
  'step-start',
  'step-finish',
  'snapshot',
  'patch',
  'compaction',
  'file',
]);
