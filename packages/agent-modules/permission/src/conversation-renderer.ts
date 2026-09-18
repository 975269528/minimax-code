/**
 * Conversation-context renderer for the cloud gateway.
 *
 * The cloud endpoint `POST /mavis/api/v1/permission/check` expects a
 * pre-rendered text block in its `conversation_context` field; the rendering
 * algorithm must match what the server-side prompt expects byte-for-byte.
 *
 * Output shape:
 *
 *   <empty> if no messages
 *
 *   "\n\n## Recent User Instructions\n<msg1>\n---\n<msg2>\n\n## Recent Conversation\n[role] msg\n[role] msg"
 *
 *   - User messages: keep first and last 250 chars with "...[truncated]..."
 *     in the middle when length > 500
 *   - Other messages (assistant / system / tool): truncated to 200 chars
 *     with trailing "..."
 *   - Tool calls are flattened to "tool:<name> args=<truncated> result=<truncated>"
 *   - User msg_ids already shown in the "## Recent User Instructions"
 *     section are excluded from "## Recent Conversation"
 *
 * Section presence: each section appears only when its source list is
 * non-empty AND has at least one renderable entry. Leading "\n\n" is
 * preserved at the start of the whole block (the cloud prompt template puts
 * the action block first).
 */

import type { AgentMessageProtocol } from '@mavis/agent-core/protocol/agent-message';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRUNCATE_LIMIT = 200;
const USER_MSG_LIMIT = 500;
const USER_MSG_HALF = 250;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface RenderConversationContextInput {
  /**
   * Latest 3 user messages (excluding permission-response envelopes).
   * These render under "## Recent User Instructions".
   *
   * Caller responsibility:
   *   - Filter out permission-response messages BEFORE passing in.
   *     The legacy daemon does this in `MessageStorePort.getRecent`
   *     via `{ excludePermissionResponses: true }`.
   *   - Limit count (caller picks 3 to match legacy behavior).
   */
  latestUserMessages?: ReadonlyArray<AgentMessageProtocol>;

  /**
   * Latest N messages from the whole conversation (mixed roles).
   * Caller picks count (legacy picks 5). Render order is whatever the
   * input array gives; the renderer does not sort.
   */
  recentMessages?: ReadonlyArray<AgentMessageProtocol>;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Render the conversation-context text block.
 *
 * Pure function — no I/O. The MessageStore lookup happens in the caller so
 * this module is trivially testable without DB / fixtures.
 */
export function renderConversationContext(input: RenderConversationContextInput): string {
  const sections: string[] = [];
  const userMsgIds = new Set<string>();

  // Section 1: Recent User Instructions
  if (input.latestUserMessages && input.latestUserMessages.length > 0) {
    const userLines: string[] = [];
    for (const m of input.latestUserMessages) {
      if (!m.msg_content) continue;
      userMsgIds.add(m.msg_id);
      userLines.push(truncateUserMessage(m.msg_content));
    }
    if (userLines.length > 0) {
      sections.push(`## Recent User Instructions\n${userLines.join('\n---\n')}`);
    }
  }

  // Section 2: Recent Conversation (dedup against the user IDs above)
  if (input.recentMessages && input.recentMessages.length > 0) {
    const formatted = formatRecentMessages(input.recentMessages, userMsgIds);
    if (formatted) {
      sections.push(`## Recent Conversation\n${formatted}`);
    }
  }

  return sections.length > 0 ? `\n\n${sections.join('\n\n')}` : '';
}

// ---------------------------------------------------------------------------
// Helpers — verbatim from yolo-classifier
// ---------------------------------------------------------------------------

function truncateStr(s: string | undefined, limit = TRUNCATE_LIMIT): string {
  if (!s) return '';
  return s.length > limit ? `${s.slice(0, limit)}...` : s;
}

function truncateUserMessage(s: string): string {
  if (s.length <= USER_MSG_LIMIT) return s;
  return `${s.slice(0, USER_MSG_HALF)}\n...[truncated]...\n${s.slice(-USER_MSG_HALF)}`;
}

interface ToolCallLike {
  tool_name?: string;
  tool_call_args?: string;
  tool_call_result_data?: string;
}

function formatToolCall(tc: ToolCallLike): string {
  const args = truncateStr(tc.tool_call_args);
  const result = truncateStr(tc.tool_call_result_data);
  const parts = [`tool:${tc.tool_name ?? ''}`];
  if (args) parts.push(`args=${args}`);
  if (result) parts.push(`result=${result}`);
  return parts.join(' ');
}

function formatRecentMessages(
  messages: ReadonlyArray<AgentMessageProtocol>,
  excludeMsgIds: ReadonlySet<string>,
): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role ?? 'unknown';

    // Skip user messages already shown in user instructions section
    if (role === 'user' && excludeMsgIds.has(msg.msg_id)) continue;

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const toolSummary = msg.tool_calls.map(formatToolCall).join('; ');
      const contentPart = msg.msg_content ? `${truncateStr(msg.msg_content)} | ` : '';
      lines.push(`[${role}] ${contentPart}${toolSummary}`);
    } else if (msg.msg_content) {
      const content =
        role === 'user' ? truncateUserMessage(msg.msg_content) : truncateStr(msg.msg_content);
      lines.push(`[${role}] ${content}`);
    }
  }
  return lines.join('\n');
}
