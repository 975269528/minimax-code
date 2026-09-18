import type { ModelSelectionInput } from '@mavis/protocol/local';
import {
  normalizeModelSelection,
  type UserModelSelection,
} from '../../service/turn-system/index.js';
import { ApplicationError } from './errors.js';

// Every wire field must explicitly be a user choice or a server-owned budget.
const selectionFields = {
  providerId: true,
  modelId: true,
  variant: true,
  reasoning: true,
  thinking: true,
  contextLimit: true,
  contextWindow: false,
  maxOutputTokens: false,
} satisfies Record<keyof ModelSelectionInput, boolean>;

export function toUserModelSelection(input: ModelSelectionInput): UserModelSelection {
  const choices = Object.fromEntries(
    Object.entries(selectionFields)
      .filter(([, selected]) => selected)
      .map(([key]) => [key, input[key as keyof ModelSelectionInput] ?? undefined]),
  );
  try {
    return normalizeModelSelection(choices);
  } catch (error) {
    throw new ApplicationError(
      400,
      'invalid-model',
      error instanceof Error ? error.message : 'Invalid model selection',
    );
  }
}
