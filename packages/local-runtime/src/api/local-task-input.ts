import {
  hasConversationTaskModelSelection,
  normalizeConversationSessionTitle,
  type ConversationTaskModelSelection,
} from '@mavis/conversation-contract';
import type { LocalTaskToolInput } from '@mavis/agent-tools/desktop';

/** Shared Task boundary for foreground and background child creation. */
export function normalizeLocalTaskInput(input: LocalTaskToolInput): LocalTaskToolInput {
  if (Object.hasOwn(input, 'model_config_id')) {
    throw new Error('Task model_config_id is not supported. Use model and effort.');
  }
  const description = normalizeConversationSessionTitle(input.description);
  if (!description) {
    throw new Error('Task description must contain 1-50 Unicode characters after normalization.');
  }
  const model = normalizeTaskOverride(input.model, 'model');
  const effort = normalizeTaskOverride(input.effort, 'effort');
  return {
    ...input,
    description,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

export function taskModelSelectionFor(
  input: Pick<LocalTaskToolInput, 'model' | 'effort'>,
): ConversationTaskModelSelection | undefined {
  const selection: ConversationTaskModelSelection = {
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  };
  return hasConversationTaskModelSelection(selection) ? selection : undefined;
}

function normalizeTaskOverride(
  value: string | undefined,
  field: 'model' | 'effort',
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error(`Task ${field} must not be blank.`);
  return normalized;
}
