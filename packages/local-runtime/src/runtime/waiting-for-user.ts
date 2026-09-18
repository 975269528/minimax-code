import { RespDataType, ToolCallStatus } from '@mavis/agent-core/protocol/agent-message';
import type { IRuntimeEvent } from '@mavis/protocol';

export function hasWaitingForUserToolResult(event: IRuntimeEvent): boolean {
  const raw = event.payload?.stream_resp;
  if (typeof raw !== 'string' || raw.length === 0) return false;
  try {
    const parsed = JSON.parse(raw) as {
      type?: unknown;
      agent_message?: { tool_calls?: unknown };
      agent_message_chunk?: { tool_calls?: unknown };
    };
    const toolCalls =
      parsed.type === RespDataType.AgentMessage
        ? parsed.agent_message?.tool_calls
        : parsed.type === RespDataType.AgentMessageChunk
          ? parsed.agent_message_chunk?.tool_calls
          : undefined;
    if (!Array.isArray(toolCalls)) return false;
    return toolCalls.some(isWaitingForUserToolCall);
  } catch {
    return false;
  }
}

function isWaitingForUserToolCall(toolCall: unknown): boolean {
  if (!toolCall || typeof toolCall !== 'object') return false;
  const record = toolCall as {
    tool_name?: unknown;
    tool_call_status?: unknown;
    tool_call_result_data?: unknown;
  };
  const toolName = typeof record.tool_name === 'string' ? record.tool_name : undefined;
  const isFinished = record.tool_call_status === ToolCallStatus.Finished;
  if (!isFinished) return false;

  const rawResult =
    typeof record.tool_call_result_data === 'string' ? record.tool_call_result_data : undefined;
  if (rawResult) {
    try {
      const result = JSON.parse(rawResult) as {
        terminate?: unknown;
        details?: { waiting_for_user?: unknown };
      };
      if (result.details?.waiting_for_user === true) return true;
      // Decision v3: a suppressed ask_user resolves inline and keeps the turn
      // running; an explicit false opts out of the ask_user fallback below.
      if (result.details?.waiting_for_user === false) return false;
      if (toolName === 'ask_user' && result.terminate === true) return true;
    } catch {
      // Fall through to the ask_user finished check below.
    }
  }

  // LocalAskUserTool always terminates after recording a pending questionnaire.
  // Keep this as a fallback for older result payloads that predate `details`.
  return toolName === 'ask_user';
}
