import {
  MsgType,
  RespDataType,
  Role,
  ToolCallStatus,
  type RespData,
  type ToolCall,
} from '@mavis/agent-core/protocol/agent-message';
import { parseMediaTags } from '@mavis/shared';
import type { ConversationCommittedMessage } from '@mavis/conversation-contract';

import { parseRespData } from '../api/http-helpers.js';
import type { LocalChannelMessageFilter } from './infra.js';
import {
  extractToolDetail,
  formatToolResultFallback,
  formatToolSummary,
  sanitizeChannelReplyText,
} from './message-format.js';
import type { LocalChannelCollectedResponse } from './runner.js';

/**
 * Default filter when none is supplied — equals legacy behavior (concise
 * `result` mode, no tool-call summary). Kept as a const so every "is this the
 * default?" check stays in sync with the omitted-filter contract.
 */
const DEFAULT_MESSAGE_FILTER: LocalChannelMessageFilter = {
  mode: 'result',
  includeToolSummary: false,
};

export interface LocalChannelResponseCollectionOptions {
  preserveAssistantTextAcrossToolCalls?: boolean;
}

/**
 * Collect the channel reply from a turn's SSE stream.
 *
 * Restores the §4.2 (tool-call summary) / §4.3 (result-mode concise + fallback)
 * / §4.4 (media-tag sanitization) / full-mode (inline thinking + 🔧 markers)
 * rendering that the MR-A SSE extraction left out. An omitted/undefined filter
 * reproduces the pre-§4.2 behavior — `result` mode, no tool summary — so every
 * legacy caller/test stays green.
 */
export function collectChannelResponseFromSse(
  raw: string,
  filter?: LocalChannelMessageFilter,
  options?: LocalChannelResponseCollectionOptions,
): LocalChannelCollectedResponse {
  const f = filter ?? DEFAULT_MESSAGE_FILTER;
  // Single body accumulator built in stream order (tool-call chunk → completed
  // text → thinking → chunk text). `result` mode keeps only the final text
  // segment after the last tool call; `full` mode keeps everything (inline
  // thinking + inline 🔧 markers) in arrival order.
  let body = '';
  // §4.3 `result`-mode concise behavior: once a tool-call CHUNK is seen, the
  // NEXT text segment resets the accumulator so intermediate narration before
  // the tool call is discarded. Only armed in `result` mode.
  let seenToolCall = false;
  const chunks: string[] = [];
  const chunkMsgIds = new Set<string>();
  // Separate dedup set for thinking: a final AgentMessage repeating a chunk's
  // thinking must not be appended twice.
  const thinkingMsgIds = new Set<string>();
  // §4.2: tool calls accumulated across the stream, keyed by tool_call_id
  // (last-write-wins so a START then FINISHED frame collapses to FINISHED).
  const toolCalls = new Map<string, ToolCall>();
  let finalMessages = 0;
  let error: string | undefined;

  for (const data of decodeSseData(raw)) {
    if (data === '[DONE]') continue;
    const parsed = safeJson(data);
    if (isErrorFrame(parsed)) {
      error = parsed.error;
      continue;
    }
    const resp = parseRespData(data);
    if (!resp || resp.type === RespDataType.Heartbeat) continue;

    const isChunk = resp.type === RespDataType.AgentMessageChunk;
    const next = collectTextFromResp(resp, chunkMsgIds);
    const aux = collectAuxFromResp(resp, thinkingMsgIds);
    if (next.finalMessage) finalMessages += 1;

    // 1. Tool calls — feed the Map from BOTH frame kinds. For a CHUNK frame
    //    additionally: full mode emits an inline marker for each non-finished
    //    tool, result mode arms the reset via `seenToolCall`.
    if (aux.toolCalls) {
      for (const tc of aux.toolCalls) {
        const prev = toolCalls.get(tc.tool_call_id);
        // Preserve args from an earlier frame when a later (FINISHED) frame
        // omits them.
        const mergedArgs = tc.tool_call_args || prev?.tool_call_args;
        toolCalls.set(tc.tool_call_id, { ...tc, tool_call_args: mergedArgs });
        if (isChunk && f.mode === 'full' && tc.tool_call_status !== ToolCallStatus.Finished) {
          const detail = extractToolDetail(tc.tool_name, mergedArgs);
          const label = detail ? `${tc.tool_name} → ${detail}` : tc.tool_name;
          body += `\n\n🔧 ${label}\n\n`;
        }
      }
      if (isChunk && f.mode === 'result') {
        seenToolCall = true;
      }
    }

    // 2. Completed-message text — consume one pending tool-call boundary;
    //    default result mode also clears the prior body before appending.
    if (next.finalText) {
      if (f.mode === 'result' && seenToolCall) {
        if (!options?.preserveAssistantTextAcrossToolCalls) body = '';
        seenToolCall = false;
      }
      body += next.finalText;
    }

    // 3 & 4. Thinking (full mode only) — appended INLINE in stream order.
    if (aux.thinking && f.mode === 'full') {
      body += aux.thinking;
    }

    // 5. Chunk text — still pushed to `chunks` exactly as before, then appended
    //    after the same boundary check.
    if (next.chunk) {
      chunks.push(next.chunk);
      if (f.mode === 'result' && seenToolCall) {
        if (!options?.preserveAssistantTextAcrossToolCalls) body = '';
        seenToolCall = false;
      }
      body += next.chunk;
    }
  }

  // §4.3 result-mode fallback: tools ran but the agent emitted no text — surface
  // the finished tool outputs so the reply isn't empty.
  if (f.mode === 'result' && body.trim() === '' && toolCalls.size > 0) {
    body = formatToolResultFallback(toolCalls);
  }

  // §4.4 O1: extract structured media refs from the assembled body, then run
  // `placeholderMediaTags` as a belt-and-suspenders safety net so no raw
  // `<media>` / `<deliver-assets>` XML leaks to the user. The local outbound
  // path goes straight to `sendText` without the electron-side `sanitizeForIM`,
  // so without this step the literal tags reach the user. Media extraction runs
  // on the AGENT body — NOT on the §4.2 tool-summary suffix appended below.
  // Collapse runaway blank lines from the full-mode inline 🔧 markers first.
  body = body.replace(/\n{3,}/g, '\n\n');
  const parsedBody = parseMediaTags(body);
  let sanitizedText = sanitizeChannelReplyText(parsedBody.text);

  // §4.2 tool-call summary: appended AFTER sanitization as a suffix so its
  // `---` / `🔧` markers aren't disturbed by the media pass.
  if (f.includeToolSummary && toolCalls.size > 0) {
    sanitizedText += `\n\n---\n${formatToolSummary(toolCalls)}`;
  }

  return {
    text: sanitizedText,
    chunks,
    finalMessages,
    ...(parsedBody.media.length > 0 ? { media: parsedBody.media } : {}),
    ...(error ? { error } : {}),
  };
}

/** Builds the same Channel reply projection from committed display-message DTOs. */
export function collectChannelResponseFromMessages(
  messages: readonly ConversationCommittedMessage[],
  filter?: LocalChannelMessageFilter,
  error?: string,
): LocalChannelCollectedResponse {
  const f = filter ?? DEFAULT_MESSAGE_FILTER;
  let body = '';
  let seenToolCall = false;
  let finalMessages = 0;
  const toolCalls = new Map<string, ToolCall>();

  messages.forEach((message) => {
    if (message.role === 'user' || message.role === 'system' || message.kind === 'compaction') {
      return;
    }
    finalMessages += 1;
    message.toolCalls?.forEach((toolCall) => {
      const previous = toolCalls.get(toolCall.tool_call_id);
      const mergedArgs = toolCall.tool_call_args || previous?.tool_call_args;
      toolCalls.set(toolCall.tool_call_id, { ...toolCall, tool_call_args: mergedArgs });
      if (f.mode === 'full' && toolCall.tool_call_status !== ToolCallStatus.Finished) {
        const detail = extractToolDetail(toolCall.tool_name, mergedArgs);
        const label = detail ? `${toolCall.tool_name} → ${detail}` : toolCall.tool_name;
        body += `\n\n🔧 ${label}\n\n`;
      }
    });
    if (message.toolCalls && message.toolCalls.length > 0 && f.mode === 'result') {
      seenToolCall = true;
    }
    if (message.text) {
      if (f.mode === 'result' && seenToolCall) {
        body = '';
        seenToolCall = false;
      }
      body += message.text;
    }
    if (message.thinking && f.mode === 'full') body += message.thinking;
  });

  if (f.mode === 'result' && body.trim() === '' && toolCalls.size > 0) {
    body = formatToolResultFallback(toolCalls);
  }
  body = body.replace(/\n{3,}/g, '\n\n');
  const parsedBody = parseMediaTags(body);
  let sanitizedText = sanitizeChannelReplyText(parsedBody.text);
  if (f.includeToolSummary && toolCalls.size > 0) {
    sanitizedText += `\n\n---\n${formatToolSummary(toolCalls)}`;
  }
  return {
    text: sanitizedText,
    chunks: [],
    finalMessages,
    ...(parsedBody.media.length > 0 ? { media: parsedBody.media } : {}),
    ...(error ? { error } : {}),
  };
}

function collectTextFromResp(
  resp: RespData,
  chunkMsgIds: Set<string>,
): { chunk?: string; finalText?: string; finalMessage: boolean } {
  if (resp.type === RespDataType.AgentMessageChunk && resp.agent_message_chunk) {
    const chunk = resp.agent_message_chunk.msg_content;
    if (resp.agent_message_chunk.msg_id) chunkMsgIds.add(resp.agent_message_chunk.msg_id);
    return { ...(chunk ? { chunk } : {}), finalMessage: false };
  }
  if (resp.type === RespDataType.AgentMessage && resp.agent_message) {
    const message = resp.agent_message;
    if (message.role === Role.User || message.msg_type === MsgType.SystemEvent) {
      return { finalMessage: false };
    }
    const duplicated = message.msg_id ? chunkMsgIds.has(message.msg_id) : false;
    return {
      ...(message.msg_content && !duplicated ? { finalText: message.msg_content } : {}),
      finalMessage: true,
    };
  }
  return { finalMessage: false };
}

/**
 * Sibling of `collectTextFromResp` that surfaces the §4.2/§4.3 inputs — tool
 * calls and thinking — from a single frame, leaving the text path untouched.
 * `thinkingMsgIds` dedups thinking the same way `chunkMsgIds` dedups text.
 * Compaction frames are skipped (their thinking is internal).
 */
function collectAuxFromResp(
  resp: RespData,
  thinkingMsgIds: Set<string>,
): { thinking?: string; toolCalls?: ToolCall[] } {
  if (resp.type === RespDataType.AgentMessageChunk && resp.agent_message_chunk) {
    const c = resp.agent_message_chunk;
    const out: { thinking?: string; toolCalls?: ToolCall[] } = {};
    if (c.tool_calls && c.tool_calls.length > 0) out.toolCalls = c.tool_calls;
    if (c.thinking_content && c.kind !== 'compaction') {
      if (c.msg_id) thinkingMsgIds.add(c.msg_id);
      out.thinking = c.thinking_content;
    }
    return out;
  }
  if (resp.type === RespDataType.AgentMessage && resp.agent_message) {
    const m = resp.agent_message;
    if (m.role === Role.User || m.msg_type === MsgType.SystemEvent) return {};
    const out: { thinking?: string; toolCalls?: ToolCall[] } = {};
    if (m.tool_calls && m.tool_calls.length > 0) out.toolCalls = m.tool_calls;
    const duplicated = m.msg_id ? thinkingMsgIds.has(m.msg_id) : false;
    if (m.thinking_content && m.kind !== 'compaction' && !duplicated) {
      out.thinking = m.thinking_content;
    }
    return out;
  }
  return {};
}

function decodeSseData(raw: string): string[] {
  const events = raw.split(/\n\n/u);
  return events.flatMap((event) => {
    const lines = event.split(/\r?\n/u);
    const dataLines = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /u, ''));
    return dataLines.length > 0 ? [dataLines.join('\n')] : [];
  });
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isErrorFrame(value: unknown): value is { type: 'error'; error: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'error' &&
    typeof (value as { error?: unknown }).error === 'string'
  );
}
