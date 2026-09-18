import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  normalizeTodoItems,
  readCompactionCompatibility,
  TODO_CADENCE_INTERVAL,
  type CompactionTodoCadence,
  type CompactionTodoItem,
} from '../compat.js';
import { advanceAssistantIterationCadence } from './assistant-iteration-cadence.js';

export const TODO_CADENCE_REMINDER_CUSTOM_TYPE = 'todo_cadence_reminder';

export interface TodoHistoryProjection {
  readonly todoState?: readonly CompactionTodoItem[];
  readonly todoCadence?: CompactionTodoCadence;
}

/** Rebuilds Todo reminder state from the durable transcript. */
export function projectTodoHistory(messages: readonly AgentMessage[]): TodoHistoryProjection {
  const inherited = readCompactionCompatibility(messages[0]);
  let todoState = inherited?.todoState;
  let todoCadence: CompactionTodoCadence = inherited?.todoCadence ?? {
    assistantIterationsSinceTodoWrite: TODO_CADENCE_INTERVAL,
    assistantIterationsSinceReminder: TODO_CADENCE_INTERVAL,
  };
  const toolNames = new Map<string, string>();

  messages.forEach((message) => {
    if (message.role === 'assistant') {
      todoCadence = {
        assistantIterationsSinceTodoWrite: advanceAssistantIterationCadence(
          todoCadence.assistantIterationsSinceTodoWrite,
        ),
        assistantIterationsSinceReminder: advanceAssistantIterationCadence(
          todoCadence.assistantIterationsSinceReminder,
        ),
      };
      recordToolNames(message, toolNames);
    }

    const next = readSuccessfulTodo(message, toolNames);
    if (next !== undefined) {
      todoState = next;
      todoCadence = { ...todoCadence, assistantIterationsSinceTodoWrite: 0 };
    }
    if (isTodoCadenceReminder(message)) {
      todoCadence = { ...todoCadence, assistantIterationsSinceReminder: 0 };
    }
  });

  return todoState === undefined ? {} : { todoState, todoCadence };
}

function isTodoCadenceReminder(message: AgentMessage): boolean {
  const details = Reflect.get(message, 'details');
  return (
    message.role === 'custom' &&
    Reflect.get(message, 'customType') === TODO_CADENCE_REMINDER_CUSTOM_TYPE &&
    Reflect.get(message, 'display') === false &&
    details !== null &&
    typeof details === 'object' &&
    Reflect.get(details, 'version') === 1 &&
    Array.isArray(Reflect.get(details, 'todos'))
  );
}

function recordToolNames(message: AgentMessage, toolNames: Map<string, string>): void {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return;
  message.content.forEach((block) => {
    if (!block || block.type !== 'toolCall') return;
    if (block.id.trim() && block.name.trim()) toolNames.set(block.id, block.name.toLowerCase());
  });
}

function readSuccessfulTodo(
  message: AgentMessage,
  toolNames: ReadonlyMap<string, string>,
): readonly CompactionTodoItem[] | undefined {
  if (message.role !== 'toolResult' || message.isError) return undefined;
  const toolName = message.toolName?.toLowerCase() ?? toolNames.get(message.toolCallId);
  if (toolName !== 'todowrite') return undefined;
  const details = Reflect.get(message, 'details');
  if (
    !details ||
    typeof details !== 'object' ||
    Reflect.get(details, 'cancelled') === true ||
    Reflect.get(details, 'status') === 'cancelled'
  ) {
    return undefined;
  }
  return normalizeTodoItems(Reflect.get(details, 'todos'));
}
