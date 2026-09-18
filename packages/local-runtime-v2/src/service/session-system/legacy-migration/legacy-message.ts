/**
 * Structural shape of settled display rows stored by the legacy daemon.
 *
 * This stays local to the importer: `AgentMessage` is an old transport
 * contract, while session-system owns persisted display records.
 */
export interface LegacyOpencodeDisplayMessage extends Record<string, unknown> {
  msg_id?: string;
  parent_msg_id?: string;
  timestamp?: number;
  msg_content?: string;
  msg_type?: number;
  role?: string;
  thinking_content?: string;
  thinking_duration_ms?: number;
  finish_reason?: string;
  tool_calls?: readonly Record<string, unknown>[];
  attachments?: readonly Record<string, unknown>[];
}

export const LEGACY_MESSAGE_ROLE = {
  user: 'user',
  assistant: 'assistant',
} as const;

export const LEGACY_MESSAGE_TYPE = {
  content: 1,
  toolCall: 2,
  systemEvent: 3,
} as const;
