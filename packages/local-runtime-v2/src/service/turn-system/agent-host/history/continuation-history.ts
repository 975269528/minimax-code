import {
  validateCanonicalHistoryMessages,
  validateCanonicalHistorySnapshot,
} from './canonical-history-validation.js';
import { isBackgroundTaskReadSettlement } from './background/task-read-settlement.js';
import type { CanonicalHistoryMessage, CanonicalHistorySnapshot } from './contracts.js';

export type CanonicalContinuationState = 'unavailable' | 'available' | 'waiting-for-user';

class TurnContinuationUnavailableError extends Error {
  override readonly name = 'TurnContinuationUnavailableError';

  constructor(readonly state: CanonicalContinuationState) {
    super(`Turn continuation is unavailable: ${state}.`);
  }
}

/** Derives product continuation state from canonical Pi history only. */
export function inspectContinuationHistory(
  messages: readonly unknown[],
): CanonicalContinuationState {
  validateCanonicalHistoryMessages(messages);
  const last = continuationTail(messages)?.message;
  if (!last || last.role === 'compactionSummary') return 'unavailable';
  if (last.role === 'toolResult' && isWaitingForUser(last)) return 'waiting-for-user';
  if (last.role !== 'assistant') return 'available';
  return last.stopReason === 'stop' ? 'unavailable' : 'available';
}

/**
 * Builds the transcript accepted by Pi `continue()`. A non-terminal assistant
 * tail is the interrupted LLM attempt itself, so it is retried in memory while
 * the durable canonical record remains available for audit and projection.
 */
export function continuationRunnerHistory(
  snapshot: CanonicalHistorySnapshot,
): CanonicalHistorySnapshot {
  validateCanonicalHistorySnapshot(snapshot);
  const state = inspectContinuationHistory(snapshot.messages);
  if (state !== 'available') throw new TurnContinuationUnavailableError(state);
  const tail = continuationTail(snapshot.messages);
  if (tail?.message.role !== 'assistant') return snapshot;
  return {
    ...snapshot,
    messages: snapshot.messages.filter((_, index) => index !== tail.index),
    ...(snapshot.identityVector
      ? { identityVector: snapshot.identityVector.filter((_, index) => index !== tail.index) }
      : {}),
  };
}

function continuationTail(
  messages: readonly CanonicalHistoryMessage[],
): { readonly index: number; readonly message: CanonicalHistoryMessage } | undefined {
  let index = messages.length - 1;
  while (index >= 0) {
    const message = messages[index];
    if (message && !isBackgroundTaskReadSettlement(message)) return { index, message };
    index -= 1;
  }
  return undefined;
}

function isWaitingForUser(message: {
  readonly role: 'toolResult';
  readonly toolName: string;
  readonly details?: unknown;
}): boolean {
  return (
    message.toolName === 'ask_user' ||
    (isRecord(message.details) && message.details.waiting_for_user === true)
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
