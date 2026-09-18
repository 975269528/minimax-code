import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { PiBeforeLlmCallReplaceMetadata, PiHistoryChangedHookInput } from './hooks.js';
import type { turnState } from './turn.js';

export interface turnHistory {
  replace(
    messages: AgentMessage[],
    previousMessages: AgentMessage[],
    metadata: PiBeforeLlmCallReplaceMetadata,
  ): Promise<void>;
  flushTail(): Promise<void>;
}

export function newHistory(turn: turnState, agent: Agent): turnHistory {
  // Cursor into agent.state.messages. Initial history belongs to the caller
  // and must not be re-sent through onHistoryChangedHook.
  let lastSnapshotLength = turn.initialMessages.length;
  let deliveryFailed = false;

  const notify = async (change: PiHistoryChangedHookInput): Promise<void> => {
    if (turn.hooks.onHistory.length === 0) return;
    for (const hook of turn.hooks.onHistory) {
      await hook(change);
    }
  };

  const deliver = async (change: PiHistoryChangedHookInput): Promise<boolean> => {
    if (deliveryFailed) return false;
    try {
      await notify(change);
      return true;
    } catch (err) {
      deliveryFailed = true;
      turn.metrics.tryRecordTerminalFailure({
        errorSource: 'history',
        errorKind: 'persistence',
      });
      try {
        const errors = flattenHistoryErrors(err);
        const loggedErrors = errors.slice(0, MAX_LOGGED_HISTORY_ERRORS);
        const loggedMessages = selectHistoryMessages(change.messages);
        const toolCalls = summarizeToolCalls(loggedMessages);
        turn.logger.error(
          {
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            reason: change.reason,
            message_count: change.messages.length,
            message_roles: loggedMessages.map(({ message }) => readMessageRole(message)),
            tool_names: loggedMessages.flatMap(({ message }) => readToolName(message)),
            history_cursor: lastSnapshotLength,
            agent_message_count: agent.state.messages.length,
            history_messages: loggedMessages.map(({ message, index }) =>
              summarizeHistoryMessage(message, index),
            ),
            sampled_tool_call_count: toolCalls.count,
            tool_calls: toolCalls.entries,
            ...(toolCalls.count > toolCalls.entries.length
              ? { truncated_tool_call_count: toolCalls.count - toolCalls.entries.length }
              : {}),
            tool_results: loggedMessages.flatMap(({ message }) => readToolResult(message)),
            ...(change.messages.length > loggedMessages.length
              ? { truncated_message_count: change.messages.length - loggedMessages.length }
              : {}),
            error_count: errors.length,
            errors: loggedErrors.map(summarizeHistoryError),
            ...(errors.length > loggedErrors.length
              ? { truncated_error_count: errors.length - loggedErrors.length }
              : {}),
            error: truncateHistoryText(describeHistoryError(err), MAX_HISTORY_ERROR_MESSAGE_LENGTH),
          },
          '[pi-turn-runner] history delivery failed',
        );
      } catch {
        // History persistence remains the root failure when diagnostics are unavailable.
      }
      throw err;
    }
  };

  return {
    async replace(messages, previousMessages, metadata): Promise<void> {
      const delivered = await deliver({
        sessionId: turn.input.sessionId,
        turnId: turn.input.turnId,
        reason: 'replaceMessages',
        messages: [...messages],
        previousMessages,
        metadata,
      });
      if (delivered) lastSnapshotLength = messages.length;
    },
    async flushTail(): Promise<void> {
      if (deliveryFailed) return;
      const total = agent.state.messages.length;
      if (total <= lastSnapshotLength) return;
      const delta = agent.state.messages.slice(lastSnapshotLength, total);
      const delivered = await deliver({
        sessionId: turn.input.sessionId,
        turnId: turn.input.turnId,
        reason: 'messageDelta',
        messages: [...delta],
      });
      if (delivered) lastSnapshotLength = total;
    },
  };
}

function readMessageRole(message: AgentMessage): string {
  return typeof message.role === 'string' && message.role.length > 0
    ? truncateHistoryText(message.role, MAX_HISTORY_ROLE_LENGTH)
    : 'unknown';
}

function readToolName(message: AgentMessage): string[] {
  return message.role === 'toolResult' && message.toolName.length > 0
    ? [truncateHistoryText(message.toolName, MAX_HISTORY_IDENTIFIER_LENGTH)]
    : [];
}

function summarizeHistoryMessage(
  message: AgentMessage,
  index: number,
): Readonly<Record<string, unknown>> {
  const content = Reflect.get(message, 'content');
  return {
    index,
    role: readMessageRole(message),
    content_types: readContentTypes(content),
    ...(Array.isArray(content) ? { content_part_count: content.length } : {}),
  };
}

const MAX_LOGGED_HISTORY_MESSAGES = 24;
const LOGGED_HISTORY_HEAD_MESSAGES = 4;
const MAX_LOGGED_HISTORY_TOOL_CALLS = 24;
const MAX_SCANNED_HISTORY_CONTENT_PARTS = 64;
const MAX_LOGGED_HISTORY_CONTENT_TYPES = 8;
const MAX_HISTORY_ROLE_LENGTH = 64;
const MAX_HISTORY_IDENTIFIER_LENGTH = 256;

function selectHistoryMessages(
  messages: readonly AgentMessage[],
): readonly { readonly message: AgentMessage; readonly index: number }[] {
  if (messages.length <= MAX_LOGGED_HISTORY_MESSAGES) {
    return messages.map((message, index) => ({ message, index }));
  }
  const head = messages
    .slice(0, LOGGED_HISTORY_HEAD_MESSAGES)
    .map((message, index) => ({ message, index }));
  const tailStart = messages.length - (MAX_LOGGED_HISTORY_MESSAGES - LOGGED_HISTORY_HEAD_MESSAGES);
  const tail = messages.slice(tailStart).map((message, offset) => ({
    message,
    index: tailStart + offset,
  }));
  return [...head, ...tail];
}

function readContentTypes(content: unknown): readonly string[] {
  if (typeof content === 'string') return ['text'];
  if (!Array.isArray(content)) return [];
  return [
    ...new Set(
      content.slice(0, MAX_SCANNED_HISTORY_CONTENT_PARTS).map((part) => {
        if (typeof part === 'string') return 'text';
        if (part && typeof part === 'object') {
          const type = Reflect.get(part, 'type');
          if (typeof type === 'string' && type.length > 0) {
            return truncateHistoryText(type, MAX_HISTORY_ROLE_LENGTH);
          }
        }
        return typeof part;
      }),
    ),
  ].slice(0, MAX_LOGGED_HISTORY_CONTENT_TYPES);
}

function summarizeToolCalls(messages: readonly { readonly message: AgentMessage }[]): {
  readonly count: number;
  readonly entries: readonly Readonly<Record<string, unknown>>[];
} {
  const summary: {
    count: number;
    entries: Readonly<Record<string, unknown>>[];
  } = { count: 0, entries: [] };
  messages.forEach(({ message }) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return;
    message.content.forEach((part) => {
      if (part.type !== 'toolCall') return;
      summary.count += 1;
      if (summary.entries.length >= MAX_LOGGED_HISTORY_TOOL_CALLS) return;
      summary.entries.push({
        tool_name: truncateHistoryText(part.name, MAX_HISTORY_IDENTIFIER_LENGTH),
        tool_call_id: truncateHistoryText(part.id, MAX_HISTORY_IDENTIFIER_LENGTH),
      });
    });
  });
  return summary;
}

function readToolResult(message: AgentMessage): readonly Readonly<Record<string, unknown>>[] {
  if (message.role !== 'toolResult') return [];
  return [
    {
      tool_name: truncateHistoryText(message.toolName, MAX_HISTORY_IDENTIFIER_LENGTH),
      tool_call_id: truncateHistoryText(message.toolCallId, MAX_HISTORY_IDENTIFIER_LENGTH),
      is_error: message.isError === true,
    },
  ];
}

const MAX_LOGGED_HISTORY_ERRORS = 4;
const MAX_HISTORY_ERROR_MESSAGE_LENGTH = 1_024;
const MAX_HISTORY_ERROR_STACK_LENGTH = 4_096;

function flattenHistoryErrors(error: unknown): readonly unknown[] {
  if (!(error instanceof AggregateError)) return [error];
  return error.errors.flatMap(flattenHistoryErrors);
}

function summarizeHistoryError(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: truncateHistoryText(
        error.message || 'Unknown error',
        MAX_HISTORY_ERROR_MESSAGE_LENGTH,
      ),
      ...(error.stack
        ? { stack: truncateHistoryText(error.stack, MAX_HISTORY_ERROR_STACK_LENGTH) }
        : {}),
    };
  }
  return {
    name: typeof error,
    message: truncateHistoryText(describeHistoryError(error), MAX_HISTORY_ERROR_MESSAGE_LENGTH),
  };
}

function truncateHistoryText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

function describeHistoryError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return 'unknown history delivery error';
  }
}
