/**
 * Pure outbound formatters for the IM channel reply — the §4.2 "Appended tool calls"
 * (tool-call summary) and §4.3 "Compact output" (result-mode fallback) logic.
 *
 * Ported from `main`'s
 * `packages/daemon/src/channel-bridge/plugin-runner-utils.ts` (the §4.2/§4.3
 * formatters only — `splitIntoChunks` is intentionally NOT ported). These are
 * pure functions with no daemon/runner state dependency.
 *
 * The ONLY adaptation vs main is the import source. main imports its `ToolCall`
 * type + `ToolCallStatus` enum from `../common/agent-protocol.js`; on this
 * branch the channel collector operates on `RespData` frames whose `tool_calls`
 * are typed as `ToolCall` from `@mavis/agent-core/protocol/agent-message`. That
 * shape is identical (same fields, same `ToolCallStatus.Finished` / `.Failed`
 * casing — `ToolCallStatus` is a const object `{ Start:1, Finished:2,
 * Failed:3 }` there), so the body is byte-for-byte.
 *
 * Kept in a separate file so `local-channel-runner.ts` stays under the
 * 2000-line source-file size cap.
 */
import { parseMediaTags, placeholderMediaTags } from '@mavis/shared';
import { ToolCallStatus, type ToolCall } from '@mavis/agent-core/protocol/agent-message';

const STRUCTURED_TAG_START_RE = /<(media|genui|deliver-assets)\b[^>]*(?:>|$)/giu;

/**
 * Format tool calls into a readable summary.
 *
 * Output:
 *   🔧 Tool calls
 *   - webfetch → boxofficecn.com ✓
 *   - read → src/index.ts ✓
 */
export function formatToolSummary(toolCalls: Map<string, ToolCall>): string {
  const lines: string[] = ['🔧 工具调用'];

  for (const tc of toolCalls.values()) {
    const icon =
      tc.tool_call_status === ToolCallStatus.Finished
        ? '✓'
        : tc.tool_call_status === ToolCallStatus.Failed
          ? '✗'
          : '…';
    const detail = extractToolDetail(tc.tool_name, tc.tool_call_args);
    const label = detail ? `${tc.tool_name} → ${detail}` : tc.tool_name;
    lines.push(`- ${label} ${icon}`);
  }

  return lines.join('\n');
}

/**
 * True when a tool call is an interactive-flow tool that delivers its UI
 * out-of-band and terminates the turn (e.g. `ask_user` questionnaire). Such a
 * tool's result is a control payload ("waiting for the user…", `terminate:true`)
 * — NOT user-facing content — so it must never be surfaced by the result-mode
 * fallback. The question/prompt is already delivered via the dedicated
 * card/text path; turn-1 should stay silent on IM for these tools.
 *
 * Detected by tool name (`ask_user`, primary/cheap) OR by parsing the result
 * payload for the `terminate` / `details.waiting_for_user` markers (safety net
 * for any future interactive tool). `ToolCall.tool_call_result_data` is a JSON
 * STRING, so the markers are read by parsing it; malformed/absent → not skipped.
 */
function isInteractiveTerminateTool(tc: ToolCall): boolean {
  if (tc.tool_name === 'ask_user') return true;
  const raw = tc.tool_call_result_data;
  if (!raw) return false;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (obj.terminate === true) return true;
    const details = obj.details as Record<string, unknown> | undefined;
    if (details && details.waiting_for_user === true) return true;
  } catch {
    // not JSON / not an interactive payload — fall through.
  }
  return false;
}

/**
 * Build result-mode fallback from finished tool outputs.
 * Used when no assistant text is emitted but tools returned data.
 */
export function formatToolResultFallback(toolCalls: Map<string, ToolCall>): string {
  const lines: string[] = [];
  for (const tc of toolCalls.values()) {
    if (isInteractiveTerminateTool(tc)) continue;
    if (tc.tool_call_status !== ToolCallStatus.Finished) continue;
    const raw = (tc.tool_call_result_data ?? '').trim();
    if (!raw) continue;
    const detail = extractToolDetail(tc.tool_name, tc.tool_call_args);
    const label = detail ? `${tc.tool_name} → ${detail}` : tc.tool_name;
    lines.push(`🔧 ${label}\n${sanitizeChannelReplyText(raw)}`);
  }
  return lines.join('\n\n').trim();
}

export function sanitizeChannelReplyText(text: string): string {
  const parsed = parseMediaTags(text);
  return stripRawStructuredTags(placeholderMediaTags(parsed.text)).trim();
}

function stripRawStructuredTags(text: string): string {
  let output = '';
  let cursor = 0;
  STRUCTURED_TAG_START_RE.lastIndex = 0;

  for (;;) {
    const match = STRUCTURED_TAG_START_RE.exec(text);
    if (!match) break;
    const tagName = match[1]?.toLowerCase();
    if (!tagName) break;
    output += text.slice(cursor, match.index);
    if (match[0].endsWith('/>')) {
      cursor = STRUCTURED_TAG_START_RE.lastIndex;
      continue;
    }
    const closeRe = new RegExp(`</${tagName}>`, 'iu');
    const rest = text.slice(STRUCTURED_TAG_START_RE.lastIndex);
    const close = closeRe.exec(rest);
    if (!close) {
      cursor = text.length;
      break;
    }
    cursor = STRUCTURED_TAG_START_RE.lastIndex + close.index + close[0].length;
    STRUCTURED_TAG_START_RE.lastIndex = cursor;
  }

  return output + text.slice(cursor);
}

/**
 * Extract a human-readable detail from tool call args JSON.
 * Returns hostname for URL tools, file path for file tools, etc.
 */
export function extractToolDetail(toolName: string, argsJson?: string): string {
  if (!argsJson) return '';

  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const name = toolName.toLowerCase();

    // URL-based tools: show hostname
    if (name.includes('fetch') || name.includes('web') || name.includes('browser')) {
      const url = (args.url ?? args.href ?? args.link) as string | undefined;
      if (url) {
        try {
          return new URL(url).hostname;
        } catch {
          return url.replace(/\n/g, ' ').trim();
        }
      }
    }

    // File-based tools
    if (
      name.includes('read') ||
      name.includes('edit') ||
      name.includes('write') ||
      name.includes('glob') ||
      name.includes('file')
    ) {
      const filePath = (args.file_path ?? args.path ?? args.filePath) as string | undefined;
      if (filePath) return filePath.replace(/\n/g, ' ').trim();
    }

    // Shell/command tools
    if (
      name.includes('bash') ||
      name.includes('shell') ||
      name.includes('exec') ||
      name.includes('command') ||
      name.includes('terminal')
    ) {
      const cmd = (args.command ?? args.cmd) as string | undefined;
      if (cmd) return cmd.replace(/\n/g, ' ').trim();
    }

    // Search tools
    if (name.includes('grep') || name.includes('search')) {
      const pattern = (args.pattern ?? args.query ?? args.search) as string | undefined;
      if (pattern) return pattern.replace(/\n/g, ' ').trim();
    }

    // Fallback: first short string value
    for (const val of Object.values(args)) {
      if (typeof val === 'string' && val.length > 0) {
        return val.replace(/\n/g, ' ').trim();
      }
    }
  } catch {
    // malformed JSON
  }

  return '';
}
